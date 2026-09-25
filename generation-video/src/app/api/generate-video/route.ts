import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { BflError, generateBflImage } from "@/lib/bfl";
import { logError, logInfo } from "@/lib/runtime-log";

export const runtime = "nodejs";

function renderMotionClip(input: string, output: string) {
  return new Promise<void>((resolve, reject) => {
    const process = spawn("ffmpeg", [
      "-y", "-loop", "1", "-i", input, "-t", "6",
      "-vf", "zoompan=z='min(zoom+0.0007,1.12)':d=180:s=1280x720,format=yuv420p",
      "-r", "30", "-c:v", "libx264", "-movflags", "+faststart", output,
    ]);
    let stderr = "";
    process.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    process.on("error", reject);
    process.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.slice(-500) || "FFmpeg failed.")));
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { prompt?: unknown };
    if (typeof body.prompt !== "string" || body.prompt.trim().length === 0 || body.prompt.length > 32_000) {
      return NextResponse.json({ error: "A prompt between 1 and 32,000 characters is required." }, { status: 400 });
    }

    const id = randomUUID();
    const root = path.join(process.cwd(), "output");
    const frameDirectory = path.join(root, "frames");
    const videoDirectory = path.join(root, "videos");
    await Promise.all([mkdir(frameDirectory, { recursive: true }), mkdir(videoDirectory, { recursive: true })]);
    logInfo("video_generation_started", { promptLength: body.prompt.trim().length });

    const sampleUrl = await generateBflImage(body.prompt.trim(), 1280, 720);
    const sampleResponse = await fetch(sampleUrl);
    if (!sampleResponse.ok) throw new BflError("BFL result download failed.", sampleResponse.status);
    const framePath = path.join(frameDirectory, `${id}.png`);
    await writeFile(framePath, new Uint8Array(await sampleResponse.arrayBuffer()));

    const filename = `${id}.mp4`;
    const temporaryVideo = path.join(videoDirectory, `${filename}.tmp`);
    await renderMotionClip(framePath, temporaryVideo);
    await rename(temporaryVideo, path.join(videoDirectory, filename));
    logInfo("video_generation_completed", { durationSeconds: 6 });
    return NextResponse.json({ videoUrl: `/api/videos/${filename}`, durationSeconds: 6 });
  } catch (error) {
    const message = error instanceof BflError ? error.message : "Unable to generate the video.";
    const status = error instanceof BflError && error.status && error.status >= 400 && error.status < 500 ? error.status : 502;
    logError("video_generation_failed", { status, reason: error instanceof BflError ? error.message : "render_or_generation_error" });
    return NextResponse.json({ error: message }, { status });
  }
}
