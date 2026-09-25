import { NextResponse } from "next/server";
import { BflError, describeError } from "@/lib/bfl";
import { CLIP_SECONDS, generateClipFromPrompt } from "@/lib/clip";
import { createProject, frameImageUrl, titleFromPrompt, videoUrl } from "@/lib/projects";
import { logInfo, logException } from "@/lib/runtime-log";
import { writeVideoPrompt } from "@/lib/video-prompt";

export const runtime = "nodejs";

/** POST `{ prompt }` → OpenRouter writes the FLUX 3 video prompt → exactly CLIP_SECONDS-second FLUX 3 clip + a `kind: "clip"` project with one frame. */
export async function POST(request: Request) {
  try {
    const body = await request.json() as { prompt?: unknown };
    if (typeof body.prompt !== "string" || body.prompt.trim().length === 0 || body.prompt.length > 32_000) {
      return NextResponse.json({ error: "A prompt between 1 and 32,000 characters is required." }, { status: 400 });
    }
    const prompt = body.prompt.trim();
    logInfo("video_generation_started", { promptLength: prompt.length });

    const videoPrompt = await writeVideoPrompt(prompt, CLIP_SECONDS);
    logInfo("video_prompt_ready", { source: videoPrompt.source, length: videoPrompt.prompt.length });
    const clip = await generateClipFromPrompt(videoPrompt.prompt);
    const project = await createProject({
      kind: "clip",
      title: titleFromPrompt(prompt),
      videoUrl: videoUrl(clip.videoFilename),
      durationSeconds: CLIP_SECONDS,
      frames: [{
        index: 0,
        imageUrl: frameImageUrl(clip.frameFilename),
        prompt: videoPrompt.prompt,
        startSec: 0,
        durationSec: CLIP_SECONDS,
        seed: clip.seed,
        segmentUrl: videoUrl(clip.videoFilename),
        source: "generated",
      }],
    });
    logInfo("video_generation_completed", { durationSeconds: CLIP_SECONDS, projectId: project.id, engine: clip.engine });
    return NextResponse.json({ videoUrl: project.videoUrl, durationSeconds: CLIP_SECONDS, videoPrompt: videoPrompt.prompt, videoPromptSource: videoPrompt.source, project });
  } catch (error) {
    const message = describeError(error, "Unable to generate the video.");
    const status = error instanceof BflError && error.status && error.status >= 400 && error.status < 500 ? error.status : 502;
    logException("video_generation_failed", error, { status, reason: message });
    return NextResponse.json({ error: message }, { status });
  }
}
