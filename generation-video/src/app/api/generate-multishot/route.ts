import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { BflError, describeError, generateBflImage } from "@/lib/bfl";
import { companyVisualHint, getCompanyContext } from "@/lib/company-agent";
import { logInfo, logException } from "@/lib/runtime-log";

export const runtime = "nodejs";

function runFfmpeg(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const process = spawn("ffmpeg", ["-y", ...args]);
    let stderr = "";
    process.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    process.on("error", reject);
    process.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.slice(-500) || "FFmpeg failed.")));
  });
}

async function downloadImage(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new BflError("BFL result download failed.", response.status);
  return new Uint8Array(await response.arrayBuffer());
}

export async function POST(request: Request) {
  let concatList: string | undefined;
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
    const company = await getCompanyContext(body.prompt.trim(), "multishot");
    const visualBible = `Maintain the same subject, wardrobe, environment, lighting, color grade, and visual style across every shot.${companyVisualHint(company, 240)}`;
    const shotDirections = [
      `Shot 1 of 3, establish the scene with one simple action in a wide shot. ${body.prompt.trim()}`,
      `Shot 2 of 3, continue directly from the reference frame. Develop the action in a medium shot; preserve screen direction. ${body.prompt.trim()}`,
      `Shot 3 of 3, continue directly from the reference frame. Land on the reveal or payoff in a close-up or reaction shot. ${body.prompt.trim()}`,
    ];

    logInfo("multishot_generation_started", { shots: shotDirections.length, promptLength: body.prompt.trim().length });
    let referenceImage: string | undefined;
    const segments: string[] = [];
    for (const [index, direction] of shotDirections.entries()) {
      const sampleUrl = await generateBflImage(`${direction} ${visualBible}`, 1280, 720, referenceImage);
      const image = await downloadImage(sampleUrl);
      const framePath = path.join(frameDirectory, `${id}-${index + 1}.png`);
      await writeFile(framePath, image);
      referenceImage = `data:image/png;base64,${Buffer.from(image).toString("base64")}`;

      const segmentPath = path.join(videoDirectory, `${id}-${index + 1}.mp4`);
      await runFfmpeg([
        "-loop", "1", "-i", framePath, "-t", "2",
        "-vf", `zoompan=z='min(zoom+0.0007,1.12)':d=60:s=1280x720,format=yuv420p`,
        "-r", "30", "-c:v", "libx264", "-movflags", "+faststart", segmentPath,
      ]);
      segments.push(segmentPath);
      logInfo("multishot_generation_shot_completed", { shot: index + 1 });
    }

    concatList = path.join(videoDirectory, `${id}.concat.txt`);
    await writeFile(concatList, `${segments.map((segment) => `file '${segment}'`).join("\n")}\n`, { mode: 0o600 });
    const filename = `${id}.mp4`;
    const temporaryVideo = path.join(videoDirectory, `${id}.tmp.mp4`);
    await runFfmpeg(["-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", temporaryVideo]);
    await rename(temporaryVideo, path.join(videoDirectory, filename));
    logInfo("multishot_generation_completed", { shots: shotDirections.length, durationSeconds: 6 });
    return NextResponse.json({ videoUrl: `/api/videos/${filename}`, durationSeconds: 6, shots: 3 });
  } catch (error) {
    const message = describeError(error, "Unable to generate the multi-shot video.");
    const status = error instanceof BflError && error.status && error.status >= 400 && error.status < 500 ? error.status : 502;
    logException("multishot_generation_failed", error, { status, reason: message });
    return NextResponse.json({ error: message }, { status });
  } finally {
    if (concatList) await rm(concatList, { force: true });
  }
}
