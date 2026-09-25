import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BflError, FLUX3_MAX_DURATION_SEC, FLUX3_MIN_DURATION_SEC, generateBflVideoDetailed, type Flux3Keyframe, type VideoQuality } from "@/lib/bfl";
import { writeCinematicPlan, type CinematicPlan, type CinematicSceneInput } from "@/lib/cinematic-prompts";
import { generateFrameImage } from "@/lib/clip";
import { ClientAbortedError, currentEmitter, emitEvent, emitStage, progressSignal, withProgress, type Emit } from "@/lib/progress";
import { frameImageUrl } from "@/lib/projects";
import { logException, logInfo } from "@/lib/runtime-log";
import type { Storyboard, StoryboardScene } from "@/lib/storyboard";
import { renderNarration, sayAvailable, totalDurationMs, type StoryboardRenderResult } from "@/lib/storyboard-renderer";

/**
 * Cinematic storyboard renderer: every scene becomes a real moving shot instead of a still + zoompan slide.
 *   shot prompt (cinematic-prompts) → FLUX keyframe still → FLUX 3 image-to-video from that keyframe → trim.
 * Scenes render in parallel; shots are joined with short crossfades (exact total duration), the generated ambient
 * audio sits at -18 dB under the narration, and only the final scene gets a small lower-third caption.
 * Any scene whose video generation fails falls back to the still + slow zoom for that scene only.
 */

const FRAME_RATE = 30;
const SAMPLE_RATE = 48_000;
const DEFAULT_CROSSFADE_SECONDS = 0.4;
const DEFAULT_CONCURRENCY = 3;
const AMBIENT_UNDER_NARRATION_DB = -18;
const AMBIENT_ONLY_DB = -6;
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
type Aspect = Storyboard["style"]["aspectRatio"];
type Size = { width: number; height: number };
/** Final output size per aspect (16:9 → 1920x1080, 9:16 → 1080x1920 phone video, 1:1 → 1440x1440). */
export const OUTPUT_SIZE: Record<Aspect, Size> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1440, height: 1440 },
};
/** Keyframe sizes match FLUX 3's delivered frames (multiples of 32: fhd for final, hd for draft); output is then cropped. */
export const KEYFRAME_SIZE: Record<Aspect, Record<VideoQuality, Size>> = {
  "16:9": { final: { width: 1920, height: 1088 }, draft: { width: 1280, height: 704 } },
  "9:16": { final: { width: 1088, height: 1920 }, draft: { width: 704, height: 1280 } },
  "1:1": { final: { width: 1440, height: 1440 }, draft: { width: 960, height: 960 } },
};

export class CinematicRenderError extends Error {}

export type CinematicRenderOptions = {
  quality: VideoQuality;
  /** Brief/prompt the storyboard was written from (defaults to its headline). */
  brief?: string;
  companyContext?: string;
  /** Existing keyframe images per scene (e.g. after a frame edit); unset entries are generated. */
  sceneImagePaths?: (string | undefined)[];
  /** "final" (default): a small lower-third on the last scene only; "none": no on-screen text at all. */
  captions?: "final" | "none";
  /** Parallel scene videos (default CINEMATIC_CONCURRENCY or 3). */
  concurrency?: number;
};

type SceneEngine = "i2v" | "i2v-cached" | "still-fallback";

type SceneOutcome = {
  clipPath: string;
  keyframeFilename: string;
  engine: SceneEngine;
  keyframeMs: number;
  videoMs: number;
  requestedSeconds?: number;
  deliveredResolution?: string;
  bflQuality?: string;
  endPinned: boolean;
  error?: string;
};

export type CinematicRenderResult = StoryboardRenderResult & {
  engine: "cinematic";
  quality: VideoQuality;
  sceneEngines: SceneEngine[];
  plan: CinematicPlan;
  callCounts: { images: number; videos: number; llmPlan: 1 };
  elapsedMs: number;
};

// ---------- small utilities ----------

function run(command: string, args: string[], action: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => reject(new CinematicRenderError(`${command} is unavailable: ${error.message}`)));
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new CinematicRenderError(`${command} could not ${action} (${stderr.trim().slice(-600) || `exit code ${code}`}).`)));
  });
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function limited<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

function configuredConcurrency(requested?: number) {
  const value = requested ?? Number(process.env.CINEMATIC_CONCURRENCY);
  return Number.isFinite(value) && value >= 1 ? Math.min(8, Math.floor(value)) : DEFAULT_CONCURRENCY;
}

function configuredCrossfade() {
  const value = Number(process.env.CINEMATIC_CROSSFADE_SECONDS);
  return Number.isFinite(value) && value >= 0.1 && value <= 1 ? value : DEFAULT_CROSSFADE_SECONDS;
}

async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function probe(file: string) {
  const output = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], "read the generated video");
  const parsed = JSON.parse(output) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number }[] };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  return {
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    duration: Number(parsed.format?.duration) || 0,
    hasAudio: Boolean(parsed.streams?.some((stream) => stream.codec_type === "audio")),
  };
}

async function download(url: string, destination: string) {
  const response = await fetch(url);
  if (!response.ok) throw new BflError(`BFL video download failed (HTTP ${response.status}).`, response.status);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new BflError("BFL returned an empty video.");
  if (bytes.byteLength > MAX_VIDEO_BYTES) throw new BflError("BFL returned a video larger than the size limit.");
  await writeFile(destination, bytes, { mode: 0o600 });
}

export function normalizeVideoFilter(size: Size) {
  return `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${size.width}:${size.height},setsar=1,fps=${FRAME_RATE},format=yuv420p`;
}

/** Trims a FLUX 3 MP4 to exactly `seconds`, normalized to `size` / 30 fps with a 48 kHz stereo track (silence if none). */
export async function normalizeGeneratedClip(source: string, output: string, seconds: number, hasAudio: boolean, size: Size) {
  const frames = Math.round(seconds * FRAME_RATE);
  await run("ffmpeg", [
    "-y", "-i", source,
    ...(hasAudio ? [] : ["-f", "lavfi", "-i", `anullsrc=r=${SAMPLE_RATE}:cl=stereo`]),
    "-filter_complex", [
      `[0:v]${normalizeVideoFilter(size)},trim=end_frame=${frames},setpts=PTS-STARTPTS[v]`,
      hasAudio
        ? `[0:a]aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${seconds.toFixed(3)},asetpts=PTS-STARTPTS[a]`
        : `[1:a]atrim=duration=${seconds.toFixed(3)}[a]`,
    ].join(";"),
    "-map", "[v]", "-map", "[a]", "-frames:v", String(frames),
    "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(FRAME_RATE),
    "-c:a", "aac", "-b:a", "192k", "-ar", String(SAMPLE_RATE), "-ac", "2", "-movflags", "+faststart", output,
  ], "normalize the generated shot");
}

/** Old-style fallback for one scene: the keyframe with a slow push-in, silent track, exactly `seconds` long. */
async function renderStillFallback(keyframePath: string, output: string, seconds: number, index: number, size: Size) {
  const frames = Math.max(1, Math.round(seconds * FRAME_RATE));
  const zoom = index % 2 === 0 ? "min(zoom+0.0006,1.10)" : "if(eq(on,0),1.10,max(zoom-0.0006,1.0))";
  await run("ffmpeg", [
    "-y", "-loop", "1", "-i", keyframePath, "-f", "lavfi", "-i", `anullsrc=r=${SAMPLE_RATE}:cl=stereo`,
    "-filter_complex", `[0:v]scale=${size.width * 2}:${size.height * 2}:force_original_aspect_ratio=increase,crop=${size.width * 2}:${size.height * 2},zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${size.width}x${size.height}:fps=${FRAME_RATE},format=yuv420p[v];[1:a]atrim=duration=${seconds.toFixed(3)}[a]`,
    "-map", "[v]", "-map", "[a]", "-frames:v", String(frames),
    "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(FRAME_RATE),
    "-c:a", "aac", "-b:a", "192k", "-ar", String(SAMPLE_RATE), "-ac", "2", "-movflags", "+faststart", output,
  ], "render the still fallback");
}

// ---------- scene inputs ----------

function sceneHeadline(scene: StoryboardScene) {
  return scene.onScreenText.find((text) => text.position === "top")?.text ?? scene.onScreenText.find((text) => text.position === "center")?.text;
}

/** The scene's own visual idea: the storyboard's style prefix and "NO text" boilerplate removed. */
function sceneVisual(storyboard: Storyboard, scene: StoryboardScene) {
  let visual = scene.visualPrompt.trim();
  const prefix = storyboard.style.visualPrompt.trim();
  if (prefix && visual.startsWith(prefix)) visual = visual.slice(prefix.length);
  return visual
    .replace(/\bNO\s+(?:text|letters|numbers|logos)[,.]?/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[,.\s]+/, "")
    .trim() || scene.visualPrompt;
}

/** Two adjacent scenes are one continuous shot only when the storyboard says so in the motion description. */
function continuesIntoNext(storyboard: Storyboard, index: number) {
  const scene = storyboard.scenes[index];
  const next = storyboard.scenes[index + 1];
  return Boolean(next) && /\b(?:continuous|one take|same shot|continues into)\b/i.test(scene.motion.description);
}

function clipSeconds(storyboard: Storyboard, index: number, crossfade: number) {
  const base = storyboard.scenes[index].timing.durationMs / 1000;
  return index < storyboard.scenes.length - 1 ? base + crossfade : base;
}

// ---------- progress ----------

type SceneState = { phase: string; startedAt: number; progress?: number; done?: boolean };

function progressReporter(count: number) {
  const parent = currentEmitter();
  const states: SceneState[] = Array.from({ length: count }, () => ({ phase: "waiting", startedAt: Date.now() }));
  const startedAt = Date.now();
  const label = () => states
    .map((state, index) => `Scene ${index + 1}/${count} · ${state.phase}${state.done ? "" : ` · ${Math.round((Date.now() - state.startedAt) / 1000)}s`}`)
    .join("  |  ");
  const tick = () => {
    if (!parent) return;
    parent({ type: "stage", stage: "video", label: label() });
    const values = states.map((state) => state.done ? 1 : state.progress ?? 0);
    parent({ type: "progress", stage: "video", status: `${states.filter((state) => state.done).length}/${count} scenes`, progress: values.reduce((a, b) => a + b, 0) / count, elapsedMs: Date.now() - startedAt });
  };
  const timer = parent ? setInterval(tick, 2_000) : undefined;
  return {
    set(index: number, phase: string, options: { done?: boolean } = {}) {
      states[index] = { phase, startedAt: Date.now(), done: options.done };
      logInfo("cinematic_scene_phase", { scene: index + 1, of: count, phase });
      tick();
    },
    /** Runs `task` with a private progress sink so BFL polling of parallel jobs doesn't interleave on the stream. */
    scoped<T>(index: number, task: () => Promise<T>): Promise<T> {
      if (!parent) return task();
      const sink: Emit = (event) => {
        if (event.type === "progress") {
          if (typeof event.progress === "number") states[index].progress = event.progress;
          return;
        }
        if (event.type === "stage") return;
        parent(event);
      };
      return withProgress(sink, progressSignal(), task);
    },
    stop() {
      if (timer) clearInterval(timer);
      tick();
    },
  };
}

// ---------- final assembly ----------

async function renderCaption(storyboard: Storyboard, directory: string, size: Size) {
  const scene = storyboard.scenes.at(-1);
  if (!scene || process.platform !== "darwin") return undefined;
  const title = sceneHeadline(scene) ?? "";
  const subtitle = scene.onScreenText.find((text) => text.position === "bottom")?.text ?? "";
  if (!title && !subtitle) return undefined;
  const titlePath = path.join(directory, "caption-title.txt");
  const subtitlePath = path.join(directory, "caption-sub.txt");
  const output = path.join(directory, "caption.png");
  await writeFile(titlePath, title, { mode: 0o600 });
  await writeFile(subtitlePath, subtitle, { mode: 0o600 });
  try {
    await run("/usr/bin/swift", [path.join(process.cwd(), "src", "lib", "render-caption.swift"), output, titlePath, subtitlePath, String(size.width), String(size.height)], "render the caption");
    return output;
  } catch (error) {
    logException("cinematic_caption_failed", error);
    return undefined;
  }
}

async function composeFinal(input: {
  storyboard: Storyboard;
  clips: string[];
  narration: string[];
  narrationAvailable: boolean;
  caption?: string;
  crossfade: number;
  output: string;
}) {
  const { storyboard, clips, narration, crossfade } = input;
  const count = clips.length;
  const total = totalDurationMs(storyboard) / 1000;
  const totalFrames = Math.round(total * FRAME_RATE);
  const args = ["-y", ...clips.flatMap((clip) => ["-i", clip]), ...narration.flatMap((file) => ["-i", file])];
  const captionInput = input.caption ? count * 2 : -1;
  if (input.caption) args.push("-loop", "1", "-t", total.toFixed(3), "-i", input.caption);

  const filters: string[] = [];
  // Video: crossfade chain. Clip i (except the last) carries `crossfade` extra seconds that overlap the next scene,
  // so offsets land exactly on each scene's start time and the total stays exact.
  for (let index = 0; index < count; index += 1) filters.push(`[${index}:v]settb=AVTB,fps=${FRAME_RATE},format=yuv420p[v${index}]`);
  let current = "[v0]";
  for (let index = 1; index < count; index += 1) {
    const offset = input.storyboard.scenes[index].timing.startMs / 1000;
    filters.push(`${current}[v${index}]xfade=transition=fade:duration=${crossfade.toFixed(3)}:offset=${offset.toFixed(3)}[x${index}]`);
    current = `[x${index}]`;
  }
  const fadeOutStart = Math.max(0, total - 0.5);
  filters.push(`${current}fade=t=in:st=0:d=0.25,fade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.5[vbase]`);
  let videoOut = "[vbase]";
  if (input.caption) {
    const last = storyboard.scenes[count - 1];
    const show = last.timing.startMs / 1000 + 0.35;
    const hide = Math.max(show + 0.5, total - 0.35);
    filters.push(`[${captionInput}:v]format=rgba,fade=t=in:st=${show.toFixed(3)}:d=0.6:alpha=1,fade=t=out:st=${hide.toFixed(3)}:d=0.3:alpha=1[cap]`);
    filters.push(`[vbase][cap]overlay=0:0:format=auto:shortest=0,format=yuv420p[vcap]`);
    videoOut = "[vcap]";
  }

  // Ambient: each shot's generated audio at its scene start, faded at the joins, mixed low.
  const ambientLabels: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = storyboard.scenes[index].timing.startMs;
    const length = storyboard.scenes[index].timing.durationMs / 1000 + (index < count - 1 ? crossfade : 0);
    const fades = [
      index > 0 ? `afade=t=in:st=0:d=${crossfade.toFixed(3)}` : undefined,
      index < count - 1 ? `afade=t=out:st=${(length - crossfade).toFixed(3)}:d=${crossfade.toFixed(3)}` : undefined,
    ].filter(Boolean).join(",");
    filters.push(`[${index}:a]aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${length.toFixed(3)}${fades ? `,${fades}` : ""},adelay=${start}|${start}[am${index}]`);
    ambientLabels.push(`[am${index}]`);
  }
  const ambientDb = input.narrationAvailable ? AMBIENT_UNDER_NARRATION_DB : AMBIENT_ONLY_DB;
  filters.push(`${ambientLabels.join("")}amix=inputs=${count}:duration=longest:normalize=0,volume=${ambientDb}dB[amb]`);
  // Narration at normal level, each line at its scene start.
  const narrationLabels: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = storyboard.scenes[index].timing.startMs;
    filters.push(`[${count + index}:a]aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${start}|${start}[na${index}]`);
    narrationLabels.push(`[na${index}]`);
  }
  filters.push(`${narrationLabels.join("")}amix=inputs=${count}:duration=longest:normalize=0[nar]`);
  filters.push(`[amb][nar]amix=inputs=2:duration=longest:normalize=0,apad,atrim=duration=${total.toFixed(3)},afade=t=in:st=0:d=0.3,afade=t=out:st=${Math.max(0, total - 0.8).toFixed(3)}:d=0.8,alimiter=limit=0.95[aout]`);

  await run("ffmpeg", [
    ...args,
    "-filter_complex", filters.join(";"),
    "-map", videoOut, "-map", "[aout]",
    "-frames:v", String(totalFrames), "-t", total.toFixed(3),
    "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FRAME_RATE),
    "-c:a", "aac", "-b:a", "192k", "-ar", String(SAMPLE_RATE), "-ac", "2", "-movflags", "+faststart", input.output,
  ], "assemble the cinematic video");
}

// ---------- main ----------

export async function renderCinematicStoryboard(storyboard: Storyboard, runId: string, options: CinematicRenderOptions): Promise<CinematicRenderResult> {
  const startedAt = Date.now();
  const root = path.join(process.cwd(), "output");
  const frames = path.join(root, "frames");
  const videos = path.join(root, "videos");
  const audio = path.join(root, "audio");
  const work = path.join(root, "cinematic", runId);
  const cache = path.join(root, "cinematic-cache");
  await Promise.all([frames, videos, audio, work, cache].map((directory) => mkdir(directory, { recursive: true })));

  const count = storyboard.scenes.length;
  const crossfade = Math.min(configuredCrossfade(), ...storyboard.scenes.map((scene) => scene.timing.durationMs / 1000 / 2));
  const quality = options.quality;
  const aspect = storyboard.style.aspectRatio;
  const size = KEYFRAME_SIZE[aspect][quality];
  const outputSize = OUTPUT_SIZE[aspect];
  const captions = options.captions ?? (process.env.CINEMATIC_CAPTIONS?.trim() === "none" ? "none" : "final");

  // 1. Shot prompts (one LLM plan: continuity bible + keyframe/motion per scene).
  emitStage("prompt", "Writing cinematic shot prompts…");
  const sceneInputs: CinematicSceneInput[] = storyboard.scenes.map((scene) => ({
    durationSec: scene.timing.durationMs / 1000,
    narration: scene.narration,
    headline: sceneHeadline(scene),
    visual: sceneVisual(storyboard, scene),
  }));
  const plan = await writeCinematicPlan({ brief: options.brief ?? storyboard.headline, scenes: sceneInputs, companyContext: options.companyContext });
  logInfo("cinematic_render_plan", { runId, scenes: count, source: plan.source, quality, bible: plan.bibleText.slice(0, 300) });

  // Narration renders alongside the shots.
  const sayIsAvailable = await sayAvailable();
  const narrationFiles = storyboard.scenes.map((_, index) => path.join(audio, `${runId}-${index + 1}.m4a`));
  const narrationTask = Promise.all(storyboard.scenes.map((scene, index) => renderNarration(narrationFiles[index], scene, scene.timing.durationMs / 1000, sayIsAvailable)));
  narrationTask.catch(() => undefined);

  // 2 + 3. Keyframes then image-to-video, per scene, in parallel.
  emitStage("video", `Rendering ${count} cinematic shots (${quality})…`);
  const reporter = progressReporter(count);
  const imageLimit = createLimiter(configuredConcurrency(options.concurrency));
  const videoLimit = createLimiter(configuredConcurrency(options.concurrency));
  let imageCalls = 0;
  let videoCalls = 0;

  const keyframes = storyboard.scenes.map((_, index) => imageLimit(() => reporter.scoped(index, async () => {
    const began = Date.now();
    const filename = `${runId}-${index + 1}.png`;
    const target = path.join(frames, filename);
    const existing = options.sceneImagePaths?.[index];
    if (existing) {
      await copyFile(existing, target);
    } else {
      reporter.set(index, "keyframe");
      imageCalls += 1;
      const seed = storyboard.style.seed === undefined ? undefined : storyboard.style.seed + index;
      await generateFrameImage(plan.shots[index].keyframePrompt, { width: size.width, height: size.height, seed, filename });
      emitEvent({ type: "preview", imageUrl: frameImageUrl(filename), label: `Scene ${index + 1} keyframe` });
    }
    return { filename, path: target, ms: Date.now() - began };
  })));
  // A failed keyframe must not surface as an unhandled rejection before its scene awaits it.
  keyframes.forEach((promise) => promise.catch(() => undefined));

  const scenes = storyboard.scenes.map((_, index) => (async (): Promise<SceneOutcome> => {
    const keyframe = await keyframes[index];
    const seconds = clipSeconds(storyboard, index, crossfade);
    const clipPath = path.join(videos, `${runId}-${index + 1}.mp4`);
    const endPinned = continuesIntoNext(storyboard, index);
    const keyframeBytes = await readFile(keyframe.path);
    const cacheKey = createHash("sha256").update(keyframeBytes).update(`|${seconds.toFixed(3)}|${quality}|${endPinned}|${aspect}`).digest("hex").slice(0, 32);
    const cached = path.join(cache, `${cacheKey}.mp4`);
    if (await exists(cached)) {
      await copyFile(cached, clipPath);
      reporter.set(index, "reused", { done: true });
      return { clipPath, keyframeFilename: keyframe.filename, engine: "i2v-cached", keyframeMs: keyframe.ms, videoMs: 0, endPinned };
    }
    return videoLimit(() => reporter.scoped(index, async () => {
      const began = Date.now();
      const requestedSeconds = Math.min(FLUX3_MAX_DURATION_SEC, Math.max(FLUX3_MIN_DURATION_SEC, Math.ceil(seconds)));
      const source = path.join(work, `${index + 1}.source.mp4`);
      try {
        reporter.set(index, "generating video");
        const pins: Flux3Keyframe[] = endPinned
          ? [[0, keyframeBytes.toString("base64")], [Math.round(seconds * 10) / 10, (await readFile((await keyframes[index + 1]).path)).toString("base64")]]
          : [keyframeBytes.toString("base64")];
        videoCalls += 1;
        const result = await generateBflVideoDetailed({ prompt: plan.shots[index].motionPrompt, keyframes: pins, durationSec: requestedSeconds, quality, generateAudio: true, aspectRatio: aspect });
        reporter.set(index, "downloading");
        await download(result.url, source);
        const info = await probe(source);
        if (info.duration < seconds - 0.1) throw new CinematicRenderError(`BFL returned ${info.duration.toFixed(2)}s, shorter than the ${seconds.toFixed(2)}s scene.`);
        const temporary = `${clipPath}.tmp.mp4`;
        await normalizeGeneratedClip(source, temporary, seconds, info.hasAudio, outputSize);
        await rename(temporary, clipPath);
        await copyFile(clipPath, cached).catch(() => undefined);
        reporter.set(index, "done", { done: true });
        logInfo("cinematic_scene_rendered", { runId, scene: index + 1, requestedSeconds, delivered: `${info.width}x${info.height}`, bfl: `${result.resolution}/draft=${result.draft}`, audio: info.hasAudio, ms: Date.now() - began });
        return {
          clipPath, keyframeFilename: keyframe.filename, engine: "i2v", keyframeMs: keyframe.ms, videoMs: Date.now() - began,
          requestedSeconds, deliveredResolution: `${info.width}x${info.height}`, bflQuality: `${result.resolution}${result.draft ? " draft" : ""}`, endPinned,
        };
      } catch (error) {
        if (error instanceof ClientAbortedError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        logException("cinematic_scene_fallback", error, { runId, scene: index + 1, reason: message.slice(0, 300) });
        reporter.set(index, "video failed → still fallback");
        await renderStillFallback(keyframe.path, clipPath, seconds, index, outputSize);
        reporter.set(index, "still fallback", { done: true });
        return { clipPath, keyframeFilename: keyframe.filename, engine: "still-fallback", keyframeMs: keyframe.ms, videoMs: Date.now() - began, requestedSeconds, endPinned, error: message.slice(0, 300) };
      } finally {
        await rm(source, { force: true });
      }
    }));
  })());

  let outcomes: SceneOutcome[];
  try {
    outcomes = await Promise.all(scenes);
  } finally {
    reporter.stop();
  }
  await narrationTask;

  // 4. Assemble: crossfades, ambient under narration, optional final caption.
  emitStage("render", "Joining the shots and mixing sound…");
  const caption = captions === "final" ? await renderCaption(storyboard, work, outputSize) : undefined;
  const videoFilename = `${runId}.mp4`;
  const videoPath = path.join(videos, videoFilename);
  await composeFinal({ storyboard, clips: outcomes.map((outcome) => outcome.clipPath), narration: narrationFiles, narrationAvailable: sayIsAvailable, caption, crossfade, output: videoPath });
  await rm(work, { recursive: true, force: true });

  const elapsedMs = Date.now() - startedAt;
  const sceneEngines = outcomes.map((outcome) => outcome.engine);
  const manifests = path.join(root, "manifests");
  await mkdir(manifests, { recursive: true });
  await writeFile(path.join(manifests, `${runId}.cinematic.json`), JSON.stringify({
    runId,
    quality,
    elapsedMs,
    crossfadeSeconds: crossfade,
    captions,
    callCounts: { images: imageCalls, videos: videoCalls },
    narrationAvailable: sayIsAvailable,
    plan: { source: plan.source, bibleSource: plan.bibleSource, bible: plan.bible, guidanceSources: plan.guidanceSources },
    scenes: outcomes.map((outcome, index) => ({
      scene: index + 1,
      durationSec: storyboard.scenes[index].timing.durationMs / 1000,
      engine: outcome.engine,
      keyframe: outcome.keyframeFilename,
      keyframeMs: outcome.keyframeMs,
      videoMs: outcome.videoMs,
      requestedSeconds: outcome.requestedSeconds,
      deliveredResolution: outcome.deliveredResolution,
      bflQuality: outcome.bflQuality,
      endPinned: outcome.endPinned,
      camera: plan.shots[index].camera,
      promptSource: plan.shots[index].source,
      keyframePrompt: plan.shots[index].keyframePrompt,
      motionPrompt: plan.shots[index].motionPrompt,
      ...(outcome.error ? { error: outcome.error } : {}),
    })),
  }, null, 2), { mode: 0o600 });
  const fallbacks = sceneEngines.filter((engine) => engine === "still-fallback").length;
  if (fallbacks) emitStage("render", `${fallbacks} of ${count} scenes used the still fallback (video generation failed).`);
  logInfo("cinematic_render_completed", { runId, scenes: count, quality, images: imageCalls, videos: videoCalls, fallbacks, elapsedMs });

  return {
    videoPath,
    videoFilename,
    durationSeconds: totalDurationMs(storyboard) / 1000,
    imageFilenames: outcomes.map((outcome) => outcome.keyframeFilename),
    narrationAvailable: sayIsAvailable,
    engine: "cinematic",
    quality,
    sceneEngines,
    plan,
    callCounts: { images: imageCalls, videos: videoCalls, llmPlan: 1 },
    elapsedMs,
  };
}
