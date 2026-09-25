import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BflError, FLUX3_MIN_DURATION_SEC, generateBflVideo } from "@/lib/bfl";
import { CLIP_SECONDS, renderClipFromFrame } from "@/lib/clip";
import { logInfo } from "@/lib/runtime-log";
import { extractLastFrame, probeMedia, SEGMENT_FORMAT, SegmentError, videoDurationSeconds, videosDirectory } from "@/lib/segments";

/** How much of the end of the current video is sent to FLUX 3 v2v as context. */
const CONTEXT_SECONDS = 2;
const PREFIX_PSNR_DB = 35;

type ContinuationMode = "v2v" | "i2v";
// Which mode worked last in this server process; later calls go straight to it.
let workingMode: ContinuationMode | undefined;

export class ContinuationUnusableError extends Error {}

function run(command: string, args: string[], action: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => reject(new SegmentError(`${command} is unavailable (${error.message}).`)));
    child.on("close", (code) => code === 0 ? resolve(`${stdout}\n${stderr}`) : reject(new SegmentError(`${command} could not ${action}: ${stderr.trim().slice(-500) || `exit code ${code}`}`)));
  });
}

const { width, height, fps, sampleRate } = SEGMENT_FORMAT;
const NORMALIZE = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p`;

/** PSNR (dB) between frame `a` of video A and frame `b` of video B, both normalized to the project format. */
export async function framePsnr(videoA: string, a: number, videoB: string, b: number) {
  const output = await run("ffmpeg", [
    "-v", "info", "-i", videoA, "-i", videoB,
    "-lavfi", `[0:v]${NORMALIZE},trim=start_frame=${a}:end_frame=${a + 1},setpts=PTS-STARTPTS[x];[1:v]${NORMALIZE},trim=start_frame=${b}:end_frame=${b + 1},setpts=PTS-STARTPTS[y];[x][y]psnr`,
    "-frames:v", "1", "-f", "null", "-",
  ], "compare frames");
  const match = output.match(/average:(inf|[\d.]+)/);
  if (!match) return 0;
  return match[1] === "inf" ? 100 : Number(match[1]);
}

async function frameCount(video: string) {
  const output = await run("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", video], "count frames");
  return Number(output.trim().split(/\s+/)[0]) || 0;
}

/** The last `seconds` of a video as a small normalized MP4 (with its audio when present). */
async function extractTail(video: string, seconds: number, destination: string) {
  const info = await probeMedia(video);
  await run("ffmpeg", [
    "-y", "-sseof", `-${seconds.toFixed(3)}`, "-i", video,
    "-vf", NORMALIZE, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    ...(info.hasAudio ? ["-c:a", "aac", "-b:a", "128k", "-ar", String(sampleRate), "-ac", "2"] : ["-an"]),
    "-movflags", "+faststart", destination,
  ], "extract the end of the video");
}

async function download(url: string, destination: string) {
  const response = await fetch(url);
  if (!response.ok) throw new BflError(`BFL video download failed (HTTP ${response.status}).`, response.status);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new BflError("BFL returned an empty video.");
  await writeFile(destination, bytes, { mode: 0o600 });
}

function continuationPrompt(prompt: string) {
  return `${prompt.replace(/\s+$/, "")}\n\nContinue seamlessly from the final frames of the input clip: same subject, setting, lighting, camera, and style, with motion that flows naturally from where it ends. No cuts. No on-screen text.`;
}

function v2vRejected(error: unknown) {
  return error instanceof BflError && error.status !== undefined && error.status >= 400 && error.status < 500
    && ![401, 402, 429].includes(error.status)
    && /mode|start_video|v2v|video/i.test(error.message);
}

/**
 * FLUX 3 v2v: sends the last ~2s of `contextVideo`, then keeps only the NEW frames (the output may or may not repeat
 * the input) as an exactly-CLIP_SECONDS normalized segment with the generated audio (0.05s fade-in at the join).
 */
async function renderV2v(contextVideo: string, prompt: string) {
  await mkdir(videosDirectory(), { recursive: true });
  const id = randomUUID();
  const tail = path.join(videosDirectory(), `${id}.tail.mp4`);
  const source = path.join(videosDirectory(), `${id}.source.mp4`);
  const temporary = path.join(videosDirectory(), `${id}.tmp.mp4`);
  const filename = `${id}.mp4`;
  try {
    const contextLength = await videoDurationSeconds(contextVideo);
    await extractTail(contextVideo, Math.min(CONTEXT_SECONDS, contextLength), tail);
    const tailFrames = await frameCount(tail);
    const tailLength = await videoDurationSeconds(tail);
    const url = await generateBflVideo({ prompt: continuationPrompt(prompt), startVideo: (await readFile(tail)).toString("base64") });
    await download(url, source);

    const output = await probeMedia(source);
    if (!output.hasVideo) throw new ContinuationUnusableError("The v2v output has no video stream.");
    const outputLength = await videoDurationSeconds(source);
    // Does the output start with (a re-render of) the input clip? Compare first frames, and check the length.
    const firstPsnr = await framePsnr(tail, 0, source, 0);
    // Requested FLUX3_MIN_DURATION_SEC of new video; noticeably longer output suggests the input was prepended.
    const lengthSuggestsPrefix = outputLength >= FLUX3_MIN_DURATION_SEC + tailLength - 0.2;
    const includesPrefix = firstPsnr > PREFIX_PSNR_DB || (lengthSuggestsPrefix && firstPsnr > 25);
    const offsetFrames = includesPrefix ? tailFrames : 0;
    logInfo("v2v_output", {
      v2v_output_includes_prefix: includesPrefix,
      firstFramePsnr: Math.round(firstPsnr * 10) / 10,
      outputLength,
      tailLength,
      tailFrames,
    });
    const available = outputLength - offsetFrames / fps;
    if (available < CLIP_SECONDS - 0.05) {
      throw new ContinuationUnusableError(`The v2v output has only ${available.toFixed(2)}s of new content (need ${CLIP_SECONDS}s).`);
    }

    const offsetSec = (offsetFrames / fps).toFixed(4);
    const clipFrames = Math.round(CLIP_SECONDS * fps);
    await run("ffmpeg", [
      "-y", "-i", source,
      ...(output.hasAudio ? [] : ["-f", "lavfi", "-i", `anullsrc=r=${sampleRate}:cl=stereo`]),
      "-filter_complex", [
        `[0:v]${NORMALIZE},trim=start_frame=${offsetFrames}:end_frame=${offsetFrames + clipFrames},setpts=PTS-STARTPTS[v]`,
        output.hasAudio
          ? `[0:a]aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start=${offsetSec},asetpts=PTS-STARTPTS,apad,atrim=duration=${CLIP_SECONDS},afade=t=in:d=0.05[a]`
          : `[1:a]atrim=duration=${CLIP_SECONDS}[a]`,
      ].join(";"),
      "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(fps),
      "-c:a", "aac", "-b:a", "128k", "-ar", String(sampleRate), "-ac", "2", "-movflags", "+faststart", temporary,
    ], "cut the new part of the v2v output");
    await rename(temporary, path.join(videosDirectory(), filename));
    return { videoFilename: filename, includesPrefix };
  } finally {
    await Promise.all([tail, source, temporary].map((file) => rm(file, { force: true })));
  }
}

/**
 * Renders the next CLIP_SECONDS shot continuing `contextVideo`: FLUX 3 v2v from its last ~2s (continues the motion),
 * falling back to i2v from its last frame when v2v is rejected or unusable. The working mode is cached per process.
 */
export async function renderContinuationShot(contextVideo: string, prompt: string) {
  if (workingMode !== "i2v") {
    try {
      const result = await renderV2v(contextVideo, prompt);
      workingMode = "v2v";
      logInfo("continuation_mode", { mode: "v2v", includesPrefix: result.includesPrefix });
      return { videoFilename: result.videoFilename, durationSeconds: CLIP_SECONDS, mode: "v2v" as const, includesPrefix: result.includesPrefix };
    } catch (error) {
      if (!(v2vRejected(error) || error instanceof ContinuationUnusableError)) throw error;
      if (v2vRejected(error)) workingMode = "i2v";
      logInfo("continuation_v2v_fallback", { reason: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    }
  }
  const lastFrame = await extractLastFrame(contextVideo);
  const clip = await renderClipFromFrame(lastFrame, prompt);
  logInfo("continuation_mode", { mode: "i2v" });
  return { videoFilename: clip.videoFilename, durationSeconds: clip.durationSeconds, mode: "i2v" as const, includesPrefix: undefined };
}
