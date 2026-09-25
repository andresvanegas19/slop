/* Pure helpers for the studio (moved verbatim from app/page.tsx). */
import type { HistoryItem, HistoryKind, MediaType, MemoryChip, PresetType, Project, ProjectFrame, RenderIssue, ThreadEntry, TimeWindow, Upload } from "./types";

export const HISTORY_KEY = "longform.history.v1";
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".m4v"];
export const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm,video/x-m4v,.mp4,.mov,.webm,.m4v";
export const HISTORY_LIMIT = 50;
export const EMPTY_HISTORY: HistoryItem[] = [];

export function errorMessage(result: { error?: unknown }, fallback: string) {
  return typeof result.error === "string" ? result.error : fallback;
}

export function issueMessages(details: unknown) {
  if (!Array.isArray(details)) return [];
  return details.flatMap((detail) => {
    if (!detail || typeof detail !== "object") return [];
    const issue = detail as RenderIssue;
    return typeof issue.message === "string" ? [issue.message] : [];
  });
}

export function isProject(value: unknown): value is Project {
  if (!value || typeof value !== "object") return false;
  const project = value as Partial<Project>;
  return typeof project.id === "string" && typeof project.videoUrl === "string" && Array.isArray(project.frames);
}

export function isHistoryItem(value: unknown): value is HistoryItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<HistoryItem>;
  return typeof item.projectId === "string" && typeof item.videoUrl === "string" && typeof item.createdAt === "string";
}

export function formatSeconds(seconds: number) {
  const whole = Math.max(0, seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

export function formatWhen(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function kindLabel(kind: HistoryKind) {
  return kind === "rawtree" ? "Competitor summary" : kind === "storyboard" ? "Storyboard render" : kind === "upload" ? "Uploaded video" : kind === "ad" ? "Ad" : kind === "company" ? "Company" : "Clip";
}

/** Index of the frame whose [startSec, startSec + durationSec) range contains `seconds` (last frame at the very end). */
export function frameIndexAt(frames: ProjectFrame[], seconds: number) {
  if (frames.length === 0) return 0;
  const match = frames.find((frame) => seconds >= frame.startSec && seconds < frame.startSec + frame.durationSec);
  if (match) return match.index;
  return seconds < frames[0].startSec ? frames[0].index : frames[frames.length - 1].index;
}

export async function readJson<T extends object>(response: Response, nonJsonError?: string): Promise<T> {
  const responseText = await response.text();
  try {
    return JSON.parse(responseText) as T;
  } catch {
    console.error(`[api] ${response.url} returned HTTP ${response.status} with a non-JSON body`, responseText.slice(0, 300));
    return { error: nonJsonError ?? `Server returned HTTP ${response.status} with a non-JSON body: ${responseText.slice(0, 300) || "(empty)"}` } as T;
  }
}

export function isUpload(value: unknown): value is Upload {
  if (!value || typeof value !== "object") return false;
  const upload = value as Partial<Upload>;
  return typeof upload.id === "string" && typeof upload.videoUrl === "string";
}

export function isVideoFile(file: File) {
  const name = file.name.toLowerCase();
  return file.type.startsWith("video/") || VIDEO_EXTENSIONS.some((extension) => name.endsWith(extension));
}

export function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function historyItemFromProject(created: Project, kind: HistoryKind, fallbackTitle: string): HistoryItem {
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

export const RANGE_MIN_SEC = 0.3;
export const RANGE_MAX_SEC = 3;
export const FRAME_STEP = 1 / 30;

export function snapSec(seconds: number) {
  return Math.round(seconds * 30) / 30;
}

export function segmentOf(frames: ProjectFrame[], seconds: number): TimeWindow {
  const frame = frames.find((candidate) => candidate.index === frameIndexAt(frames, seconds));
  return frame ? { startSec: frame.startSec, endSec: frame.startSec + frame.durationSec } : { startSec: 0, endSec: Math.max(seconds, 0) + RANGE_MAX_SEC };
}

/**
 * Normalizes a user range: snapped to 1/30s, clamped to the shot containing its start, 0.3s–3s long.
 * `keep` is the edge that stays put ("start" when dragging the end handle, "end" for the start handle, "length" when moving).
 */
export function clampRange(frames: ProjectFrame[], start: number, end: number, keep: "start" | "end" | "length"): { range: TimeWindow; limit: string | null } {
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

export function defaultRange(frames: ProjectFrame[], atSec: number) {
  return clampRange(frames, atSec - 0.5, atSec + 0.5, "length").range;
}
export const PRESET_LENGTHS = [5, 10, 15, 30];

export function isPreset(type: MediaType | null): type is PresetType {
  return type === "ad" || type === "company";
}

/** Legacy edit window centred on `atSec` (± windowSec), clamped to the containing frame's segment (used for past edits). */
export function editWindowFor(frames: ProjectFrame[], atSec: number, windowSec: number): TimeWindow {
  const frame = frames.find((candidate) => candidate.index === frameIndexAt(frames, atSec));
  const segStart = frame?.startSec ?? 0;
  const segEnd = frame ? frame.startSec + frame.durationSec : atSec + windowSec;
  return { startSec: Math.max(segStart, atSec - windowSec), endSec: Math.min(segEnd, atSec + windowSec) };
}

export function isTimeWindow(value: unknown): value is TimeWindow {
  if (!value || typeof value !== "object") return false;
  const window = value as Partial<TimeWindow>;
  return typeof window.startSec === "number" && typeof window.endSec === "number";
}

export function formatWindow(window: TimeWindow) {
  return `${window.startSec.toFixed(1)}s–${window.endSec.toFixed(1)}s`;
}

export function formatRange(window: TimeWindow) {
  return `${formatWindow(window)} (${(window.endSec - window.startSec).toFixed(1)}s)`;
}

/** Draws the current video frame to a small canvas; returns null if the frame isn't decoded or comes out blank (Safari). */
export function captureVideoThumb(video: HTMLVideoElement): string | null {
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

export function nowIso() {
  return new Date().toISOString();
}

/** Normalizes `ragSources` (strings or {title|name|source|id} objects) into short labels. */
export function ragLabels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const labels = value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const label = record.title ?? record.name ?? record.source ?? record.id;
      return typeof label === "string" ? [label] : [];
    }
    return [];
  });
  return labels.length > 0 ? labels : undefined;
}

const MEMORY_KINDS = new Set(["knowledge", "video", "user_prompt", "research", "example"]);

/** Validates `memorySources` from the server into chips (drops malformed items and non-http/app links). */
export function memoryChips(value: unknown): MemoryChip[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const chips = value.flatMap((item): MemoryChip[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.kind !== "string" || !MEMORY_KINDS.has(record.kind) || typeof record.title !== "string" || typeof record.ref !== "string") return [];
    const url = typeof record.url === "string" && /^(https?:\/\/|\/api\/)/.test(record.url) ? record.url : undefined;
    return [{
      kind: record.kind as MemoryChip["kind"],
      title: record.title,
      ref: record.ref,
      ...(url ? { url } : {}),
      ...(typeof record.at === "string" ? { at: record.at } : {}),
      score: typeof record.score === "number" ? record.score : 0,
    }];
  });
  return chips.length > 0 ? chips : undefined;
}

/** Flattens the project's saved per-frame chats into thread entries. */
export function threadFromProject(project: Project): ThreadEntry[] {
  const entries: ThreadEntry[] = [];
  for (const [key, messages] of Object.entries(project.chats ?? {})) {
    if (!Array.isArray(messages)) continue;
    const frameIndex = Number(key);
    const frame = project.frames.find((candidate) => candidate.index === frameIndex);
    let lastUserGrab: string | undefined;
    messages.forEach((message, index) => {
      const range = typeof message.rangeStartSec === "number" && typeof message.rangeEndSec === "number" ? { startSec: message.rangeStartSec, endSec: message.rangeEndSec } : null;
      if (message.role === "user") {
        lastUserGrab = message.grabbedFrameUrl;
        const where = range ? formatWindow(range) : typeof message.atSec === "number" ? `${message.atSec.toFixed(1)}s` : null;
        entries.push({ id: `srv-${key}-${index}`, role: "user", text: message.text, at: message.at, context: [where, `shot ${frameIndex + 1}`].filter(Boolean).join(" · "), thumbUrl: message.grabbedFrameUrl });
      } else {
        entries.push({
          id: `srv-${key}-${index}`,
          role: "assistant",
          text: message.text,
          at: message.at,
          edited: message.edited,
          note: message.edited ? "Frame updated · video re-rendered" : undefined,
          beforeUrl: message.edited ? message.grabbedFrameUrl ?? lastUserGrab : undefined,
          afterUrl: message.edited ? frame?.imageUrl : undefined,
          enhancedPrompt: message.enhancedPrompt,
          ragSources: ragLabels(message.ragSources),
          memorySources: memoryChips(message.memorySources),
        });
      }
    });
  }
  return entries;
}

export function mergeThread(server: ThreadEntry[], local: ThreadEntry[]) {
  // Auto-mode results are stored locally (with the action pill); drop the server copy of the same message.
  const near = (a: ThreadEntry, b: ThreadEntry) => a.role === b.role && a.text === b.text && Math.abs((Date.parse(a.at) || 0) - (Date.parse(b.at) || 0)) < 180_000;
  const serverOnly = server.filter((entry) => !local.some((candidate) => near(candidate, entry)));
  return [...serverOnly, ...local].map((entry, order) => ({ entry, order, time: Date.parse(entry.at) || 0 }))
    .sort((a, b) => a.time - b.time || a.order - b.order)
    .map(({ entry }) => entry);
}

export function isAbortError(caughtError: unknown) {
  return caughtError instanceof DOMException && caughtError.name === "AbortError";
}
