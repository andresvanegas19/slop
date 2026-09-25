import { NextResponse } from "next/server";
import { describeError } from "@/lib/bfl";
import { segmentFrameFromUpload } from "@/lib/clip-project";
import { createProject, titleFromPrompt } from "@/lib/projects";
import { logException, logInfo } from "@/lib/runtime-log";
import { loadUpload, UploadError } from "@/lib/uploads";

export const runtime = "nodejs";
export const maxDuration = 300;

/** POST `{ uploadId, prompt? }` → `{ project }`: a new `kind: "clip"` project whose frame 0 is the uploaded video. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { uploadId?: unknown; prompt?: unknown };
    if (typeof body.uploadId !== "string" || !body.uploadId) {
      return NextResponse.json({ error: "\"uploadId\" (from POST /api/uploads) is required." }, { status: 400 });
    }
    const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 4_000) : "";
    const { upload, filePath } = await loadUpload(body.uploadId);
    const frame = await segmentFrameFromUpload(filePath, prompt || `Uploaded video: ${upload.filename}`);
    const project = await createProject({
      kind: "clip",
      title: prompt ? titleFromPrompt(prompt) : upload.filename.replace(/\.[a-z0-9]+$/i, ""),
      videoUrl: frame.segmentUrl as string,
      durationSeconds: frame.durationSec,
      frames: [frame],
    });
    logInfo("project_from_upload_created", { projectId: project.id, uploadId: upload.id, durationSeconds: project.durationSeconds });
    return NextResponse.json({ project });
  } catch (error) {
    const status = error instanceof UploadError ? error.status : 502;
    const message = error instanceof UploadError ? error.message : describeError(error, "Unable to create a project from the upload.");
    logException("project_from_upload_failed", error, { status, reason: message });
    return NextResponse.json({ error: message }, { status });
  }
}
