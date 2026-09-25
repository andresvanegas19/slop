import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Project, ProjectFrame } from "@/lib/projects";

export class FrameGrabError extends Error {}

/** The frame whose [startSec, startSec + durationSec) contains `atSec` (the last frame also owns the video's end). */
export function frameAt(project: Project, atSec: number): ProjectFrame | undefined {
  return project.frames.find((frame, position) => {
    const end = position === project.frames.length - 1
      ? Math.max(frame.startSec + frame.durationSec, project.durationSeconds)
      : frame.startSec + frame.durationSec;
    return atSec >= frame.startSec && atSec < end;
  });
}

function videoPath(videoUrl: string) {
  const filename = videoUrl.split("/").pop() ?? "";
  if (!/^[a-zA-Z0-9-]+\.mp4$/.test(filename)) throw new FrameGrabError(`Project video URL "${videoUrl}" does not point to a served video.`);
  return path.join(process.cwd(), "output", "videos", filename);
}

/** Extracts the exact frame at `atSec` from the project's current video into output/frames; returns its filename. */
export async function grabVideoFrame(project: Project, atSec: number) {
  const input = videoPath(project.videoUrl);
  const directory = path.join(process.cwd(), "output", "frames");
  await mkdir(directory, { recursive: true });
  const filename = `${randomUUID()}.png`;
  const output = path.join(directory, filename);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", "-ss", atSec.toFixed(3), "-i", input, "-frames:v", "1", output]);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => reject(new FrameGrabError(`ffmpeg is unavailable: ${error.message}`)));
    child.on("close", (code) => code === 0
      ? resolve()
      : reject(new FrameGrabError(`ffmpeg could not grab the frame at ${atSec}s from ${path.basename(input)}: ${stderr.slice(-400) || "unknown error"}`)));
  });
  // Seeking past the last decodable frame exits 0 without writing anything.
  const size = await stat(output).then((info) => info.size).catch(() => 0);
  if (size === 0) {
    await rm(output, { force: true });
    throw new FrameGrabError(`No frame exists at ${atSec}s in ${path.basename(input)} (the video may be shorter than the project's ${project.durationSeconds}s).`);
  }
  return filename;
}
