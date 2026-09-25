"use client";

import { ChangeEvent, ClipboardEvent, DragEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import BlobLoader from "@/components/BlobLoader";

type MediaType = "storyboard" | "rawtree" | "ad" | "company";
type PresetType = "ad" | "company";
type HistoryKind = "clip" | "storyboard" | "rawtree" | "upload" | "ad" | "company";

type ProjectFrame = { index: number; imageUrl: string; prompt: string; startSec: number; durationSec: number; narration?: string; headline?: string; sub?: string; segmentUrl?: string; source?: "generated" | "upload"; edits?: FrameEdit[] };
type FrameEdit = { atSec: number; windowSec?: number; rangeStartSec?: number; rangeEndSec?: number; prompt: string; at: string };
type RangeDrag = { mode: "new" | "start" | "end" | "move"; startX: number; anchorSec: number; original: TimeWindow | null; moved: boolean; pointerId: number };
type TimeWindow = { startSec: number; endSec: number };
type ChatMessage = { role: "user" | "assistant"; text: string; at: string; edited?: boolean };
type Project = { id: string; kind: "clip" | "storyboard"; title: string; createdAt: string; updatedAt: string; videoUrl: string; durationSeconds: number; frames: ProjectFrame[]; chats: Record<string, ChatMessage[]> };

type HistoryItem = { projectId: string; title: string; videoUrl: string; thumbUrl: string; durationSeconds: number; createdAt: string; kind: HistoryKind };
type FrameReply = { atSec: number; label: string; text: string; edited: boolean; enhancedPrompt?: string; grabbedFrameUrl?: string };
type Upload = { id: string; videoUrl: string; thumbUrl: string; durationSeconds: number; width: number; height: number; hasAudio: boolean; filename: string };
type Attachment = { key: number; file: File; previewUrl: string; progress: number; status: "uploading" | "done" | "error"; localDuration?: number; upload?: Upload; error?: string };
type ContinueAction = "edit" | "append";
type BusyState = { label: string; detail: string };
type AppendResult = { project?: unknown; appendedFrameIndex?: unknown; enhancedPrompt?: unknown; ragSources?: unknown; error?: unknown };
type FrameGrab = { key: number; atSec: number; thumbUrl: string | null; captured: boolean };

type RenderIssue = { path?: unknown; code?: unknown; message?: unknown };
type RenderResult = {
  videoUrl?: unknown;
  durationSeconds?: unknown;
  narrationAvailable?: unknown;
  project?: unknown;
  error?: unknown;
  details?: unknown;
};
type AskResult = { reply?: unknown; edited?: unknown; project?: unknown; enhancedPrompt?: unknown; grabbedFrameUrl?: unknown; window?: unknown; error?: unknown };

const HISTORY_KEY = "longform.history.v1";
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".m4v"];
const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm,video/x-m4v,.mp4,.mov,.webm,.m4v";
const HISTORY_LIMIT = 50;
const EMPTY_HISTORY: HistoryItem[] = [];

function errorMessage(result: { error?: unknown }, fallback: string) {
  return typeof result.error === "string" ? result.error : fallback;
}

function issueMessages(details: unknown) {
  if (!Array.isArray(details)) return [];
  return details.flatMap((detail) => {
    if (!detail || typeof detail !== "object") return [];
    const issue = detail as RenderIssue;
    return typeof issue.message === "string" ? [issue.message] : [];
  });
}

function isProject(value: unknown): value is Project {
  if (!value || typeof value !== "object") return false;
  const project = value as Partial<Project>;
  return typeof project.id === "string" && typeof project.videoUrl === "string" && Array.isArray(project.frames);
}

function isHistoryItem(value: unknown): value is HistoryItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<HistoryItem>;
  return typeof item.projectId === "string" && typeof item.videoUrl === "string" && typeof item.createdAt === "string";
}

function formatSeconds(seconds: number) {
  const whole = Math.max(0, seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

function formatWhen(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function kindLabel(kind: HistoryKind) {
  return kind === "rawtree" ? "Competitor summary" : kind === "storyboard" ? "Storyboard render" : kind === "upload" ? "Uploaded video" : kind === "ad" ? "Ad" : kind === "company" ? "Company" : "Clip";
}

/** Index of the frame whose [startSec, startSec + durationSec) range contains `seconds` (last frame at the very end). */
function frameIndexAt(frames: ProjectFrame[], seconds: number) {
  if (frames.length === 0) return 0;
  const match = frames.find((frame) => seconds >= frame.startSec && seconds < frame.startSec + frame.durationSec);
  if (match) return match.index;
  return seconds < frames[0].startSec ? frames[0].index : frames[frames.length - 1].index;
}

async function readJson<T extends object>(response: Response, nonJsonError?: string): Promise<T> {
  const responseText = await response.text();
  try {
    return JSON.parse(responseText) as T;
  } catch {
    console.error(`[api] ${response.url} returned HTTP ${response.status} with a non-JSON body`, responseText.slice(0, 300));
    return { error: nonJsonError ?? `Server returned HTTP ${response.status} with a non-JSON body: ${responseText.slice(0, 300) || "(empty)"}` } as T;
  }
}

/* History store: in-memory copy mirrored to localStorage (all access guarded). */
let historyCache: HistoryItem[] | null = null;
const historyListeners = new Set<() => void>();

function loadHistory(): HistoryItem[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter(isHistoryItem) : [];
  } catch (caughtError) {
    console.error("[history] could not read history", caughtError);
    return [];
  }
}

function getHistorySnapshot() {
  if (historyCache === null) historyCache = loadHistory();
  return historyCache;
}

function getHistoryServerSnapshot() {
  return EMPTY_HISTORY;
}

function subscribeHistory(listener: () => void) {
  historyListeners.add(listener);
  function onStorage(event: StorageEvent) {
    if (event.key !== HISTORY_KEY) return;
    historyCache = loadHistory();
    listener();
  }
  window.addEventListener("storage", onStorage);
  return () => {
    historyListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function updateHistory(update: (items: HistoryItem[]) => HistoryItem[]) {
  historyCache = update(getHistorySnapshot()).slice(0, HISTORY_LIMIT);
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(historyCache));
  } catch (caughtError) {
    console.error("[history] could not save history", caughtError);
  }
  historyListeners.forEach((listener) => listener());
}

/* History list open/closed preference (localStorage, guarded). */
const HISTORY_OPEN_KEY = "longform.historyOpen.v1";
let historyOpenCache: boolean | null = null;
const historyOpenListeners = new Set<() => void>();

function getHistoryOpenSnapshot() {
  if (historyOpenCache === null) {
    try {
      historyOpenCache = window.localStorage.getItem(HISTORY_OPEN_KEY) === "1";
    } catch (caughtError) {
      console.error("[history] could not read the history toggle state", caughtError);
      historyOpenCache = false;
    }
  }
  return historyOpenCache;
}

function getHistoryOpenServerSnapshot() {
  return false;
}

function subscribeHistoryOpen(listener: () => void) {
  historyOpenListeners.add(listener);
  return () => {
    historyOpenListeners.delete(listener);
  };
}

function setHistoryOpen(open: boolean) {
  historyOpenCache = open;
  try {
    window.localStorage.setItem(HISTORY_OPEN_KEY, open ? "1" : "0");
  } catch (caughtError) {
    console.error("[history] could not save the history toggle state", caughtError);
  }
  historyOpenListeners.forEach((listener) => listener());
}

function isUpload(value: unknown): value is Upload {
  if (!value || typeof value !== "object") return false;
  const upload = value as Partial<Upload>;
  return typeof upload.id === "string" && typeof upload.videoUrl === "string";
}

function isVideoFile(file: File) {
  const name = file.name.toLowerCase();
  return file.type.startsWith("video/") || VIDEO_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function historyItemFromProject(created: Project, kind: HistoryKind, fallbackTitle: string): HistoryItem {
  return {
    projectId: created.id,
    title: created.title || fallbackTitle,
    videoUrl: created.videoUrl,
    thumbUrl: created.frames[0]?.imageUrl ?? "",
    durationSeconds: created.durationSeconds,
    createdAt: created.createdAt || new Date().toISOString(),
    kind,
  };
}

const RANGE_MIN_SEC = 0.3;
const RANGE_MAX_SEC = 3;
const FRAME_STEP = 1 / 30;

function snapSec(seconds: number) {
  return Math.round(seconds * 30) / 30;
}

function segmentOf(frames: ProjectFrame[], seconds: number): TimeWindow {
  const frame = frames.find((candidate) => candidate.index === frameIndexAt(frames, seconds));
  return frame ? { startSec: frame.startSec, endSec: frame.startSec + frame.durationSec } : { startSec: 0, endSec: Math.max(seconds, 0) + RANGE_MAX_SEC };
}

/**
 * Normalizes a user range: snapped to 1/30s, clamped to the shot containing its start, 0.3s–3s long.
 * `keep` is the edge that stays put ("start" when dragging the end handle, "end" for the start handle, "length" when moving).
 */
function clampRange(frames: ProjectFrame[], start: number, end: number, keep: "start" | "end" | "length"): { range: TimeWindow; limit: string | null } {
  let s = Math.min(start, end);
  let e = Math.max(start, end);
  const segment = segmentOf(frames, keep === "end" ? Math.max(0, e - 1e-6) : s);
  const segLength = segment.endSec - segment.startSec;
  const maxLength = Math.min(RANGE_MAX_SEC, segLength);
  const minLength = Math.min(RANGE_MIN_SEC, segLength);
  let limit: string | null = null;
  if (keep === "length") {
    const length = Math.min(Math.max(e - s, minLength), maxLength);
    const clampedStart = Math.min(Math.max(s, segment.startSec), segment.endSec - length);
    if (clampedStart !== s) limit = `Ranges stay within one shot (${segment.startSec.toFixed(1)}s–${segment.endSec.toFixed(1)}s)`;
    s = clampedStart;
    e = s + length;
  } else {
    if (s < segment.startSec || e > segment.endSec) limit = `Ranges stay within one shot (${segment.startSec.toFixed(1)}s–${segment.endSec.toFixed(1)}s)`;
    s = Math.max(s, segment.startSec);
    e = Math.min(e, segment.endSec);
    if (e - s < minLength) {
      limit = `Minimum range is ${RANGE_MIN_SEC}s`;
      if (keep === "start") e = Math.min(segment.endSec, s + minLength);
      else s = Math.max(segment.startSec, e - minLength);
      if (e - s < minLength) {
        if (keep === "start") s = e - minLength;
        else e = s + minLength;
      }
    }
    if (e - s > maxLength) {
      limit = `Maximum range is ${RANGE_MAX_SEC}s`;
      if (keep === "start") e = s + maxLength;
      else s = e - maxLength;
    }
  }
  s = Math.max(segment.startSec, snapSec(s));
  e = Math.min(segment.endSec, snapSec(e));
  return { range: { startSec: s, endSec: e }, limit };
}

function defaultRange(frames: ProjectFrame[], atSec: number) {
  return clampRange(frames, atSec - 0.5, atSec + 0.5, "length").range;
}
const PRESET_LENGTHS = [5, 10, 15, 30];

function isPreset(type: MediaType | null): type is PresetType {
  return type === "ad" || type === "company";
}

/** Legacy edit window centred on `atSec` (± windowSec), clamped to the containing frame's segment (used for past edits). */
function editWindowFor(frames: ProjectFrame[], atSec: number, windowSec: number): TimeWindow {
  const frame = frames.find((candidate) => candidate.index === frameIndexAt(frames, atSec));
  const segStart = frame?.startSec ?? 0;
  const segEnd = frame ? frame.startSec + frame.durationSec : atSec + windowSec;
  return { startSec: Math.max(segStart, atSec - windowSec), endSec: Math.min(segEnd, atSec + windowSec) };
}

function isTimeWindow(value: unknown): value is TimeWindow {
  if (!value || typeof value !== "object") return false;
  const window = value as Partial<TimeWindow>;
  return typeof window.startSec === "number" && typeof window.endSec === "number";
}

function formatWindow(window: TimeWindow) {
  return `${window.startSec.toFixed(1)}s–${window.endSec.toFixed(1)}s`;
}

function formatRange(window: TimeWindow) {
  return `${formatWindow(window)} (${(window.endSec - window.startSec).toFixed(1)}s)`;
}

/** Draws the current video frame to a small canvas; returns null if the frame isn't decoded or comes out blank (Safari). */
function captureVideoThumb(video: HTMLVideoElement): string | null {
  try {
    if (video.readyState < 2 || video.videoWidth === 0) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = Math.max(1, Math.round((160 * video.videoHeight) / video.videoWidth));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = false;
    for (let offset = 0; offset < pixels.length; offset += 4 * 97) {
      if (pixels[offset] + pixels[offset + 1] + pixels[offset + 2] > 12) {
        lit = true;
        break;
      }
    }
    return lit ? canvas.toDataURL("image/jpeg", 0.78) : null;
  } catch (caughtError) {
    console.error("[editor] could not capture a thumbnail of the current frame", caughtError);
    return null;
  }
}

function isAbortError(caughtError: unknown) {
  return caughtError instanceof DOMException && caughtError.name === "AbortError";
}

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatingKind, setGeneratingKind] = useState<HistoryKind>("clip");
  const [error, setError] = useState<string | null>(null);
  const [narrationMessages, setNarrationMessages] = useState<string[]>([]);
  const [mediaType, setMediaType] = useState<MediaType | null>(null);
  const [isMediaMenuOpen, setIsMediaMenuOpen] = useState(false);
  const [storyboard, setStoryboard] = useState<unknown | null>(null);
  const [storyboardFileName, setStoryboardFileName] = useState<string | null>(null);
  const [storyboardError, setStoryboardError] = useState<string | null>(null);

  const history = useSyncExternalStore(subscribeHistory, getHistorySnapshot, getHistoryServerSnapshot);
  const isHistoryOpen = useSyncExternalStore(subscribeHistoryOpen, getHistoryOpenSnapshot, getHistoryOpenServerSnapshot);
  const [notice, setNotice] = useState<string | null>(null);
  const generationAbortRef = useRef<AbortController | null>(null);
  const editAbortRef = useRef<AbortController | null>(null);

  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [grab, setGrab] = useState<FrameGrab | null>(null);
  const [videoReload, setVideoReload] = useState(0);
  const [editingAt, setEditingAt] = useState<number | null>(null);
  const [busy, setBusy] = useState<BusyState | null>(null);
  const [range, setRangeState] = useState<TimeWindow | null>(null);
  const [rangeLimit, setRangeLimit] = useState<string | null>(null);
  const rangeRef = useRef<TimeWindow | null>(null);
  const rangeDragRef = useRef<RangeDrag | null>(null);
  const rangeLimitTimerRef = useRef<number | null>(null);
  const [flashWindow, setFlashWindow] = useState<TimeWindow | null>(null);
  const attachmentKeyRef = useRef(0);
  const grabKeyRef = useRef(0);
  const promptInputRef = useRef<HTMLInputElement>(null);
  const [grabConfirmed, setGrabConfirmed] = useState<number | null>(null);
  const [continueAction, setContinueAction] = useState<ContinueAction>("edit");
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const uploadXhrRef = useRef<XMLHttpRequest | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const [frameReply, setFrameReply] = useState<FrameReply | null>(null);
  const [editedNote, setEditedNote] = useState<string | null>(null);
  const [presetLength, setPresetLength] = useState(10);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const isScrubbingRef = useRef(false);
  const grabOnSeekRef = useRef(false);
  const ignorePauseRef = useRef(false);
  const seekOnLoadRef = useRef<number | null>(null);
  const openRequestRef = useRef(0);
  const openProjectIdRef = useRef<string | null>(null);

  const isEditorOpen = openProjectId !== null;
  const isContinueMode = isEditorOpen;
  const isEditing = editingAt !== null;
  const openItem = history.find((item) => item.projectId === openProjectId);
  const openTitle = project?.title ?? openItem?.title ?? "project";
  const duration = videoDuration > 0 ? videoDuration : project?.durationSeconds ?? 0;
  const lastFrame = project?.frames[project.frames.length - 1];
  const timelineTotal = Math.max(duration, lastFrame ? lastFrame.startSec + lastFrame.durationSec : 0, 0.001);
  const targetSec = grab?.atSec ?? currentTime;
  const targetFrame = project ? frameIndexAt(project.frames, targetSec) : 0;
  const isStoryboardProject = project?.kind === "storyboard";
  const isAppendMode = isContinueMode && continueAction === "append";
  const editWindow = project && isContinueMode && !isAppendMode ? range ?? defaultRange(project.frames, targetSec) : null;
  const attachDisabledReason = isContinueMode
    ? isStoryboardProject ? "Append isn't supported for storyboards yet" : continueAction === "edit" ? "Switch to Append shot to add a video" : null
    : null;

  useEffect(() => {
    if (!isEditorOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      openRequestRef.current += 1;
      openProjectIdRef.current = null;
      setOpenProjectId(null);
      setProject(null);
      setProjectError(null);
      setFrameReply(null);
      setGrab(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isEditorOpen]);

  useEffect(() => {
    if (!isGenerating || isEditorOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") generationAbortRef.current?.abort();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isGenerating, isEditorOpen]);

  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    const tick = () => {
      const video = videoRef.current;
      if (video) setCurrentTime(video.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying]);

  async function selectStoryboard(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setStoryboard(null);
    setStoryboardFileName(null);
    setStoryboardError(null);
    setError(null);
    setNarrationMessages([]);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".json")) {
      setStoryboardError("Choose a .json storyboard file.");
      return;
    }
    try {
      setStoryboard(JSON.parse(await file.text()) as unknown);
      setStoryboardFileName(file.name);
    } catch {
      setStoryboardError("The selected file is not valid JSON.");
    }
  }

  function selectMediaType(next: MediaType | null) {
    setMediaType(next);
    setIsMediaMenuOpen(false);
    setError(null);
    setNarrationMessages([]);
  }

  const attachmentReady = attachment?.status === "done";
  const attachmentBlocking = attachment !== null && attachment.status !== "done";
  const canSubmit = attachmentBlocking
    ? false
    : isAppendMode
    ? Boolean(project) && !isEditing && !isStoryboardProject && (attachmentReady || Boolean(prompt.trim()))
    : isContinueMode
    ? Boolean(project) && !isEditing && Boolean(prompt.trim())
    : attachmentReady
    ? !isGenerating
    : !isGenerating && (mediaType === "storyboard" ? Boolean(storyboard) : mediaType === "rawtree" ? true : Boolean(prompt.trim()));
  const latestClip = history.find((item) => item.kind === "clip");
  const clipCopy = latestClip ? `${latestClip.durationSeconds}-second` : "short";

  function submitComposer(event: FormEvent<HTMLFormElement>) {
    if (isAppendMode) return appendShot(event);
    if (isContinueMode) return askFrame(event);
    if (attachment) return createFromUpload(event);
    return generateMedia(event);
  }

  /* ---- Video attachments ---- */

  function clearAttachment() {
    uploadXhrRef.current?.abort();
    uploadXhrRef.current = null;
    setAttachment((current) => {
      if (current) URL.revokeObjectURL(current.previewUrl);
      return null;
    });
  }

  function attachFile(file: File) {
    setError(null);
    setNotice(null);
    if (attachDisabledReason && !(isContinueMode && continueAction === "edit" && !isStoryboardProject)) {
      setError(attachDisabledReason);
      return;
    }
    if (!isVideoFile(file)) {
      setError(`“${file.name}” isn't a supported video. Attach an MP4, MOV, WebM, or M4V file.`);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`“${file.name}” is ${formatBytes(file.size)}. Videos can be at most 200 MB.`);
      return;
    }
    clearAttachment();
    if (isContinueMode) setContinueAction("append");
    else setMediaType(null);
    setIsMediaMenuOpen(false);

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

  function onFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) attachFile(file);
  }

  function openFilePicker() {
    if (attachDisabledReason) {
      setError(attachDisabledReason);
      return;
    }
    fileInputRef.current?.click();
  }

  function hasFiles(event: DragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function onComposerDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }

  function onComposerDragOver(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = attachDisabledReason ? "none" : "copy";
  }

  function onComposerDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  }

  function onComposerDrop(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    const file = Array.from(event.dataTransfer.files).find(isVideoFile) ?? event.dataTransfer.files[0];
    if (!file) return;
    if (isContinueMode && continueAction === "edit" && !isStoryboardProject) setContinueAction("append");
    attachFile(file);
  }

  function onComposerPaste(event: ClipboardEvent<HTMLDivElement>) {
    const file = Array.from(event.clipboardData.files).find(isVideoFile);
    if (!file) return;
    event.preventDefault();
    if (isContinueMode && continueAction === "edit" && !isStoryboardProject) setContinueAction("append");
    attachFile(file);
  }

  function selectContinueAction(next: ContinueAction) {
    if (next === "append" && isStoryboardProject) return;
    if (next === "edit" && attachment) clearAttachment();
    setContinueAction(next);
    setError(null);
  }

  async function createFromUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const upload = attachment?.upload;
    if (!canSubmit || !upload) return;

    const promptText = prompt.trim();
    const controller = new AbortController();
    generationAbortRef.current = controller;
    setIsGenerating(true);
    setGeneratingKind("upload");
    setError(null);
    setNotice(null);
    setNarrationMessages([]);
    try {
      const response = await fetch("/api/projects/from-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(promptText ? { uploadId: upload.id, prompt: promptText } : { uploadId: upload.id }),
        signal: controller.signal,
      });
      const result = await readJson<{ project?: unknown; error?: unknown }>(response, `Could not import the video (HTTP ${response.status}).`);
      if (!response.ok) {
        console.error(`[generate] /api/projects/from-upload failed with HTTP ${response.status}`, result);
        throw new Error(errorMessage(result, "Could not import the video."));
      }
      if (!isProject(result.project)) throw new Error("The server did not return a project for the uploaded video.");
      const item = historyItemFromProject(result.project, "upload", promptText || upload.filename);
      updateHistory((items) => [item, ...items.filter((existing) => existing.projectId !== item.projectId)]);
      setPrompt("");
      clearAttachment();
      void openProject(item);
    } catch (caughtError) {
      if (controller.signal.aborted || isAbortError(caughtError)) {
        setNotice("Import cancelled");
        return;
      }
      console.error("[generate] import from upload failed", caughtError);
      setError(caughtError instanceof Error ? caughtError.message : "Could not import the video.");
    } finally {
      if (generationAbortRef.current === controller) generationAbortRef.current = null;
      setIsGenerating(false);
    }
  }

  async function generateMedia(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    const kind: HistoryKind = mediaType ?? "clip";
    const promptText = prompt.trim();
    const lengthSec = presetLength;
    const failureLabel = kind === "rawtree" ? "The competitor summary failed." : kind === "storyboard" ? "Storyboard rendering failed." : kind === "ad" ? "The ad could not be created." : kind === "company" ? "The company short could not be created." : "Video generation failed.";
    const controller = new AbortController();
    generationAbortRef.current = controller;
    setIsGenerating(true);
    setGeneratingKind(kind);
    setError(null);
    setNotice(null);
    setNarrationMessages([]);
    try {
      const endpoint = kind === "rawtree" ? "/api/slop-video" : kind === "storyboard" ? "/api/render-storyboard" : kind === "ad" || kind === "company" ? "/api/generate-preset" : "/api/generate-video";
      const requestBody = kind === "rawtree" ? {}
        : kind === "storyboard" ? storyboard
        : kind === "ad" ? { preset: "ad", prompt: promptText, durationSec: lengthSec, aspect: "16:9" }
        : kind === "company" ? { preset: "company", prompt: promptText, durationSec: lengthSec }
        : { prompt: promptText };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      const result = await readJson<RenderResult>(response);
      if (!response.ok) {
        console.error(`[generate] ${endpoint} failed with HTTP ${response.status}`, result);
        const messages = issueMessages(result.details);
        if (kind === "storyboard" && errorMessage(result, "") === "Narration requires review." && messages.length > 0) {
          setNarrationMessages(messages);
        }
        throw new Error(errorMessage(result, failureLabel));
      }
      if (typeof result.videoUrl !== "string") throw new Error("The generation did not return a video.");

      const durationSeconds = typeof result.durationSeconds === "number" ? result.durationSeconds : isProject(result.project) ? result.project.durationSeconds : 0;
      if ((kind === "storyboard" || kind === "ad" || kind === "company") && result.narrationAvailable === false) {
        setNarrationMessages(["Narration could not be generated on this system; the video was rendered without it."]);
      }
      if (!isProject(result.project)) {
        console.error("[generate] response did not include a project; it cannot be added to history", result);
        throw new Error("The video rendered, but the server did not return a project to save in history.");
      }
      const created = result.project;
      const item: HistoryItem = {
        projectId: created.id,
        title: created.title || (kind === "clip" || kind === "ad" || kind === "company" ? promptText || kindLabel(kind) : kindLabel(kind)),
        videoUrl: created.videoUrl || result.videoUrl,
        thumbUrl: created.frames[0]?.imageUrl ?? "",
        durationSeconds,
        createdAt: created.createdAt || new Date().toISOString(),
        kind,
      };
      updateHistory((items) => [item, ...items.filter((existing) => existing.projectId !== item.projectId)]);
      if (kind === "ad" || kind === "company") {
        setPrompt("");
        void openProject(item);
      }
    } catch (caughtError) {
      if (controller.signal.aborted || isAbortError(caughtError)) {
        setNotice("Generation cancelled");
        return;
      }
      console.error("[generate] generation failed", caughtError);
      setError(caughtError instanceof Error ? caughtError.message : failureLabel);
    } finally {
      if (generationAbortRef.current === controller) generationAbortRef.current = null;
      setIsGenerating(false);
    }
  }

  function resetPlayer() {
    setCurrentTime(0);
    setVideoDuration(0);
    setIsPlaying(false);
    setGrab(null);
    setRange(null);
    setFrameReply(null);
    setEditedNote(null);
    seekOnLoadRef.current = null;
  }

  function setRange(next: TimeWindow | null) {
    rangeRef.current = next;
    setRangeState(next);
  }

  function showRangeLimit(message: string | null) {
    if (!message) return;
    setRangeLimit(message);
    if (rangeLimitTimerRef.current !== null) window.clearTimeout(rangeLimitTimerRef.current);
    rangeLimitTimerRef.current = window.setTimeout(() => setRangeLimit(null), 1400);
  }

  function applyRange(start: number, end: number, keep: "start" | "end" | "length") {
    if (!project) return null;
    const { range: next, limit } = clampRange(project.frames, start, end, keep);
    setRange(next);
    showRangeLimit(limit);
    return next;
  }

  async function openProject(item: HistoryItem) {
    const requestId = ++openRequestRef.current;
    openProjectIdRef.current = item.projectId;
    setOpenProjectId(item.projectId);
    setProject(null);
    setProjectError(null);
    resetPlayer();
    setContinueAction(attachment ? "append" : "edit");
    setIsMediaMenuOpen(false);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(item.projectId)}`);
      const result = await readJson<{ project?: unknown; error?: unknown }>(response, `Could not load this project (HTTP ${response.status}).`);
      if (!response.ok) {
        console.error(`[editor] loading project ${item.projectId} failed with HTTP ${response.status}`, result);
        throw new Error(errorMessage(result, "Could not load this project."));
      }
      if (!isProject(result.project)) throw new Error("The server did not return a project.");
      if (requestId === openRequestRef.current) setProject(result.project);
    } catch (caughtError) {
      console.error("[editor] could not open project", caughtError);
      if (requestId === openRequestRef.current) setProjectError(caughtError instanceof Error ? caughtError.message : "Could not load this project.");
    }
  }

  function closeEditor() {
    openRequestRef.current += 1;
    openProjectIdRef.current = null;
    setOpenProjectId(null);
    setProject(null);
    setProjectError(null);
    resetPlayer();
  }

  /* ---- Player ---- */

  function grabCurrentFrame(options: { confirm?: boolean; focusComposer?: boolean } = {}) {
    const video = videoRef.current;
    if (!video || !project) return;
    const atSec = video.currentTime;
    const key = ++grabKeyRef.current;
    const frameImage = project.frames.find((frame) => frame.index === frameIndexAt(project.frames, atSec))?.imageUrl ?? null;
    const setThumb = (thumbUrl: string) => setGrab((current) => current && current.key === key ? { ...current, thumbUrl, captured: true } : current);

    // The grab itself never waits for the thumbnail; the frame image is the fallback.
    setGrab({ key, atSec, thumbUrl: frameImage, captured: false });
    const currentRange = rangeRef.current;
    if (!currentRange || atSec < currentRange.startSec - 1e-3 || atSec > currentRange.endSec + 1e-3) setRange(defaultRange(project.frames, atSec));
    const immediate = captureVideoThumb(video);
    if (immediate) {
      setThumb(immediate);
    } else {
      let done = false;
      const retry = () => {
        if (done) return;
        done = true;
        const later = captureVideoThumb(video);
        if (later) setThumb(later);
      };
      const withFrameCallback = video as HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };
      withFrameCallback.requestVideoFrameCallback?.(() => retry());
      video.addEventListener("seeked", retry, { once: true });
      video.currentTime = atSec;
    }
    if (options.confirm) {
      setGrabConfirmed(key);
      window.setTimeout(() => setGrabConfirmed((current) => current === key ? null : current), 1500);
    }
    if (options.focusComposer) promptInputRef.current?.focus({ preventScroll: true });
  }

  function pauseQuietly() {
    const video = videoRef.current;
    if (!video || video.paused) return;
    ignorePauseRef.current = true;
    video.pause();
  }

  function seekTo(seconds: number, grabAfterSeek: boolean) {
    const video = videoRef.current;
    const clamped = Math.min(Math.max(0, seconds), Math.max(0, duration - 0.001));
    setCurrentTime(clamped);
    if (!video) return;
    grabOnSeekRef.current = grabAfterSeek;
    video.currentTime = clamped;
  }

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch((caughtError: unknown) => console.error("[editor] video playback failed", caughtError));
    } else {
      video.pause();
    }
  }

  function secondsFromPointer(clientX: number) {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return ((clientX - rect.left) / rect.width) * timelineTotal;
  }

  function onTimelinePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!duration || !project) return;
    const handle = (event.target as HTMLElement).closest<HTMLElement>("[data-range-drag]")?.dataset.rangeDrag;
    event.currentTarget.setPointerCapture(event.pointerId);
    pauseQuietly();
    const at = secondsFromPointer(event.clientX);
    const editable = isContinueMode && !isAppendMode;
    if (editable && (handle === "start" || handle === "end" || handle === "move") && editWindow) {
      rangeDragRef.current = { mode: handle, startX: event.clientX, anchorSec: at, original: editWindow, moved: false, pointerId: event.pointerId };
      return;
    }
    rangeDragRef.current = { mode: "new", startX: event.clientX, anchorSec: at, original: null, moved: false, pointerId: event.pointerId };
    isScrubbingRef.current = true;
    seekTo(at, false);
  }

  function onTimelinePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = rangeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const at = secondsFromPointer(event.clientX);
    if (!drag.moved && Math.abs(event.clientX - drag.startX) > 4) drag.moved = true;
    if (drag.mode === "new") {
      if (drag.moved && isContinueMode && !isAppendMode) {
        isScrubbingRef.current = false;
        applyRange(drag.anchorSec, at, at >= drag.anchorSec ? "start" : "end");
      } else if (!drag.moved) {
        seekTo(at, false);
      }
      return;
    }
    const original = drag.original;
    if (!original || !drag.moved) return;
    if (drag.mode === "start") applyRange(Math.min(at, original.endSec - RANGE_MIN_SEC / 2), original.endSec, "end");
    else if (drag.mode === "end") applyRange(original.startSec, Math.max(at, original.startSec + RANGE_MIN_SEC / 2), "start");
    else {
      const delta = at - drag.anchorSec;
      applyRange(original.startSec + delta, original.endSec + delta, "length");
    }
  }

  function onTimelinePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = rangeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    rangeDragRef.current = null;
    isScrubbingRef.current = false;
    if (drag.mode === "new" && !drag.moved) {
      seekTo(secondsFromPointer(event.clientX), true);
      return;
    }
    // A drawn or adjusted range: park the playhead on its start and grab that frame for the preview.
    const current = rangeRef.current;
    if (current) seekTo(current.startSec, true);
  }

  function onTimelinePointerCancel() {
    rangeDragRef.current = null;
    isScrubbingRef.current = false;
  }

  function onPlayerKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && (event.shiftKey || event.altKey) && project && editWindow) {
      event.preventDefault();
      pauseQuietly();
      const step = (event.key === "ArrowRight" ? 1 : -1) * FRAME_STEP;
      if (event.shiftKey) applyRange(editWindow.startSec, editWindow.endSec + step, "start");
      else applyRange(editWindow.startSec + step, editWindow.endSec, "end");
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      pauseQuietly();
      const video = videoRef.current;
      const base = video ? video.currentTime : currentTime;
      seekTo(base + (event.key === "ArrowRight" ? 1 : -1) / 30, true);
    } else if (event.key === " " && event.target === event.currentTarget) {
      event.preventDefault();
      togglePlay();
    }
  }

  /* ---- Continue editing ---- */

  async function askFrame(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = prompt.trim();
    if (!project || !message || isEditing) return;

    const projectId = project.id;
    const requestedWindow = range ?? defaultRange(project.frames, grab?.atSec ?? videoRef.current?.currentTime ?? currentTime);
    const momentSec = grab?.atSec ?? (range ? (range.startSec + range.endSec) / 2 : videoRef.current?.currentTime ?? currentTime);
    const atSec = Math.round(momentSec * 1000) / 1000;
    const frameIndex = frameIndexAt(project.frames, requestedWindow.startSec);
    pauseQuietly();
    const controller = new AbortController();
    editAbortRef.current = controller;
    setEditingAt(atSec);
    setRange(requestedWindow);
    setBusy({ label: "Updating your video", detail: `Regenerating ${formatWindow(requestedWindow)}…` });
    setError(null);
    setNotice(null);
    setFrameReply(null);
    setEditedNote(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/frames/${frameIndex}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, atSec, rangeStartSec: Math.round(requestedWindow.startSec * 1000) / 1000, rangeEndSec: Math.round(requestedWindow.endSec * 1000) / 1000 }),
        signal: controller.signal,
      });
      const result = await readJson<AskResult>(response, `Frame assistant unavailable (HTTP ${response.status}). The server endpoint isn't ready yet.`);
      if (!response.ok) {
        console.error(`[editor] frame ask failed with HTTP ${response.status}`, result);
        throw new Error(errorMessage(result, `The frame assistant could not answer (HTTP ${response.status}).`));
      }
      if (!isProject(result.project)) throw new Error("The server did not return the updated project.");
      const updated = result.project;
      const edited = result.edited === true;
      if (edited) {
        updateHistory((items) => items.map((item) => item.projectId === projectId ? {
          ...item,
          title: updated.title || item.title,
          videoUrl: updated.videoUrl || item.videoUrl,
          thumbUrl: updated.frames[0]?.imageUrl ?? item.thumbUrl,
          durationSeconds: updated.durationSeconds || item.durationSeconds,
        } : item));
      }
      if (openProjectIdRef.current !== projectId) return;
      setProject(updated);
      setPrompt("");
      const reply = typeof result.reply === "string" ? result.reply.trim() : "";
      const enhancedPrompt = typeof result.enhancedPrompt === "string" && result.enhancedPrompt.trim() ? result.enhancedPrompt.trim() : undefined;
      const grabbedFrameUrl = typeof result.grabbedFrameUrl === "string" && result.grabbedFrameUrl ? result.grabbedFrameUrl : undefined;
      const editedWindow = isTimeWindow(result.window) ? result.window : requestedWindow;
      if (reply || enhancedPrompt || edited) setFrameReply({ atSec, label: edited ? `Updated ${formatWindow(editedWindow)} · video re-rendered` : `At ${atSec.toFixed(1)}s`, text: reply, edited, enhancedPrompt, grabbedFrameUrl });
      if (edited) {
        setEditedNote("Frame updated · video re-rendered");
        setIsPlaying(false);
        setVideoDuration(0);
        seekOnLoadRef.current = editedWindow.startSec;
        setCurrentTime(editedWindow.startSec);
        setVideoReload((current) => current + 1);
        setFlashWindow(editedWindow);
        setRange(editedWindow);
        window.setTimeout(() => setFlashWindow((current) => current === editedWindow ? null : current), 1800);
      }
    } catch (caughtError) {
      if (controller.signal.aborted || isAbortError(caughtError)) {
        setNotice("Edit cancelled");
        return;
      }
      console.error("[editor] frame ask failed", caughtError);
      if (openProjectIdRef.current !== projectId) return;
      setError(caughtError instanceof Error ? caughtError.message : "The frame assistant could not answer.");
    } finally {
      if (editAbortRef.current === controller) editAbortRef.current = null;
      setEditingAt(null);
      setBusy(null);
    }
  }

  async function appendShot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || !canSubmit) return;
    const promptText = prompt.trim();
    const upload = attachment?.status === "done" ? attachment.upload : undefined;
    if (!promptText && !upload) return;

    const projectId = project.id;
    pauseQuietly();
    const controller = new AbortController();
    editAbortRef.current = controller;
    setEditingAt(project.durationSeconds);
    setBusy({ label: "Appending to your video", detail: upload ? "Adding your clip…" : "Generating the next shot…" });
    setError(null);
    setNotice(null);
    setFrameReply(null);
    setEditedNote(null);
    try {
      const body: { uploadId?: string; prompt?: string } = {};
      if (upload) body.uploadId = upload.id;
      if (promptText) body.prompt = promptText;
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/append`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const result = await readJson<AppendResult>(response, `Append unavailable (HTTP ${response.status}). The server endpoint isn't ready yet.`);
      if (!response.ok) {
        console.error(`[editor] append failed with HTTP ${response.status}`, result);
        throw new Error(errorMessage(result, response.status === 422 ? "Append isn't supported for this project." : `Could not append the shot (HTTP ${response.status}).`));
      }
      if (!isProject(result.project)) throw new Error("The server did not return the updated project.");
      const updated = result.project;
      updateHistory((items) => items.map((item) => item.projectId === projectId ? {
        ...item,
        title: updated.title || item.title,
        videoUrl: updated.videoUrl || item.videoUrl,
        thumbUrl: updated.frames[0]?.imageUrl ?? item.thumbUrl,
        durationSeconds: updated.durationSeconds || item.durationSeconds,
      } : item));
      if (openProjectIdRef.current !== projectId) return;
      const appendedIndex = typeof result.appendedFrameIndex === "number" ? result.appendedFrameIndex : updated.frames.length - 1;
      const appended = updated.frames.find((frame) => frame.index === appendedIndex) ?? updated.frames[updated.frames.length - 1];
      const startSec = appended?.startSec ?? 0;
      setProject(updated);
      setPrompt("");
      clearAttachment();
      const enhancedPrompt = typeof result.enhancedPrompt === "string" && result.enhancedPrompt.trim() ? result.enhancedPrompt.trim() : undefined;
      setFrameReply({
        atSec: startSec,
        label: `Shot ${(appended?.index ?? appendedIndex) + 1} appended at ${startSec.toFixed(1)}s · video re-rendered`,
        text: appended?.source === "upload" ? "Your clip was added to the end of the video." : "",
        edited: true,
        enhancedPrompt,
      });
      setEditedNote("Shot appended · video re-rendered");
      setGrab({ key: ++grabKeyRef.current, atSec: startSec, thumbUrl: appended?.imageUrl ?? null, captured: false });
      setIsPlaying(false);
      setVideoDuration(0);
      seekOnLoadRef.current = startSec;
      setCurrentTime(startSec);
      setVideoReload((current) => current + 1);
    } catch (caughtError) {
      if (controller.signal.aborted || isAbortError(caughtError)) {
        setNotice("Append cancelled");
        return;
      }
      console.error("[editor] append failed", caughtError);
      if (openProjectIdRef.current !== projectId) return;
      setError(caughtError instanceof Error ? caughtError.message : "Could not append the shot.");
    } finally {
      if (editAbortRef.current === controller) editAbortRef.current = null;
      setEditingAt(null);
      setBusy(null);
    }
  }

  const playheadPercent = Math.min(100, (currentTime / timelineTotal) * 100);
  const grabPercent = grab ? Math.min(100, (grab.atSec / timelineTotal) * 100) : null;

  return (
    <main className={`generator ${isEditorOpen ? "editor-open" : ""}`}>
      <aside className="video-panel" aria-label={isEditorOpen ? "Project editor" : "Video history"}>
        <div className="panel-header">
          <div className="brand"><span className="logo-mark">L</span><strong>Longform</strong></div>
          {isEditorOpen && <button className="move-panel close-editor" onClick={closeEditor} aria-label="Close editor">✕ Close</button>}
        </div>

        {isEditorOpen ? (
          <div className="editor">
            <div className="editor-heading">
              <span className="section-label">Editing project</span>
              <h2>{project?.title ?? openItem?.title ?? "Loading project…"}</h2>
            </div>
            {projectError ? (
              <p className="error-message editor-error" role="alert">{projectError}</p>
            ) : !project ? (
              <div className="editor-loading"><BlobLoader label="Loading project" size={160} /></div>
            ) : (
              <div className="editor-body" onKeyDown={onPlayerKeyDown}>
                <div className="frame-stage" tabIndex={0} aria-label="Video player. Space plays or pauses; left and right arrows step one frame." onClick={(event) => { if (event.target === event.currentTarget || event.target === videoRef.current) togglePlay(); }}>
                  <video
                    key={`${project.videoUrl}-${videoReload}`}
                    ref={videoRef}
                    className="stage-media"
                    src={project.videoUrl}
                    poster={project.frames[targetFrame]?.imageUrl ?? project.frames[0]?.imageUrl}
                    preload="auto"
                    playsInline
                    muted={isMuted}
                    onLoadedMetadata={(event) => {
                      const video = event.currentTarget;
                      if (Number.isFinite(video.duration)) setVideoDuration(video.duration);
                      if (seekOnLoadRef.current !== null) {
                        video.currentTime = seekOnLoadRef.current;
                        seekOnLoadRef.current = null;
                      }
                    }}
                    onTimeUpdate={(event) => { if (!isScrubbingRef.current) setCurrentTime(event.currentTarget.currentTime); }}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => {
                      setIsPlaying(false);
                      if (ignorePauseRef.current) {
                        ignorePauseRef.current = false;
                        return;
                      }
                      if (!isScrubbingRef.current) grabCurrentFrame({ confirm: true, focusComposer: true });
                    }}
                    onEnded={() => setIsPlaying(false)}
                    onSeeked={() => {
                      if (!grabOnSeekRef.current) return;
                      grabOnSeekRef.current = false;
                      grabCurrentFrame();
                    }}
                  />
                  {grab && grabConfirmed === grab.key && <span key={`pulse-${grab.key}`} className="stage-pulse" aria-hidden="true" />}
                  {isEditing && <div className="stage-overlay" onClick={(event) => event.stopPropagation()}><div className="stage-overlay-inner"><BlobLoader label={busy?.label ?? "Updating your video"} detail={busy?.detail ?? "Regenerating the frame and re-rendering…"} size={200} /><button type="button" className="cancel-button" onClick={() => editAbortRef.current?.abort()}>Cancel</button></div></div>}
                  {!isEditing && editedNote && <p className="stage-note">{editedNote}</p>}
                </div>

                <div className="player-controls">
                  <button type="button" className="player-button" onClick={togglePlay} aria-label={isPlaying ? "Pause" : "Play"}>{isPlaying ? "❚❚" : "▶"}</button>
                  <span className="player-time">{currentTime.toFixed(1)}s / {duration.toFixed(1)}s</span>
                  <button type="button" className={`sound-toggle ${isMuted ? "" : "on"}`} onClick={() => setIsMuted((current) => !current)} aria-pressed={!isMuted}>{isMuted ? "Sound off" : "Sound on"}</button>
                  <span className="player-spacer" />
                  <button type="button" className={`grab-button ${grab && grabConfirmed === grab.key ? "confirmed" : ""}`} onClick={() => { pauseQuietly(); grabCurrentFrame({ confirm: true, focusComposer: true }); }}>{grab && grabConfirmed === grab.key ? `✓ Grabbed ${grab.atSec.toFixed(1)}s` : grab ? "⌖ Re-grab" : "⌖ Grab this frame"}</button>
                </div>

                <div
                  ref={timelineRef}
                  className="timeline"
                  role="slider"
                  tabIndex={0}
                  aria-label="Timeline"
                  aria-valuemin={0}
                  aria-valuemax={Number(duration.toFixed(2))}
                  aria-valuenow={Number(currentTime.toFixed(2))}
                  aria-valuetext={`${currentTime.toFixed(1)} seconds`}
                  onPointerDown={onTimelinePointerDown}
                  onPointerMove={onTimelinePointerMove}
                  onPointerUp={onTimelinePointerUp}
                  onPointerCancel={onTimelinePointerCancel}
                >
                  {project.frames.map((frame) => {
                    const total = timelineTotal;
                    return (
                      <div
                        key={frame.index}
                        className={`timeline-frame ${frame.index === targetFrame ? "active" : ""}`}
                        style={{ left: `${(frame.startSec / total) * 100}%`, width: `${(frame.durationSec / total) * 100}%`, backgroundImage: `url("${frame.imageUrl}")` }}
                        title={`Frame ${frame.index + 1} · ${formatSeconds(frame.startSec)}–${formatSeconds(frame.startSec + frame.durationSec)}`}
                      >
                        <span>#{frame.index + 1}{frame.source === "upload" && <b className="upload-badge" title="Uploaded clip">⬆</b>}</span>
                      </div>
                    );
                  })}
                  {project.frames.flatMap((frame) => (frame.edits ?? []).map((edit, editIndex) => {
                    const past = typeof edit.rangeStartSec === "number" && typeof edit.rangeEndSec === "number" ? { startSec: edit.rangeStartSec, endSec: edit.rangeEndSec } : editWindowFor(project.frames, edit.atSec, edit.windowSec ?? 1);
                    const total = timelineTotal;
                    return <span key={`${frame.index}-${editIndex}-${edit.at}`} className="timeline-edit" style={{ left: `${(past.startSec / total) * 100}%`, width: `${((past.endSec - past.startSec) / total) * 100}%` }} title={`Edited ${formatWindow(past)} · ${edit.prompt}`} />;
                  }))}
                  {editWindow && (
                    <span className={`timeline-window ${range ? "selected" : "suggested"}`} data-range-drag="move" style={{ left: `${(editWindow.startSec / timelineTotal) * 100}%`, width: `${((editWindow.endSec - editWindow.startSec) / timelineTotal) * 100}%` }} title={`${formatRange(editWindow)} — drag to move, drag the edges to resize`}>
                      <span className="range-handle start" data-range-drag="start" aria-hidden="true" />
                      <span className="range-handle end" data-range-drag="end" aria-hidden="true" />
                      {rangeLimit && <span className="range-limit" role="status">{rangeLimit}</span>}
                    </span>
                  )}
                  {flashWindow && <span key={`${flashWindow.startSec}-${flashWindow.endSec}`} className="timeline-flash" style={{ left: `${(flashWindow.startSec / timelineTotal) * 100}%`, width: `${((flashWindow.endSec - flashWindow.startSec) / timelineTotal) * 100}%` }} aria-hidden="true" />}
                  {grab && grabPercent !== null && <span key={`grab-${grab.key}`} className={`timeline-grab ${grabConfirmed === grab.key ? "pulse" : ""}`} style={{ left: `${grabPercent}%` }} aria-hidden="true"><em>{grab.atSec.toFixed(1)}s</em></span>}
                  <span className="timeline-playhead" style={{ left: `${playheadPercent}%` }} aria-hidden="true"><i /></span>
                </div>

                {(range || grab) && (
                  <div className={`grab-card ${grab && grabConfirmed === grab.key ? "fresh" : ""}`}>
                    {grab?.thumbUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={grab.thumbUrl} alt={`Frame at ${grab.atSec.toFixed(1)}s`} />
                    ) : range && project.frames[frameIndexAt(project.frames, range.startSec)] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={project.frames[frameIndexAt(project.frames, range.startSec)].imageUrl} alt="" />
                    ) : <span className="grab-card-empty" />}
                    <div>
                      <span className="section-label">Selected range</span>
                      <strong>{isAppendMode ? `${(grab?.atSec ?? 0).toFixed(1)}s` : editWindow ? formatWindow(editWindow) : ""}</strong>
                      <small>{isAppendMode ? "Append mode adds to the end instead" : editWindow ? `${(editWindow.endSec - editWindow.startSec).toFixed(1)}s long · shot ${frameIndexAt(project.frames, editWindow.startSec) + 1} · drag the edges to adjust` : ""}</small>
                    </div>
                    <button type="button" className="play-toggle" onClick={() => { setGrab(null); setRange(null); }}>Clear</button>
                  </div>
                )}
                <div className="editor-meta">
                  <p className="video-meta">{project.durationSeconds} second MP4 · {project.frames.length} frame{project.frames.length === 1 ? "" : "s"} · {kindLabel(openItem?.kind ?? project.kind)} · drag on the strip to select a range · ←/→ step 1/30s · Shift/Alt+←/→ adjust range end/start</p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
            {isGenerating && (
              <div className="generating-card">
                <BlobLoader
                  label={generatingKind === "rawtree" ? "Summarizing competitor moves" : generatingKind === "storyboard" ? "Rendering your storyboard" : generatingKind === "upload" ? "Importing your video" : generatingKind === "ad" ? "Creating your ad" : generatingKind === "company" ? "Creating your company short" : "Preparing your video"}
                  detail={generatingKind === "upload" ? "Preparing frames from your clip…" : generatingKind === "rawtree" ? "Reading the latest competitor data from RawTree and rendering a short…" : generatingKind === "storyboard" ? "Rendering scenes, motion, overlays, and narration…" : generatingKind === "ad" ? "Writing your ad and rendering scenes… this takes 1–3 minutes." : generatingKind === "company" ? "Writing your story and rendering scenes… this takes 1–3 minutes." : `Generating a ${clipCopy} clip with sound…`}
                  size={200}
                />
                <button type="button" className="cancel-button" onClick={() => generationAbortRef.current?.abort()}>Cancel <kbd>Esc</kbd></button>
              </div>
            )}
            <div className="history">
              <button type="button" className={`history-toggle ${isHistoryOpen ? "open" : ""}`} aria-expanded={isHistoryOpen} aria-controls="history-list" onClick={() => setHistoryOpen(!isHistoryOpen)}>
                <span className="section-label">History ({history.length})</span>
                <span className="chevron" aria-hidden="true">›</span>
              </button>
              <div id="history-list" className={`history-collapse ${isHistoryOpen ? "open" : ""}`} inert={!isHistoryOpen}>
                <div className="history-collapse-inner">
                  {history.length === 0 ? (
                    <p className="history-empty">Finished videos are saved here. Click one to edit it frame by frame.</p>
                  ) : (
                    <ul className="history-list">
                      {history.map((item) => (
                        <li key={item.projectId}>
                          <button type="button" className={`history-item ${item.projectId === openProjectId ? "active" : ""}`} onClick={() => openProject(item)} title={`Open “${item.title}” in the editor`}>
                            <span className="history-thumb">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              {item.thumbUrl ? <img src={item.thumbUrl} alt="" loading="lazy" /> : <span>▶</span>}
                              <em>{item.durationSeconds}s</em>
                            </span>
                            <span className="history-text">
                              <strong>{item.title}</strong>
                              <small>{kindLabel(item.kind)} · {formatWhen(item.createdAt)}</small>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
            <p className="panel-note">Generated files remain local in <code>output/</code>.</p>
          </>
        )}
      </aside>

      <section className="prompt-stage">
        <div className="prompt-content">
          <span className="eyebrow">AI video studio</span>
          <h1>What&apos;s on your mind today?</h1>
          <p>Describe a moment and get a {clipCopy} video. Or use + to make an ad, a company short, or a competitor summary.</p>
          <div
            className={`composer ${isDragOver ? "drag-over" : ""} ${isDragOver && attachDisabledReason && !(isContinueMode && continueAction === "edit" && !isStoryboardProject) ? "drag-blocked" : ""}`}
            onDragEnter={onComposerDragEnter}
            onDragOver={onComposerDragOver}
            onDragLeave={onComposerDragLeave}
            onDrop={onComposerDrop}
            onPaste={onComposerPaste}
          >
            {isDragOver && <div className="drop-hint" aria-hidden="true">{isStoryboardProject && isContinueMode ? "Append isn't supported for storyboards yet" : isContinueMode ? "Drop to append this video to the end" : "Drop a video to start from your own footage"}</div>}
            <input ref={fileInputRef} type="file" accept={VIDEO_ACCEPT} hidden onChange={onFileInputChange} />
            {isContinueMode && (
              <div className="continue-bar">
                <div className="segmented" role="radiogroup" aria-label="What to do with your message">
                  <button type="button" role="radio" aria-checked={continueAction === "edit"} className={continueAction === "edit" ? "selected" : ""} onClick={() => selectContinueAction("edit")}>Edit moment</button>
                  <span title={isStoryboardProject ? "Append isn't supported for storyboards yet" : undefined}>
                    <button type="button" role="radio" aria-checked={continueAction === "append"} className={continueAction === "append" ? "selected" : ""} disabled={isStoryboardProject} onClick={() => selectContinueAction("append")}>Append shot</button>
                  </span>
                </div>
              <div className="continue-chip">
                {!isAppendMode && grab?.thumbUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={grab.thumbUrl} alt="" />
                )}
                <span>Editing: <strong>{openTitle}</strong> · {isAppendMode ? `end (${(project?.durationSeconds ?? 0).toFixed(1)}s)` : `${editWindow ? formatRange(editWindow) : `${targetSec.toFixed(1)}s`}${range ? "" : " (suggested)"}`}</span>
                <button type="button" onClick={closeEditor} aria-label="Stop editing and close the editor">✕</button>
              </div>
              </div>
            )}
            {isContinueMode && frameReply && (
              <div className={`frame-reply ${frameReply.edited ? "edited" : ""}`} role="status">
                {frameReply.grabbedFrameUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="frame-reply-thumb" src={frameReply.grabbedFrameUrl} alt={`Frame at ${frameReply.atSec.toFixed(1)}s`} />
                )}
                <div className="frame-reply-body">
                  <span className="frame-reply-label">{frameReply.label}</span>
                  {frameReply.text && <p>{frameReply.text}</p>}
                  {frameReply.enhancedPrompt && <details><summary>Enhanced prompt</summary><p>{frameReply.enhancedPrompt}</p></details>}
                </div>
                <button type="button" onClick={() => setFrameReply(null)} aria-label="Dismiss reply">✕</button>
              </div>
            )}
            {attachment && (
              <div className={`attachment-chip ${attachment.status}`}>
                <span className="attachment-thumb">
                  {attachment.upload?.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={attachment.upload.thumbUrl} alt="" />
                  ) : (
                    <video src={attachment.previewUrl} muted playsInline preload="metadata" onLoadedMetadata={(event) => {
                      const seconds = event.currentTarget.duration;
                      if (Number.isFinite(seconds)) setAttachment((current) => current && current.key === attachment.key ? { ...current, localDuration: seconds } : current);
                    }} />
                  )}
                </span>
                <span className="attachment-info">
                  <strong title={attachment.file.name}>{attachment.upload?.filename ?? attachment.file.name}</strong>
                  <small>
                    {attachment.status === "error" ? attachment.error : attachment.status === "uploading" ? `Uploading… ${Math.round(attachment.progress * 100)}% · ${formatBytes(attachment.file.size)}` : `${(attachment.upload?.durationSeconds ?? attachment.localDuration ?? 0).toFixed(1)}s · ${formatBytes(attachment.file.size)}${attachment.upload?.hasAudio ? " · sound" : ""}`}
                  </small>
                  {attachment.status === "uploading" && <span className="attachment-progress" aria-hidden="true"><i style={{ width: `${Math.max(3, attachment.progress * 100)}%` }} /></span>}
                </span>
                <button type="button" onClick={clearAttachment} aria-label={attachment.status === "uploading" ? "Cancel upload" : "Remove attached video"}>✕</button>
              </div>
            )}
            <form className={`prompt-form ${isContinueMode ? "continue" : ""}`} onSubmit={submitComposer}>
              {!isContinueMode && <div className="media-selector">
                <button className="add-button" type="button" aria-label="Choose another source" aria-expanded={isMediaMenuOpen} onClick={() => setIsMediaMenuOpen((open) => !open)}>+</button>
              </div>}
              <span className="attach-wrap" title={attachDisabledReason ?? "Attach a video (MP4, MOV, WebM, M4V · max 200 MB)"}>
                <button className="attach-button" type="button" aria-label="Attach a video" aria-disabled={attachDisabledReason !== null} onClick={openFilePicker}>
                  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M21.4 11.1 12.2 20.3a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </span>
              <input
                ref={promptInputRef}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={isAppendMode ? "Describe the next shot, or attach a video to add to the end…" : attachment && !isContinueMode ? "Optional: describe your video…" : isContinueMode ? `Continue editing at ${targetSec.toFixed(1)}s — describe what to change or ask about it…` : mediaType === "storyboard" ? "Storyboard file selected below" : mediaType === "rawtree" ? "No prompt needed — uses the latest competitor data" : mediaType === "ad" ? "Describe the product or offer to advertise…" : mediaType === "company" ? "Tell us about your company — what you do and for whom…" : `Describe your ${clipCopy} video`}
                aria-label={isContinueMode ? `Edit or ask about the moment at ${targetSec.toFixed(1)} seconds` : "Video idea"}
                maxLength={isContinueMode ? 4000 : 32000}
                disabled={!isContinueMode && !attachment && (mediaType === "storyboard" || mediaType === "rawtree")}
              />
              <button className="generate-button" aria-label={isAppendMode ? "Append shot" : isContinueMode ? "Send edit or question" : attachment ? "Import attached video" : mediaType === "storyboard" ? "Render storyboard" : mediaType === "rawtree" ? "Create competitor summary" : mediaType === "ad" ? "Create ad" : mediaType === "company" ? "Create company short" : "Generate quick clip"} disabled={!canSubmit}>{(isContinueMode ? isEditing : isGenerating) ? <span className="spinner" /> : "↟"}</button>
            </form>
            {!isContinueMode && mediaType && <div className="source-chip"><span>{mediaType === "storyboard" ? "☷ Storyboard file" : mediaType === "rawtree" ? "◎ Competitor summary" : mediaType === "ad" ? "✦ New ad" : "◆ Company short"}</span><button type="button" onClick={() => selectMediaType(null)} aria-label="Back to quick clip">✕</button></div>}
            {!isContinueMode && isPreset(mediaType) && (
              <div className="segmented length-select" role="radiogroup" aria-label="Video length">
                {PRESET_LENGTHS.map((length) => <button key={length} type="button" role="radio" aria-checked={presetLength === length} className={presetLength === length ? "selected" : ""} onClick={() => setPresetLength(length)}>{length}s</button>)}
              </div>
            )}
            {!isContinueMode && mediaType === "storyboard" && <label className="storyboard-picker"><span><strong>Storyboard file</strong><small>Choose a local JSON file. Try <code>storyboards/mock_changes.json</code>; browsers cannot select it automatically.</small></span><input type="file" accept=".json,application/json" onChange={selectStoryboard} aria-describedby="storyboard-file-status" /><span id="storyboard-file-status" className={storyboardError ? "file-error" : storyboardFileName ? "file-success" : ""}>{storyboardError ?? (storyboardFileName ? `${storyboardFileName} is valid JSON.` : "No file selected.")}</span></label>}
            {!isContinueMode && isMediaMenuOpen && <div className="media-menu">
              <button type="button" className={mediaType === null ? "selected" : ""} onClick={() => selectMediaType(null)}><span className="media-icon">▶</span><span><strong>Quick clip</strong><small>A {clipCopy} clip from your prompt</small></span></button>
              <button type="button" className={mediaType === "rawtree" ? "selected" : ""} onClick={() => selectMediaType("rawtree")}><span className="media-icon">◎</span><span><strong>Competitor summary</strong><small>A short summary of the latest competitor moves (RawTree)</small></span></button>
              <button type="button" className={mediaType === "ad" ? "selected" : ""} onClick={() => selectMediaType("ad")}><span className="media-icon">✦</span><span><strong>New ad</strong><small>A multi-scene ad from your product or offer</small></span></button>
              <button type="button" className={mediaType === "company" ? "selected" : ""} onClick={() => selectMediaType("company")}><span className="media-icon">◆</span><span><strong>Company short</strong><small>A short brand video about your company</small></span></button>
              <div className="media-menu-divider">Advanced</div>
              <button type="button" className={mediaType === "storyboard" ? "selected" : ""} onClick={() => selectMediaType("storyboard")}><span className="media-icon">☷</span><span><strong>Storyboard file</strong><small>Render a structured JSON storyboard</small></span></button>
            </div>}
          </div>
          {isGenerating && !isContinueMode && <div className="inline-generating"><BlobLoader label={mediaType === "ad" ? "Creating your ad" : mediaType === "company" ? "Creating your company short" : "Preparing your video"} size={140} /><button type="button" className="cancel-button" onClick={() => generationAbortRef.current?.abort()}>Cancel</button></div>}
          {error && <p className="error-message" role="alert">{error}</p>}
          {notice && !error && <p className="cancel-note" role="status">{notice}</p>}
          {narrationMessages.length > 0 && <section className="narration-message" aria-live="polite"><strong>Narration review</strong><ul>{narrationMessages.map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}</ul></section>}
          <p className="hint">{isAppendMode ? `Adds a new shot at the end of “${openTitle}”: attach a video to append it as-is, or describe the next shot to generate it. Esc or ✕ goes back to new videos.` : !isContinueMode && attachment ? "Your video becomes a new project you can edit moment by moment or extend with more shots. A prompt is optional." : isContinueMode ? `Your message applies to ${editWindow ? formatWindow(editWindow) : `${targetSec.toFixed(1)}s`} of “${openTitle}” (frame ${targetFrame + 1}) — drag on the timeline strip to choose exactly which part to change. Describe a change to regenerate it and re-render the${project ? ` ${project.durationSeconds}s` : ""} video, or ask a question about it. Pause or use “Grab this frame” to pick a moment; Esc or ✕ goes back to new videos.` : <>{mediaType === "rawtree" ? "Summarizes the latest competitor moves from RawTree into a short video. No prompt needed." : mediaType === "ad" ? `Writes a ${presetLength}-second multi-scene ad (16:9) from your product or offer, then opens it in the editor. Takes 1–3 minutes.` : mediaType === "company" ? `Writes a ${presetLength}-second brand video about your company, then opens it in the editor. Takes 1–3 minutes.` : mediaType === "storyboard" ? "Select a valid local storyboard JSON file before rendering. Narration warnings must be reviewed before the server will render." : `Every prompt becomes a ${clipCopy} video with sound. Use + for ads, company shorts, or competitor summaries — or attach, drop, or paste a video to start from your own footage.`} Your BFL key stays on the server.</>}</p>
        </div>
      </section>
    </main>
  );
}
