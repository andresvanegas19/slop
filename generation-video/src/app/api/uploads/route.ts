import { withRouteLog } from "@/lib/route-log";
import { NextResponse } from "next/server";
import { describeError } from "@/lib/bfl";
import { logException, logInfo } from "@/lib/runtime-log";
import { MAX_UPLOAD_BYTES, saveUpload, UploadError } from "@/lib/uploads";

export const runtime = "nodejs";
export const maxDuration = 300;

/** POST multipart/form-data with field `file` → `{ upload: { id, videoUrl, thumbUrl, durationSeconds, width, height, hasAudio, filename } }` */
async function routePOST(request: Request) {
  try {
    const contentLength = Number(request.headers.get("content-length"));
    // Allow some multipart overhead on top of the file limit.
    if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES + 1024 * 1024) {
      return NextResponse.json({ error: `The upload is ${(contentLength / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` }, { status: 413 });
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch (error) {
      return NextResponse.json({ error: describeError(error, "The request must be multipart/form-data with a video in the \"file\" field.") }, { status: 400 });
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No video found in the \"file\" form field." }, { status: 400 });
    }
    logInfo("upload_started", { bytes: file.size, type: file.type || undefined });
    const upload = await saveUpload(file);
    logInfo("upload_completed", { uploadId: upload.id, durationSeconds: upload.durationSeconds, width: upload.width, height: upload.height, hasAudio: upload.hasAudio });
    return NextResponse.json({ upload });
  } catch (error) {
    const status = error instanceof UploadError ? error.status : 500;
    const message = error instanceof UploadError ? error.message : describeError(error, "Unable to store the uploaded video.");
    logException("upload_failed", error, { status, reason: message });
    return NextResponse.json({ error: message }, { status });
  }
}

export const POST = withRouteLog(routePOST);
