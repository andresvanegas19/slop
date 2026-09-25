import { NextResponse } from "next/server";
import { BflError, describeError } from "@/lib/bfl";
import { renderClipFromFrame } from "@/lib/clip";
import { assembleClipProject, ClipProjectError, segmentFrameFromUpload } from "@/lib/clip-project";
import { OpenRouterConfigurationError } from "@/lib/openrouter";
import { frameFilePath, frameImageUrl, loadProject, ProjectNotFoundError, saveProject, videoUrl, withProjectLock, type Project, type ProjectFrame } from "@/lib/projects";
import { enhanceShotPrompt } from "@/lib/prompt-enhance";
import { retrieveContext } from "@/lib/rag";
import { logException, logInfo } from "@/lib/runtime-log";
import { extractFirstFrame, extractLastFrame, SegmentError, videoFilePath } from "@/lib/segments";
import { appendVideoFile, TimelineError } from "@/lib/timeline-ops";
import { loadUpload, UploadError } from "@/lib/uploads";

export const runtime = "nodejs";
export const maxDuration = 600;

const MAX_PROMPT_LENGTH = 4_000;
const MAX_FRAMES = 40;
const GUIDANCE_MAX_CHARS = 1_600;

function statusFor(error: unknown) {
  if (error instanceof ProjectNotFoundError) return 404;
  if (error instanceof UploadError || error instanceof TimelineError) return error.status;
  if (error instanceof OpenRouterConfigurationError) return 503;
  if (error instanceof ClipProjectError || error instanceof SegmentError) return 422;
  if (error instanceof BflError && error.status && error.status >= 400 && error.status < 500) return error.status;
  return 502;
}

/**
 * POST `{ uploadId?, sourceProjectId?, prompt? }` (at least one) → `{ project, appendedFrameIndex, enhancedPrompt?, ragSources? }`.
 * With `uploadId`: appends the uploaded video as a new segment. Without: generates a new FLUX 3 shot from `prompt`,
 * continuing from the last frame of the current video.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await request.json().catch(() => ({})) as { uploadId?: unknown; prompt?: unknown; sourceProjectId?: unknown };
    const uploadId = typeof body.uploadId === "string" && body.uploadId ? body.uploadId : undefined;
    const sourceProjectId = typeof body.sourceProjectId === "string" && body.sourceProjectId ? body.sourceProjectId : undefined;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!uploadId && !prompt && !sourceProjectId) {
      return NextResponse.json({ error: "Send \"uploadId\" (an uploaded video), \"sourceProjectId\" (another project's video), or \"prompt\" (a new shot to generate)." }, { status: 400 });
    }
    if (uploadId && sourceProjectId) return NextResponse.json({ error: "Send either \"uploadId\" or \"sourceProjectId\", not both." }, { status: 400 });
    if (prompt.length > MAX_PROMPT_LENGTH) return NextResponse.json({ error: `"prompt" must be at most ${MAX_PROMPT_LENGTH} characters.` }, { status: 400 });

    const initial = await loadProject(id);
    if (initial.kind === "storyboard") return NextResponse.json({ error: "Appending isn't supported for storyboard projects yet." }, { status: 422 });
    if (initial.frames.length >= MAX_FRAMES) return NextResponse.json({ error: `Project "${id}" already has ${MAX_FRAMES} shots; that's the limit.` }, { status: 422 });
    const upload = uploadId ? await loadUpload(uploadId) : undefined;
    let source: Project | undefined;
    if (sourceProjectId) {
      try {
        source = await loadProject(sourceProjectId);
      } catch (error) {
        if (error instanceof ProjectNotFoundError) {
          return NextResponse.json({ error: `Source project "${sourceProjectId}" was not found.` }, { status: 404 });
        }
        throw error;
      }
    }

    logInfo("project_append_started", { projectId: id, mode: upload ? "upload" : source ? "project" : "generate" });
    const result = await withProjectLock(id, async () => {
      const project = await loadProject(id);
      if (source) {
        // The source's current rendered video (clip or storyboard) becomes one new segment.
        const appended = await appendVideoFile(project, videoFilePath(source.videoUrl), { prompt: `From: ${source.title}`, source: "project" });
        await saveProject(appended);
        return { project: appended, appendedFrameIndex: appended.frames.length - 1 };
      }
      let frame: ProjectFrame;
      let enhancedPrompt: string | undefined;
      let ragSources: string[] | undefined;

      if (upload) {
        frame = await segmentFrameFromUpload(upload.filePath, prompt || `Uploaded video: ${upload.upload.filename}`);
      } else {
        // Continuity: the new shot starts from the last frame of the current video.
        const lastFrame = await extractLastFrame(videoFilePath(project.videoUrl));
        const previous = project.frames.at(-1);
        const previousPrompt = previous?.prompt ?? project.title;
        const rag = await retrieveContext(`${prompt}\n${previousPrompt}`, { k: 3, maxChars: GUIDANCE_MAX_CHARS, tags: ["motion", "flux"] });
        ragSources = [...new Set(rag.sources.map((source) => source.title))];
        const enhanced = await enhanceShotPrompt({
          projectId: id,
          previousPrompt,
          instruction: prompt,
          referenceImagePath: frameFilePath(frameImageUrl(lastFrame)),
          guidance: rag.text,
        });
        enhancedPrompt = enhanced.prompt;
        logInfo("project_append_prompt_enhanced", { projectId: id, source: enhanced.source, length: enhanced.prompt.length });
        const clip = await renderClipFromFrame(lastFrame, enhanced.prompt);
        const firstFrame = await extractFirstFrame(videoFilePath(videoUrl(clip.videoFilename)));
        frame = {
          index: project.frames.length,
          imageUrl: frameImageUrl(firstFrame),
          prompt: enhanced.prompt,
          startSec: project.durationSeconds,
          durationSec: clip.durationSeconds,
          segmentUrl: videoUrl(clip.videoFilename),
          source: "generated",
        };
      }

      const assembled = await assembleClipProject(project, [...project.frames, { ...frame, index: project.frames.length }]);
      await saveProject(assembled);
      return {
        project: assembled,
        appendedFrameIndex: assembled.frames.length - 1,
        ...(enhancedPrompt ? { enhancedPrompt } : {}),
        ...(ragSources ? { ragSources } : {}),
      };
    });
    logInfo("project_append_completed", { projectId: id, frames: result.project.frames.length, durationSeconds: result.project.durationSeconds });
    return NextResponse.json(result);
  } catch (error) {
    const status = statusFor(error);
    const message = error instanceof ProjectNotFoundError || error instanceof UploadError || error instanceof TimelineError
      ? error.message
      : describeError(error, "Unable to append to the project.");
    logException("project_append_failed", error, { projectId: id, status, reason: message });
    return NextResponse.json({ error: message }, { status });
  }
}
