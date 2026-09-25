import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { frameImageUrl } from "@/lib/projects";
import { extractFirstFrame, probeMedia } from "@/lib/segments";

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const MAX_UPLOAD_SECONDS = 120;

export class UploadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type Upload = {
  id: string;
  videoUrl: string;
  thumbUrl: string;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** Original client filename (display only). */
  filename: string;
};

type UploadRecord = Upload & { storedName: string; createdAt: string };

const UPLOAD_ID = /^[a-f0-9-]{36}$/;
export const UPLOAD_FILENAME = /^[a-f0-9-]{36}\.(mp4|mov|m4v|webm)$/;
export const UPLOAD_CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
};

export function uploadsDirectory() {
  return path.join(process.cwd(), "output", "uploads");
}

function cleanFilename(name: string) {
  const base = path.basename(name || "video").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  return (base || "video").slice(0, 200);
}

// The extension comes from the probed container (content), not from the client filename.
function extensionFor(formatName: string, clientName: string) {
  const formats = formatName.split(",");
  if (formats.includes("webm") || formats.includes("matroska")) return "webm";
  if (formats.includes("mov") || formats.includes("mp4")) {
    const clientExtension = path.extname(clientName).slice(1).toLowerCase();
    return ["mp4", "mov", "m4v"].includes(clientExtension) ? clientExtension : "mp4";
  }
  return undefined;
}

/** Validates (ffprobe) and stores an uploaded video + its first frame. Throws UploadError (413/415/400). */
export async function saveUpload(file: File): Promise<Upload> {
  if (file.size === 0) throw new UploadError("The uploaded file is empty.", 400);
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new UploadError(`The video is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`, 413);
  }
  const directory = uploadsDirectory();
  await mkdir(directory, { recursive: true });
  const id = randomUUID();
  const temporary = path.join(directory, `${id}.upload`);
  await writeFile(temporary, new Uint8Array(await file.arrayBuffer()), { mode: 0o600 });
  try {
    const filename = cleanFilename(file.name);
    const info = await probeMedia(temporary).catch(() => {
      throw new UploadError(`"${filename}" is not a readable video file (ffprobe could not parse it). Upload an MP4, MOV, M4V, or WebM video.`, 415);
    });
    const extension = extensionFor(info.formatName, filename);
    if (!extension) {
      throw new UploadError(`"${filename}" is a ${info.formatName || "unknown"} file; only MP4, MOV, M4V, and WebM videos are supported.`, 415);
    }
    if (!info.hasVideo) throw new UploadError(`"${filename}" has no video stream.`, 415);
    if (!(info.durationSeconds > 0)) throw new UploadError(`Could not determine the duration of "${filename}".`, 415);
    if (info.durationSeconds > MAX_UPLOAD_SECONDS) {
      throw new UploadError(`"${filename}" is ${info.durationSeconds.toFixed(1)}s long; the limit is ${MAX_UPLOAD_SECONDS}s.`, 413);
    }
    const storedName = `${id}.${extension}`;
    await rename(temporary, path.join(directory, storedName));
    const thumb = await extractFirstFrame(path.join(directory, storedName));
    const record: UploadRecord = {
      id,
      videoUrl: `/api/uploads/${storedName}`,
      thumbUrl: frameImageUrl(thumb),
      durationSeconds: Math.round(info.durationSeconds * 1000) / 1000,
      width: info.width,
      height: info.height,
      hasAudio: info.hasAudio,
      filename,
      storedName,
      createdAt: new Date().toISOString(),
    };
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify(record, null, 2), { mode: 0o600 });
    return publicUpload(record);
  } finally {
    await rm(temporary, { force: true });
  }
}

function publicUpload(record: UploadRecord): Upload {
  const { id, videoUrl, thumbUrl, durationSeconds, width, height, hasAudio, filename } = record;
  return { id, videoUrl, thumbUrl, durationSeconds, width, height, hasAudio, filename };
}

/** Loads an upload by id; returns its public record and the stored file path. Throws UploadError(404). */
export async function loadUpload(id: string) {
  if (!UPLOAD_ID.test(id)) throw new UploadError(`Upload id "${id}" is invalid.`, 400);
  let record: UploadRecord;
  try {
    record = JSON.parse(await readFile(path.join(uploadsDirectory(), `${id}.json`), "utf8")) as UploadRecord;
  } catch {
    throw new UploadError(`Upload "${id}" was not found; upload the video again with POST /api/uploads.`, 404);
  }
  return { upload: publicUpload(record), filePath: path.join(uploadsDirectory(), record.storedName) };
}
