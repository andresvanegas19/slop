import { spawn } from "node:child_process";
import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BflError, generateBflImage, videoQuality, type VideoQuality } from "@/lib/bfl";
import { logInfo } from "@/lib/runtime-log";
import type { Storyboard, StoryboardOnScreenText, StoryboardScene } from "@/lib/storyboard";

const FRAME_RATE = 30;
const CROSSFADE_SECONDS = 0.3;
const OUTPUT_WIDTH = 1920;
const OUTPUT_HEIGHT = 1080;

export type StoryboardRenderResult = {
  videoPath: string;
  videoFilename: string;
  durationSeconds: number;
  imageFilenames: string[];
  narrationAvailable: boolean;
};

export class StoryboardRenderError extends Error {}

function seconds(milliseconds: number) {
  return milliseconds / 1000;
}

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => reject(new StoryboardRenderError(`${command} is unavailable: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new StoryboardRenderError(`${command} could not render the storyboard (${stderr.slice(-500) || "unknown error"}).`));
    });
  });
}

async function downloadImage(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new BflError("BFL result download failed.", response.status);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > 25 * 1024 * 1024) {
    throw new StoryboardRenderError("BFL returned an invalid image.");
  }
  return bytes;
}

export function imageSize(storyboard: Storyboard) {
  switch (storyboard.style.aspectRatio) {
    case "9:16":
      return { width: 720, height: 1280 };
    case "1:1":
      return { width: 1024, height: 1024 };
    default:
      return { width: 1280, height: 720 };
  }
}

function motionFilter(scene: StoryboardScene, frameCount: number) {
  switch (scene.motion.camera) {
    case "pan-left":
      return `zoompan=z='1.06':x='max(iw-iw/zoom-on*0.6,0)':y='(ih-ih/zoom)/2':d=${frameCount}:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:fps=${FRAME_RATE}`;
    case "pan-right":
      return `zoompan=z='1.06':x='min(on*0.6,iw-iw/zoom)':y='(ih-ih/zoom)/2':d=${frameCount}:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:fps=${FRAME_RATE}`;
    case "push-in":
      return `zoompan=z='min(zoom+0.0008,1.14)':d=${frameCount}:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:fps=${FRAME_RATE}`;
    case "pull-out":
      return `zoompan=z='if(eq(on,0),1.14,max(zoom-0.0008,1.0))':d=${frameCount}:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:fps=${FRAME_RATE}`;
    case "tilt-up":
      return `zoompan=z='1.06':x='(iw-iw/zoom)/2':y='max(ih-ih/zoom-on*0.6,0)':d=${frameCount}:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:fps=${FRAME_RATE}`;
    case "tilt-down":
      return `zoompan=z='1.06':x='(iw-iw/zoom)/2':y='min(on*0.6,ih-ih/zoom)':d=${frameCount}:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:fps=${FRAME_RATE}`;
    default:
      return `zoompan=z='1.0':d=${frameCount}:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:fps=${FRAME_RATE}`;
  }
}

function drawTextFilter(textFile: string, position: StoryboardOnScreenText["position"]) {
  const y = position === "top" ? "120" : position === "bottom" ? "h-th-120" : "(h-th)/2";
  return `drawtext=textfile='${textFile}':fontcolor=white:fontsize=54:box=1:boxcolor=black@0.55:boxborderw=24:x=(w-tw)/2:y=${y}`;
}

async function composeMacOsOverlay(
  framePath: string,
  outputPath: string,
  textPaths: string[],
  textDirectory: string,
) {
  const emptyText = path.join(textDirectory, "empty.txt");
  await writeFile(emptyText, "", { mode: 0o600 });
  const topText = textPaths[0] ?? emptyText;
  const bottomText = textPaths[1] ?? emptyText;
  await run("/usr/bin/swift", [
    path.join(process.cwd(), "src", "lib", "render-overlay.swift"),
    framePath,
    outputPath,
    topText,
    bottomText,
  ]);
}

async function renderSceneClip(
  framePath: string,
  outputPath: string,
  scene: StoryboardScene,
  clipDurationSeconds: number,
  textDirectory: string,
  index: number,
) {
  const frameCount = Math.max(1, Math.ceil(clipDurationSeconds * FRAME_RATE));
  const textFilters: string[] = [];
  const textPaths: string[] = [];
  for (const [textIndex, overlay] of scene.onScreenText.entries()) {
    const textPath = path.join(textDirectory, `${index}-${textIndex}.txt`);
    await writeFile(textPath, overlay.text, { mode: 0o600 });
    textPaths.push(textPath);
    textFilters.push(drawTextFilter(textPath.replace(/'/g, "\\'"), overlay.position));
  }
  const sourcePath = process.platform === "darwin"
    ? path.join(textDirectory, `${index}.composed.png`)
    : framePath;
  if (process.platform === "darwin") {
    await composeMacOsOverlay(framePath, sourcePath, textPaths, textDirectory);
  }
  const filters = [
    `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase`,
    `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}`,
    motionFilter(scene, frameCount),
    ...(process.platform === "darwin" ? [] : textFilters),
    "format=yuv420p",
  ].join(",");
  await run("ffmpeg", [
    "-y", "-loop", "1", "-i", sourcePath, "-frames:v", String(frameCount),
    "-vf", filters, "-r", String(FRAME_RATE), "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", outputPath,
  ]);
}

export async function sayAvailable() {
  try {
    await access("/usr/bin/say");
    return true;
  } catch {
    return false;
  }
}

export async function renderNarration(
  audioPath: string,
  scene: StoryboardScene,
  durationSeconds: number,
  sayIsAvailable: boolean,
) {
  if (!sayIsAvailable) {
    await run("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", durationSeconds.toFixed(3),
      "-c:a", "aac", audioPath,
    ]);
    return;
  }

  const sourcePath = `${audioPath}.aiff`;
  await run("/usr/bin/say", ["-o", sourcePath, "--", scene.narration]);
  await run("ffmpeg", [
    "-y", "-i", sourcePath, "-af", `apad=whole_dur=${durationSeconds.toFixed(3)}`,
    "-t", durationSeconds.toFixed(3), "-ar", "48000", "-ac", "2", "-c:a", "aac", audioPath,
  ]);
}

function hasCrossfade(storyboard: Storyboard, index: number) {
  if (index === storyboard.scenes.length - 1) return false;
  const current = storyboard.scenes[index];
  const next = storyboard.scenes[index + 1];
  return current.transition.type === "cross-dissolve"
    && next.timing.startMs === current.timing.startMs + current.timing.durationMs
    && current.timing.durationMs >= CROSSFADE_SECONDS * 1000
    && next.timing.durationMs >= CROSSFADE_SECONDS * 1000;
}

async function joinVideo(clips: string[], storyboard: Storyboard, output: string) {
  if (clips.length === 1) {
    await run("ffmpeg", ["-y", "-i", clips[0], "-c", "copy", output]);
    return;
  }

  const inputs = clips.flatMap((clip) => ["-i", clip]);
  let filter = "";
  let current = "[0:v]";
  let elapsed = seconds(storyboard.scenes[0].timing.durationMs);
  for (let index = 1; index < clips.length; index += 1) {
    const outputLabel = `[v${index}]`;
    if (hasCrossfade(storyboard, index - 1)) {
      const offset = elapsed;
      filter += `${current}[${index}:v]xfade=transition=fade:duration=${CROSSFADE_SECONDS}:offset=${offset.toFixed(3)}${outputLabel};`;
    } else {
      filter += `${current}[${index}:v]concat=n=2:v=1:a=0${outputLabel};`;
    }
    current = outputLabel;
    elapsed += seconds(storyboard.scenes[index].timing.durationMs);
  }
  await run("ffmpeg", [
    "-y", ...inputs, "-filter_complex", filter.slice(0, -1), "-map", current,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output,
  ]);
}

async function muxNarration(videoPath: string, audioFiles: string[], storyboard: Storyboard, output: string) {
  const inputs = [videoPath, ...audioFiles].flatMap((file) => ["-i", file]);
  const audioFilter = storyboard.scenes.map((scene, index) => {
    const delay = scene.timing.startMs;
    return `[${index + 1}:a]adelay=${delay}|${delay}[a${index}]`;
  }).join(";");
  const labels = storyboard.scenes.map((_, index) => `[a${index}]`).join("");
  const filter = `${audioFilter};${labels}amix=inputs=${audioFiles.length}:duration=longest:normalize=0,atrim=duration=${seconds(totalDurationMs(storyboard)).toFixed(3)}[audio]`;
  await run("ffmpeg", [
    "-y", ...inputs, "-filter_complex", filter, "-map", "0:v", "-map", "[audio]",
    "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", "-shortest", output,
  ]);
}

export function totalDurationMs(storyboard: Storyboard) {
  const finalScene = storyboard.scenes.at(-1);
  return finalScene ? finalScene.timing.startMs + finalScene.timing.durationMs : 0;
}

export type StoryboardRenderMode = "cinematic" | "still";

export type RenderStoryboardOptions = {
  /**
   * Per-scene existing image files (absolute paths). When an entry is set, that scene's image is copied
   * instead of being generated by BFL; `undefined` entries are generated as usual.
   */
  sceneImagePaths?: (string | undefined)[];
  /**
   * "cinematic" (default): every scene is a real FLUX 3 image-to-video shot (see cinematic-renderer.ts).
   * "still": the legacy still + zoompan + burned-in text renderer. Env STORYBOARD_RENDER_MODE overrides the default.
   */
  mode?: StoryboardRenderMode;
  /** FLUX 3 quality; default videoQuality("storyboard") (final), or videoQuality("edit") when re-rendering edited frames. */
  quality?: VideoQuality;
  /** The brief the storyboard was written from (cinematic shot writer context). */
  brief?: string;
  companyContext?: string;
  /** Cinematic only: "final" = small lower-third on the last scene, "none" = no on-screen text. */
  captions?: "final" | "none";
};

export function isStoryboardRenderMode(value: unknown): value is StoryboardRenderMode {
  return value === "cinematic" || value === "still";
}

const ILLUSTRATED_STYLE = /\b(?:illustration|illustrated|isometric|vector|flat design|cartoon|anime|infographic)\b/i;

export function storyboardRenderMode(storyboard: Storyboard, requested?: unknown): StoryboardRenderMode {
  const configured = process.env.STORYBOARD_RENDER_MODE?.trim().toLowerCase();
  const mode = isStoryboardRenderMode(requested) ? requested : isStoryboardRenderMode(configured) ? configured : "cinematic";
  if (mode === "cinematic" && ILLUSTRATED_STYLE.test(storyboard.style.visualPrompt)) {
    // House style is real, phone-filmed footage: an illustrated style block is ignored (the shot writer drops it).
    logInfo("storyboard_style_overridden", { storyboardId: storyboard.id, style: storyboard.style.visualPrompt.slice(0, 120) });
  }
  return mode;
}

export async function renderStoryboard(
  storyboard: Storyboard,
  runId: string,
  options: RenderStoryboardOptions = {},
): Promise<StoryboardRenderResult & { engine?: "cinematic" | "still"; sceneEngines?: string[]; quality?: VideoQuality }> {
  if (storyboardRenderMode(storyboard, options.mode) === "cinematic") {
    const { renderCinematicStoryboard } = await import("@/lib/cinematic-renderer");
    const quality = options.quality ?? videoQuality(options.sceneImagePaths?.some(Boolean) ? "edit" : "storyboard");
    return renderCinematicStoryboard(storyboard, runId, {
      quality,
      brief: options.brief,
      companyContext: options.companyContext,
      sceneImagePaths: options.sceneImagePaths,
      captions: options.captions,
    });
  }
  return renderStillStoryboard(storyboard, runId, options);
}

async function renderStillStoryboard(
  storyboard: Storyboard,
  runId: string,
  options: RenderStoryboardOptions,
): Promise<StoryboardRenderResult & { engine: "still" }> {
  const root = path.join(process.cwd(), "output");
  const frames = path.join(root, "frames");
  const videos = path.join(root, "videos");
  const audio = path.join(root, "audio");
  const text = path.join(root, "text", runId);
  await Promise.all([mkdir(frames, { recursive: true }), mkdir(videos, { recursive: true }), mkdir(audio, { recursive: true }), mkdir(text, { recursive: true })]);

  const size = imageSize(storyboard);
  const imageFilenames: string[] = [];
  const clips: string[] = [];
  const audioFiles: string[] = [];
  const sayIsAvailable = await sayAvailable();
  for (const [index, scene] of storyboard.scenes.entries()) {
    const frameFilename = `${runId}-${index + 1}.png`;
    const framePath = path.join(frames, frameFilename);
    const existingImage = options.sceneImagePaths?.[index];
    if (existingImage) {
      await copyFile(existingImage, framePath);
    } else {
      const imageUrl = await generateBflImage(scene.visualPrompt, size.width, size.height, undefined, storyboard.style.seed);
      await writeFile(framePath, await downloadImage(imageUrl), { mode: 0o600 });
    }
    imageFilenames.push(frameFilename);

    const clipDuration = seconds(scene.timing.durationMs) + (hasCrossfade(storyboard, index) ? CROSSFADE_SECONDS : 0);
    const clipPath = path.join(videos, `${runId}-${index + 1}.mp4`);
    await renderSceneClip(framePath, clipPath, scene, clipDuration, text, index);
    clips.push(clipPath);

    const audioPath = path.join(audio, `${runId}-${index + 1}.m4a`);
    await renderNarration(audioPath, scene, seconds(scene.timing.durationMs), sayIsAvailable);
    audioFiles.push(audioPath);
  }

  const silentVideo = path.join(videos, `${runId}.silent.mp4`);
  await joinVideo(clips, storyboard, silentVideo);
  const videoFilename = `${runId}.mp4`;
  const videoPath = path.join(videos, videoFilename);
  await muxNarration(silentVideo, audioFiles, storyboard, videoPath);
  return { videoPath, videoFilename, durationSeconds: seconds(totalDurationMs(storyboard)), imageFilenames, narrationAvailable: sayIsAvailable, engine: "still" };
}
