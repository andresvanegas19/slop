/* The composer's single video attachment: local preview + XHR upload to /api/uploads with progress. */
import { useRef, useState } from "react";
import type { Attachment } from "../types";
import { errorMessage, isUpload } from "../utils";

export function useVideoAttachment() {
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const uploadXhrRef = useRef<XMLHttpRequest | null>(null);
  const attachmentKeyRef = useRef(0);

  function clearAttachment() {
    uploadXhrRef.current?.abort();
    uploadXhrRef.current = null;
    setAttachment((current) => {
      if (current) URL.revokeObjectURL(current.previewUrl);
      return null;
    });
  }

  /** Starts uploading an already-validated video file. */
  function startUpload(file: File) {
    const key = ++attachmentKeyRef.current;
    const previewUrl = URL.createObjectURL(file);
    setAttachment({ key, file, previewUrl, progress: 0, status: "uploading" });
    const update = (patch: Partial<Attachment>) => setAttachment((current) => current && current.key === key ? { ...current, ...patch } : current);

    const xhr = new XMLHttpRequest();
    uploadXhrRef.current = xhr;
    xhr.open("POST", "/api/uploads");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) update({ progress: event.loaded / event.total });
    };
    xhr.onload = () => {
      if (uploadXhrRef.current === xhr) uploadXhrRef.current = null;
      let result: { upload?: unknown; error?: unknown } = {};
      try {
        result = JSON.parse(xhr.responseText) as typeof result;
      } catch {
        result = { error: `Upload failed (HTTP ${xhr.status}). The upload endpoint returned an unexpected response.` };
      }
      if (xhr.status < 200 || xhr.status >= 300 || !isUpload(result.upload)) {
        console.error(`[upload] /api/uploads failed with HTTP ${xhr.status}`, result);
        const fallback = xhr.status === 413 ? "That video is too large (max 200 MB)." : xhr.status === 415 ? "That video format isn't supported. Use MP4, MOV, WebM, or M4V." : `Upload failed (HTTP ${xhr.status}).`;
        update({ status: "error", error: errorMessage(result, fallback) });
        return;
      }
      update({ status: "done", progress: 1, upload: result.upload });
    };
    xhr.onerror = () => {
      if (uploadXhrRef.current === xhr) uploadXhrRef.current = null;
      console.error("[upload] network error while uploading", file.name);
      update({ status: "error", error: "Upload failed — check your connection and try again." });
    };
    const body = new FormData();
    body.append("file", file);
    xhr.send(body);
  }

  /** Records the preview's decoded duration (shown until the server reports one). */
  function setLocalDuration(key: number, seconds: number) {
    setAttachment((current) => current && current.key === key ? { ...current, localDuration: seconds } : current);
  }

  return { attachment, clearAttachment, startUpload, setLocalDuration };
}
