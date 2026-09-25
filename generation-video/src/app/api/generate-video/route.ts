import { withRouteLog } from "@/lib/route-log";
import { NextResponse } from "next/server";
import { logUserPrompt } from "@/lib/user-prompts";
import { streamable } from "@/lib/ndjson";
import { emitStage } from "@/lib/progress";
import { BflError, describeError, isVideoQuality } from "@/lib/bfl";
import { CLIP_SECONDS, generateClipFromPrompt } from "@/lib/clip";
import { companyContextForWriter, getCompanyContext } from "@/lib/company-agent";
import { createProject, frameImageUrl, titleFromPrompt, videoUrl } from "@/lib/projects";
import { schedulePublish } from "@/lib/video-store";
import { logInfo, logException } from "@/lib/runtime-log";
import { writeClipPrompt } from "@/lib/video-prompt";
import { jobable } from "@/lib/job-route";

export const runtime = "nodejs";

/** POST `{ prompt }` → OpenRouter writes the FLUX 3 video prompt → exactly CLIP_SECONDS-second FLUX 3 clip + a `kind: "clip"` project with one frame. */
async function handlePost(request: Request) {
  try {
    const body = await request.json() as { prompt?: unknown; rawPrompt?: unknown; quality?: unknown };
    if (typeof body.prompt !== "string" || body.prompt.trim().length === 0 || body.prompt.length > 32_000) {
      return NextResponse.json({ error: "A prompt between 1 and 32,000 characters is required." }, { status: 400 });
    }
    const prompt = body.prompt.trim();
    logInfo("video_generation_started", { promptLength: prompt.length });

    emitStage("prompt", "Writing the video prompt…");
    const company = await getCompanyContext(prompt, "video");
    // Cinematic single-shot writer (streams the enhanced prompt); `rawPrompt: true` sends the prompt unchanged.
    const videoPrompt = await writeClipPrompt(prompt, CLIP_SECONDS, { companyContext: companyContextForWriter(company), rawPrompt: body.rawPrompt === true });
    logInfo("video_prompt_ready", { source: videoPrompt.source, length: videoPrompt.prompt.length, companyContext: Boolean(company) });
    emitStage("video", "Generating the video…");
    const clip = await generateClipFromPrompt(videoPrompt.prompt, { quality: isVideoQuality(body.quality) ? body.quality : undefined });
    emitStage("save", "Saving the project…");
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
    schedulePublish(project, "generated");
    logInfo("video_generation_completed", { durationSeconds: CLIP_SECONDS, projectId: project.id, engine: clip.engine });
    return NextResponse.json({ videoUrl: project.videoUrl, durationSeconds: CLIP_SECONDS, videoPrompt: videoPrompt.prompt, videoPromptSource: videoPrompt.source, project });
  } catch (error) {
    const message = describeError(error, "Unable to generate the video.");
    const status = error instanceof BflError && error.status && error.status >= 400 && error.status < 500 ? error.status : 502;
    logException("video_generation_failed", error, { status, reason: message });
    return NextResponse.json({ error: message }, { status });
  }
}

/** Same as above; `Accept: application/x-ndjson` (or ?stream=1) streams progress events, then {"type":"done", …body}. */
export const POST = withRouteLog(jobable("clip", logUserPrompt("new_clip", streamable(handlePost))));
