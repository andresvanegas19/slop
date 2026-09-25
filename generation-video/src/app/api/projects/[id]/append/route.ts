import { NextResponse } from "next/server";
import { logUserPrompt } from "@/lib/user-prompts";
import { streamable } from "@/lib/ndjson";
import { actionErrorResponse, appendToProject } from "@/lib/project-actions";
import { logException } from "@/lib/runtime-log";

export const runtime = "nodejs";
export const maxDuration = 600;

const MAX_PROMPT_LENGTH = 4_000;

/**
 * POST `{ uploadId?, sourceProjectId?, prompt?, seconds? }` (at least one of the first three) →
 * `{ project, appendedFrameIndex, appendedFrameIndexes, enhancedPrompt?, ragSources? }`.
 * `seconds` (1–15, generated appends only) chains ceil(seconds / 3) shots and trims the last so exactly that much is added.
 * With `uploadId`: appends the uploaded video as a new segment. Without: generates a new FLUX 3 shot from `prompt`,
 * continuing from the last frame of the current video.
 */
async function handlePost(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await request.json().catch(() => ({})) as { uploadId?: unknown; prompt?: unknown; sourceProjectId?: unknown; seconds?: unknown };
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (prompt.length > MAX_PROMPT_LENGTH) return NextResponse.json({ error: `"prompt" must be at most ${MAX_PROMPT_LENGTH} characters.` }, { status: 400 });
    if (body.seconds !== undefined && body.seconds !== null && typeof body.seconds !== "number") {
      return NextResponse.json({ error: `"seconds" must be a number (got ${JSON.stringify(body.seconds)}).` }, { status: 400 });
    }
    const result = await appendToProject({
      projectId: id,
      uploadId: typeof body.uploadId === "string" && body.uploadId ? body.uploadId : undefined,
      sourceProjectId: typeof body.sourceProjectId === "string" && body.sourceProjectId ? body.sourceProjectId : undefined,
      prompt,
      seconds: typeof body.seconds === "number" ? body.seconds : undefined,
    });
    return NextResponse.json({
      project: result.project,
      appendedFrameIndex: result.appendedFrameIndex,
      appendedFrameIndexes: result.appendedFrameIndexes,
      ...(result.enhancedPrompt ? { enhancedPrompt: result.enhancedPrompt } : {}),
      ...(result.ragSources ? { ragSources: result.ragSources } : {}),
      ...(result.memorySources ? { memorySources: result.memorySources } : {}),
      ...(result.continuationModes ? { continuationModes: result.continuationModes } : {}),
    });
  } catch (error) {
    const { status, message } = actionErrorResponse(error, "Unable to append to the project.");
    logException("project_append_failed", error, { projectId: id, status, reason: message });
    return NextResponse.json({ error: message }, { status });
  }
}

/** Same as above; `Accept: application/x-ndjson` (or ?stream=1) streams progress events, then {"type":"done", …body}. */
export const POST = logUserPrompt("append", streamable(handlePost));
