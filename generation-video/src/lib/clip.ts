import { randomInt, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BflError, generateBflImage, generateBflVideoDetailed, videoQuality, type VideoQuality } from "@/lib/bfl";
import { logInfo } from "@/lib/runtime-log";

/** FLUX 3 renders at least 5s; the first CLIP_SECONDS are kept so clips stay short. */
export const CLIP_SECONDS = 3;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const FRAME_RATE = 30;
const WIDTH = 1280;
const HEIGHT = 720;

function runFfmpeg(args: string[], action: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => reject(new Error(`ffmpeg is unavailable: ${error.message}`)));
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg could not ${action}: ${stderr.slice(-500) || "unknown error"}`)));
  });
}

function renderMotionClip(input: string, output: string) {
  return runFfmpeg([
    "-y", "-loop", "1", "-i", input, "-t", String(CLIP_SECONDS),
    "-vf", `zoompan=z='min(zoom+0.0012,1.12)':d=${CLIP_SECONDS * FRAME_RATE}:s=${WIDTH}x${HEIGHT},format=yuv420p`,
    "-r", String(FRAME_RATE), "-c:v", "libx264", "-movflags", "+faststart", output,
  ], "render the clip");
}

/** Keeps the first CLIP_SECONDS of a FLUX 3 MP4 (with its audio, if any) at 1280x720 / 30 fps. */
function trimVideoClip(input: string, output: string) {
  return runFfmpeg([
    "-y", "-i", input, "-t", String(CLIP_SECONDS),
    "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},fps=${FRAME_RATE},format=yuv420p`,
    "-c:v", "libx264", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output,
  ], "trim the clip");
}

function extractFirstFrame(video: string, output: string) {
  return runFfmpeg(["-y", "-i", video, "-frames:v", "1", output], "extract the key frame");
}

async function downloadBflVideo(url: string, destination: string) {
  const response = await fetch(url);
  if (!response.ok) throw new BflError(`BFL video download failed (HTTP ${response.status}).`, response.status);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new BflError("BFL returned an empty video.");
  if (bytes.byteLength > MAX_VIDEO_BYTES) throw new BflError("BFL returned a video larger than the 200 MB limit.");
  await writeFile(destination, bytes, { mode: 0o600 });
}

/** True when the key cannot use FLUX 3 video, so the still-image zoom fallback should be used. */
function videoModelUnavailable(error: unknown) {
  return error instanceof BflError && (error.status === 403 || error.status === 404);
}

function shortClipPrompt(prompt: string) {
  return `${prompt.replace(/\s+$/, "")}\n\nPacing: the action starts on the first frame and the key moment lands within the first ${CLIP_SECONDS} seconds. No on-screen text.`;
}

/**
 * Generates a FLUX 3 clip (i2v when `keyframe` is given, otherwise t2v) and trims it into output/videos (always
 * 1280x720 so segments concatenate). `quality` defaults to videoQuality("edit") (draft: fast edits/appends).
 */
async function renderFlux3Clip(prompt: string, keyframe?: string, quality: VideoQuality = videoQuality("edit")) {
  const videoDirectory = path.join(process.cwd(), "output", "videos");
  await mkdir(videoDirectory, { recursive: true });
  const id = randomUUID();
  const source = path.join(videoDirectory, `${id}.source.mp4`);
  const temporary = path.join(videoDirectory, `${id}.tmp.mp4`);
  const filename = `${id}.mp4`;
  const startedAt = Date.now();
  try {
    const result = await generateBflVideoDetailed({ prompt: shortClipPrompt(prompt), keyframes: keyframe ? [keyframe] : undefined, quality });
    await downloadBflVideo(result.url, source);
    logInfo("flux3_clip_quality", { requested: quality, bfl: `${result.resolution}/draft=${result.draft}` });
    await trimVideoClip(source, temporary);
    await rename(temporary, path.join(videoDirectory, filename));
  } finally {
    await rm(source, { force: true });
    await rm(temporary, { force: true });
  }
  logInfo("flux3_clip_rendered", { mode: keyframe ? "i2v" : "t2v", durationSeconds: CLIP_SECONDS, elapsedMs: Date.now() - startedAt });
  return filename;
}

export async function downloadBflImage(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new BflError(`BFL result download failed (HTTP ${response.status}).`, response.status);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new BflError("BFL returned an empty image.");
  return bytes;
}

export async function pngAsBase64(filePath: string) {
  return (await readFile(filePath)).toString("base64");
}

/**
 * Generates a frame via BFL (optionally conditioned on `inputImagePath`) and saves it to output/frames.
 * Returns the frame filename (served from /api/assets/<filename>) and the seed used.
 */
export async function generateFrameImage(prompt: string, options: {
  width?: number;
  height?: number;
  inputImagePath?: string;
  seed?: number;
  filename?: string;
} = {}) {
  const frameDirectory = path.join(process.cwd(), "output", "frames");
  await mkdir(frameDirectory, { recursive: true });
  // Fresh generations get a recorded random seed. Edits (with an input image) omit the seed unless given:
  // re-using the original seed with the reference image makes FLUX reproduce the reference and ignore the prompt.
  const seed = options.seed ?? (options.inputImagePath ? undefined : randomInt(0, 2 ** 31 - 1));
  const inputImage = options.inputImagePath ? await pngAsBase64(options.inputImagePath) : undefined;
  const url = await generateBflImage(prompt, options.width ?? WIDTH, options.height ?? HEIGHT, inputImage, seed);
  const filename = options.filename ?? `${randomUUID()}.png`;
  await writeFile(path.join(frameDirectory, filename), await downloadBflImage(url), { mode: 0o600 });
  return { filename, seed };
}

async function renderZoomClip(frameFilename: string) {
  const videoDirectory = path.join(process.cwd(), "output", "videos");
  await mkdir(videoDirectory, { recursive: true });
  const id = randomUUID();
  const filename = `${id}.mp4`;
  const temporary = path.join(videoDirectory, `${id}.tmp.mp4`);
  await renderMotionClip(path.join(process.cwd(), "output", "frames", frameFilename), temporary);
  await rename(temporary, path.join(videoDirectory, filename));
  return filename;
}

/**
 * Generates an exactly-CLIP_SECONDS clip from a prompt with FLUX 3 text-to-video (one BFL call),
 * then saves its first frame to output/frames as the project's editable key frame.
 */
export async function generateClipFromPrompt(prompt: string, options: { quality?: VideoQuality } = {}) {
  try {
    // The first generation of a quick clip is full quality by default (BFL_VIDEO_QUALITY_CLIP); edits stay draft.
    const videoFilename = await renderFlux3Clip(prompt, undefined, options.quality ?? videoQuality("clip"));
    const frameDirectory = path.join(process.cwd(), "output", "frames");
    await mkdir(frameDirectory, { recursive: true });
    const frameFilename = `${randomUUID()}.png`;
    await extractFirstFrame(path.join(process.cwd(), "output", "videos", videoFilename), path.join(frameDirectory, frameFilename));
    return { videoFilename, frameFilename, seed: undefined as number | undefined, durationSeconds: CLIP_SECONDS, engine: "flux-3-video" as const };
  } catch (error) {
    if (!videoModelUnavailable(error)) throw error;
    logInfo("flux3_video_unavailable_fallback", { status: (error as BflError).status });
    const frame = await generateFrameImage(prompt);
    return { videoFilename: await renderZoomClip(frame.filename), frameFilename: frame.filename, seed: frame.seed as number | undefined, durationSeconds: CLIP_SECONDS, engine: "zoom" as const };
  }
}

/** Renders an exactly-CLIP_SECONDS clip that opens on a frame in output/frames (FLUX 3 image-to-video). */
export async function renderClipFromFrame(frameFilename: string, prompt: string) {
  try {
    const keyframe = await pngAsBase64(path.join(process.cwd(), "output", "frames", frameFilename));
    return { videoFilename: await renderFlux3Clip(prompt, keyframe), durationSeconds: CLIP_SECONDS };
  } catch (error) {
    if (!videoModelUnavailable(error)) throw error;
    logInfo("flux3_video_unavailable_fallback", { status: (error as BflError).status });
    return { videoFilename: await renderZoomClip(frameFilename), durationSeconds: CLIP_SECONDS };
  }
}
