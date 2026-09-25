import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BflError, generateBflVideo, type Flux3Keyframe } from "@/lib/bfl";
import { logInfo } from "@/lib/runtime-log";
import { SEGMENT_FORMAT, SegmentError, videosDirectory } from "@/lib/segments";

/** A keyframe pinned at a time (seconds from the clip start) — image is a PNG path on disk. */
export type ClipPin = { atSec: number; imagePath: string };

type TimestampFormat = "fractional" | "whole";

// Which timestamp format BFL accepted last; later calls go straight to it (per server process).
let workingFormat: TimestampFormat | undefined;

export function pinnedClipTimestampFormat() {
  return workingFormat;
}

function runFfmpeg(args: string[], action: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => reject(new SegmentError(`ffmpeg is unavailable (${error.message}).`)));
    child.on("close", (code) => code === 0 ? resolve() : reject(new SegmentError(`ffmpeg could not ${action}: ${stderr.trim().slice(-500) || `exit code ${code}`}`)));
  });
}

async function download(url: string, destination: string) {
  const response = await fetch(url);
  if (!response.ok) throw new BflError(`BFL video download failed (HTTP ${response.status}).`, response.status);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new BflError("BFL returned an empty video.");
  await writeFile(destination, bytes, { mode: 0o600 });
}

function rejectedTimestamps(error: unknown) {
  return error instanceof BflError
    && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 402 && error.status !== 403 && error.status !== 429
    && /keyframe|timestamp|second|integer|int\b|float|time/i.test(error.message);
}

function pinnedPrompt(prompt: string) {
  return `${prompt.replace(/\s+$/, "")}\n\nContinuous single shot that passes exactly through the pinned keyframes, with smooth natural motion between them and no cuts or scene changes. No on-screen text.`;
}

async function generate(prompt: string, keyframes: Flux3Keyframe[], source: string) {
  const url = await generateBflVideo({ prompt: pinnedPrompt(prompt), keyframes, generateAudio: false });
  await download(url, source);
}

/**
 * Generates a FLUX 3 clip pinned to the given keyframes and returns a silent, normalized MP4 (output/videos) that is
 * exactly `lengthSec` long. Tries fractional-second pins first; if BFL rejects them, retries once with whole-second
 * pins (n = round(length)) and time-scales the first n seconds to exactly `lengthSec`.
 */
export async function renderPinnedClip(input: { prompt: string; pins: ClipPin[]; lengthSec: number }) {
  const length = input.lengthSec;
  const images = await Promise.all(input.pins.map(async (pin) => (await readFile(pin.imagePath)).toString("base64")));
  await mkdir(videosDirectory(), { recursive: true });
  const id = randomUUID();
  const source = path.join(videosDirectory(), `${id}.source.mp4`);
  const temporary = path.join(videosDirectory(), `${id}.tmp.mp4`);
  const filename = `${id}.mp4`;
  const { width, height, fps } = SEGMENT_FORMAT;
  const normalize = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},format=yuv420p`;
  const startedAt = Date.now();

  const fractional = async () => {
    const keyframes: Flux3Keyframe[] = input.pins.map((pin, index) => [Math.round(pin.atSec * 1000) / 1000, images[index]]);
    await generate(input.prompt, keyframes, source);
    await runFfmpeg([
      "-y", "-i", source, "-an", "-vf", `${normalize},trim=duration=${length.toFixed(3)},setpts=PTS-STARTPTS`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", temporary,
    ], "trim the pinned clip");
  };

  const whole = async () => {
    const n = Math.max(1, Math.round(length));
    const seen = new Set<number>();
    const keyframes: Flux3Keyframe[] = [];
    input.pins.forEach((pin, index) => {
      const isLast = index === input.pins.length - 1;
      const second = isLast ? n : Math.min(n, Math.max(0, Math.round((pin.atSec / length) * n)));
      if (seen.has(second)) return; // a middle pin that rounds onto 0 or n is dropped
      seen.add(second);
      keyframes.push([second, images[index]]);
    });
    await generate(input.prompt, keyframes, source);
    await runFfmpeg([
      "-y", "-i", source, "-an",
      "-vf", `${normalize},trim=duration=${n},setpts=(PTS-STARTPTS)*${(length / n).toFixed(6)},fps=${fps}`,
      "-t", length.toFixed(3),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", temporary,
    ], "time-scale the pinned clip");
    return n;
  };

  try {
    let used: TimestampFormat;
    if (workingFormat === "whole") {
      await whole();
      used = "whole";
    } else {
      try {
        await fractional();
        used = "fractional";
      } catch (error) {
        if (!rejectedTimestamps(error)) throw error;
        logInfo("pinned_clip_fractional_rejected", { reason: error instanceof Error ? error.message.slice(0, 200) : String(error) });
        await whole();
        used = "whole";
      }
    }
    workingFormat = used;
    await rename(temporary, path.join(videosDirectory(), filename));
    logInfo("pinned_clip_rendered", { timestamps: used, pins: input.pins.length, lengthSec: length, elapsedMs: Date.now() - startedAt });
    return { videoFilename: filename, timestampFormat: used };
  } finally {
    await rm(source, { force: true });
    await rm(temporary, { force: true });
  }
}
