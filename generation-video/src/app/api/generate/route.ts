import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { BflError, describeError, generateBflImage } from "@/lib/bfl";
import { logError, logInfo, logException } from "@/lib/runtime-log";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { prompt?: unknown; shotId?: unknown };
    if (typeof body.prompt !== "string" || body.prompt.trim().length === 0 || body.prompt.length > 32_000) {
      logError("image_generation_rejected", { reason: "invalid_prompt" });
      return NextResponse.json({ error: "A prompt between 1 and 32,000 characters is required." }, { status: 400 });
    }
    if (typeof body.shotId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(body.shotId)) {
      logError("image_generation_rejected", { reason: "invalid_shot_id" });
      return NextResponse.json({ error: "Invalid shot identifier." }, { status: 400 });
    }

    logInfo("image_generation_started", { shotId: body.shotId, promptLength: body.prompt.trim().length });
    const sampleUrl = await generateBflImage(body.prompt.trim());
    const sampleResponse = await fetch(sampleUrl).catch((error: unknown) => {
      throw new BflError(describeError(error, "BFL finished the image, but downloading it failed"));
    });
    if (!sampleResponse.ok) {
      throw new BflError(`BFL finished the image, but downloading it failed (HTTP ${sampleResponse.status}). The result URL may have expired; try again.`);
    }
    const bytes = new Uint8Array(await sampleResponse.arrayBuffer());
    const outputDir = path.join(process.cwd(), "output", "frames");
    const filename = `${body.shotId}-${Date.now()}.png`;
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, filename), bytes);

    logInfo("image_generation_completed", { shotId: body.shotId, byteSize: bytes.byteLength });
    return NextResponse.json({ assetUrl: `/api/assets/${filename}` });
  } catch (error) {
    const message = describeError(error, "Unable to generate the image.");
    const status = error instanceof BflError && error.status && error.status >= 400 && error.status < 500 ? error.status : 502;
    logException("image_generation_failed", error, { status, reason: message });
    return NextResponse.json({ error: message }, { status });
  }
}
