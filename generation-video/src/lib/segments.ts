import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

/** Project video format: every segment is normalized to this before concatenation. */
export const SEGMENT_FORMAT = { width: 1280, height: 720, fps: 30, sampleRate: 48_000 } as const;

export class SegmentError extends Error {}

export type MediaInfo = {
  durationSeconds: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number;
  height: number;
  formatName: string;
};

function run(command: string, args: string[], action: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => reject(new SegmentError(`${command} is unavailable (${error.message}); install ffmpeg/ffprobe on the server.`)));
    child.on("close", (code) => code === 0
      ? resolve(stdout)
      : reject(new SegmentError(`${command} could not ${action}: ${stderr.trim().slice(-500) || `exit code ${code}`}`)));
  });
}

export function videosDirectory() {
  return path.join(process.cwd(), "output", "videos");
}

/** Resolves a served `/api/videos/<file>.mp4` URL to its path on disk. */
export function videoFilePath(videoUrl: string) {
  const filename = videoUrl.split("/").pop() ?? "";
  if (!/^[a-zA-Z0-9-]+\.mp4$/.test(filename)) throw new SegmentError(`Video URL "${videoUrl}" does not point to a served video.`);
  return path.join(videosDirectory(), filename);
}

/** Reads duration, streams and dimensions with ffprobe. Throws SegmentError if the file is not readable media. */
export async function probeMedia(filePath: string): Promise<MediaInfo> {
  const output = await run("ffprobe", [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath,
  ], `read ${path.basename(filePath)}`);
  let parsed: { format?: { duration?: string; format_name?: string }; streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[] };
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new SegmentError(`ffprobe returned unreadable output for ${path.basename(filePath)}.`);
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const duration = Number(parsed.format?.duration ?? video?.duration);
  return {
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    hasVideo: Boolean(video),
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    formatName: parsed.format?.format_name ?? "",
  };
}

/** Exact duration of a video's video stream (falls back to the container duration). */
export async function videoDurationSeconds(filePath: string) {
  const output = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration:format=duration", "-of", "json", filePath,
  ], `measure ${path.basename(filePath)}`);
  const parsed = JSON.parse(output) as { streams?: { duration?: string }[]; format?: { duration?: string } };
  const duration = Number(parsed.streams?.[0]?.duration ?? parsed.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new SegmentError(`Could not determine the duration of ${path.basename(filePath)}.`);
  return Math.round(duration * 1000) / 1000;
}

/**
 * One ffmpeg pass that normalizes each input (scale + pad to 1280x720 keeping aspect, 30 fps, yuv420p; AAC 48 kHz
 * stereo, with a silent track when an input has no audio) and concatenates them in order into output/videos/<uuid>.mp4.
 */
export async function concatSegments(inputPaths: string[]) {
  if (inputPaths.length === 0) throw new SegmentError("There are no segments to concatenate.");
  const infos = await Promise.all(inputPaths.map(async (input) => {
    const info = await probeMedia(input);
    if (!info.hasVideo) throw new SegmentError(`${path.basename(input)} has no video stream.`);
    return { ...info, durationSeconds: await videoDurationSeconds(input).catch(() => info.durationSeconds) };
  }));
  const { width, height, fps, sampleRate } = SEGMENT_FORMAT;
  const filters: string[] = [];
  const labels: string[] = [];
  infos.forEach((info, index) => {
    const duration = info.durationSeconds.toFixed(3);
    filters.push(
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p,trim=duration=${duration},setpts=PTS-STARTPTS[v${index}]`,
      info.hasAudio
        ? `[${index}:a]aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`
        : `anullsrc=r=${sampleRate}:cl=stereo,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`,
    );
    labels.push(`[v${index}][a${index}]`);
  });
  filters.push(`${labels.join("")}concat=n=${infos.length}:v=1:a=1[v][a]`);

  await mkdir(videosDirectory(), { recursive: true });
  const id = randomUUID();
  const temporary = path.join(videosDirectory(), `${id}.tmp.mp4`);
  const filename = `${id}.mp4`;
  try {
    await run("ffmpeg", [
      "-y", ...inputPaths.flatMap((input) => ["-i", input]),
      "-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(fps),
      "-c:a", "aac", "-b:a", "128k", "-ar", String(sampleRate), "-ac", "2",
      "-movflags", "+faststart", temporary,
    ], inputPaths.length === 1 ? "normalize the segment" : `concatenate ${inputPaths.length} segments`);
    await rename(temporary, path.join(videosDirectory(), filename));
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    filename,
    durationSeconds: await videoDurationSeconds(path.join(videosDirectory(), filename)),
    segmentDurations: infos.map((info) => Math.round(info.durationSeconds * 1000) / 1000),
  };
}

/** Normalizes one video (e.g. an upload) into a project segment in output/videos. */
export async function normalizeSegment(inputPath: string) {
  const result = await concatSegments([inputPath]);
  return { filename: result.filename, durationSeconds: result.durationSeconds };
}

async function extractFrame(input: string, args: string[], action: string) {
  const directory = path.join(process.cwd(), "output", "frames");
  await mkdir(directory, { recursive: true });
  const filename = `${randomUUID()}.png`;
  const output = path.join(directory, filename);
  await run("ffmpeg", ["-y", ...args.slice(0, args.indexOf("__INPUT__")), "-i", input, ...args.slice(args.indexOf("__INPUT__") + 1), output], action);
  const size = await stat(output).then((info) => info.size).catch(() => 0);
  if (size === 0) {
    await rm(output, { force: true });
    throw new SegmentError(`ffmpeg could not ${action}: no frame was written.`);
  }
  return filename;
}

/** First frame of a video → output/frames/<uuid>.png (returns the filename). */
export function extractFirstFrame(input: string) {
  return extractFrame(input, ["__INPUT__", "-frames:v", "1"], "extract the first frame");
}

/** Last frame of a video → output/frames/<uuid>.png (returns the filename). */
export function extractLastFrame(input: string) {
  return extractFrame(input, ["-sseof", "-1", "__INPUT__", "-update", "1"], "extract the last frame");
}

/** Exact (output-seeked, frame-accurate) frame at `atSec` of a video → output/frames/<uuid>.png. */
export function extractFrameAt(input: string, atSec: number) {
  // Output seeking returns the first frame with pts ≥ t. Seek 5 ms early so a time like 2 − 1/30 (1.9667) picks that
  // frame and not the next one (rounding to "1.967" used to skip a frame — across a hard cut that's another scene).
  return extractFrame(input, ["__INPUT__", "-ss", Math.max(0, atSec - 0.005).toFixed(4), "-frames:v", "1"], `extract the frame at ${atSec.toFixed(3)}s`);
}

/**
 * Replaces [startSec, endSec) of a segment's picture with the start of `replacementPath` (re-encoded, frame-accurate
 * trims), keeping the segment's ORIGINAL audio across its whole length so sound doesn't jump. Total duration is unchanged.
 * Writes a new normalized segment to output/videos and returns its filename + duration.
 */
export async function spliceWindow(segmentPath: string, replacementPath: string, startSec: number, endSec: number) {
  const [segment, replacement] = await Promise.all([probeMedia(segmentPath), probeMedia(replacementPath)]);
  const total = await videoDurationSeconds(segmentPath).catch(() => segment.durationSeconds);
  const start = Math.max(0, Math.min(startSec, total));
  const end = Math.max(start, Math.min(endSec, total));
  const windowLength = end - start;
  if (windowLength < 1 / SEGMENT_FORMAT.fps) throw new SegmentError(`The edit window ${start.toFixed(3)}–${end.toFixed(3)}s is empty.`);
  const replacementLength = await videoDurationSeconds(replacementPath).catch(() => replacement.durationSeconds);
  if (replacementLength + 1 / SEGMENT_FORMAT.fps < windowLength) {
    throw new SegmentError(`The generated clip (${replacementLength.toFixed(2)}s) is shorter than the ${windowLength.toFixed(2)}s edit window.`);
  }

  const { width, height, fps, sampleRate } = SEGMENT_FORMAT;
  const normalize = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p`;
  const filters: string[] = [];
  const parts: string[] = [];
  if (start > 0) {
    filters.push(`[0:v]${normalize},trim=start=0:end=${start.toFixed(3)},setpts=PTS-STARTPTS[pre]`);
    parts.push("[pre]");
  }
  filters.push(`[1:v]${normalize},trim=start=0:end=${windowLength.toFixed(3)},setpts=PTS-STARTPTS[mid]`);
  parts.push("[mid]");
  if (end < total - 0.5 / fps) {
    filters.push(`[0:v]${normalize},trim=start=${end.toFixed(3)},setpts=PTS-STARTPTS[post]`);
    parts.push("[post]");
  }
  filters.push(parts.length > 1 ? `${parts.join("")}concat=n=${parts.length}:v=1:a=0[v]` : `${parts[0]}null[v]`);
  filters.push(segment.hasAudio
    ? `[0:a]aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${total.toFixed(3)},asetpts=PTS-STARTPTS[a]`
    : `anullsrc=r=${sampleRate}:cl=stereo,atrim=duration=${total.toFixed(3)}[a]`);

  await mkdir(videosDirectory(), { recursive: true });
  const id = randomUUID();
  const temporary = path.join(videosDirectory(), `${id}.tmp.mp4`);
  const filename = `${id}.mp4`;
  try {
    await run("ffmpeg", [
      "-y", "-i", segmentPath, "-i", replacementPath,
      "-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(fps),
      "-c:a", "aac", "-b:a", "128k", "-ar", String(sampleRate), "-ac", "2",
      "-movflags", "+faststart", temporary,
    ], "splice the edited window into the segment");
    await rename(temporary, path.join(videosDirectory(), filename));
  } finally {
    await rm(temporary, { force: true });
  }
  return { filename, durationSeconds: await videoDurationSeconds(path.join(videosDirectory(), filename)) };
}
