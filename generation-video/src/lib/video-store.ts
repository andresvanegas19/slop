import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProject, saveProject, withProjectLock, type Project } from "@/lib/projects";
import { getClient, isRawTreeConfigured } from "@/lib/rawtree";
import { logException, logInfo } from "@/lib/runtime-log";
import { probeMedia, videoFilePath } from "@/lib/segments";

/**
 * Publishes finished project videos to RawTree (shared hackathon DB — only `slop_human*` tables, rows are permanent):
 *   slop_human_video_events  one metadata row per (project, video bytes) — what the research agent reads for context
 *   slop_human_video_chunks  the MP4 bytes, base64 in 512 KB (raw) chunks, one row per (video sha256, index)
 * Schemas are documented in docs/RAWTREE_VIDEOS.md; keep them in sync.
 */

export const EVENTS_TABLE = "slop_human_video_events";
export const CHUNKS_TABLE = "slop_human_video_chunks";
/** Raw bytes per chunk (base64 ≈ 683 KB); a 512 KB chunk was verified to insert and read back intact. */
export const CHUNK_BYTES = 512 * 1024;
const CHUNKS_PER_INSERT = 4;
const CHUNKS_PER_READ = 4;
const THUMBNAIL_MAX_BYTES = 40 * 1024;
const TEXT_CAP = 400;
const PROMPTS_CAP = 4_000;
const FRAMES_JSON_CAP = 60_000;
const STORYBOARD_JSON_CAP = 40_000;
const CHAT_MESSAGES = 10;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type PublishReason = "generated" | "uploaded" | "edited" | "appended" | "cut" | "preset" | "storyboard" | "manual";

export type PublishStatus = {
  sha256: string;
  at: string;
  status: "ok" | "failed";
  videoUrl: string;
  chunksWritten?: number;
  chunkCount?: number;
  note?: string;
  error?: string;
};

export type PublishResult = PublishStatus & { eventWritten: boolean; ms: number };

export type PublishedVideo = {
  event_id: string;
  project_id: string;
  kind: string;
  title: string;
  reason: string;
  video_sha256: string;
  bytes: number;
  duration_sec: number;
  width: number;
  height: number;
  fps: number;
  has_audio: boolean;
  chunk_count: number;
  chunk_bytes: number;
  mime: string;
  thumbnail_b64: string;
  frames: string;
  prompts: string;
  storyboard: string;
  chat_summary: string;
  research_session_id: string;
  note: string;
  created_at: string;
  app: string;
};

export class VideoStoreError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

export function isSha256(value: string) {
  return SHA256_HEX.test(value);
}

function publishingEnabled() {
  if (!isRawTreeConfigured()) return false; // also loads .env
  return (process.env.RAWTREE_PUBLISH_VIDEOS ?? "1").trim() !== "0";
}

function maxVideoBytes() {
  const mb = Number(process.env.RAWTREE_MAX_VIDEO_MB ?? 25);
  return (Number.isFinite(mb) && mb > 0 ? mb : 25) * 1024 * 1024;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries RawTree calls on 429 / 5xx / network errors with exponential backoff. */
export async function withRetry<T>(label: string, task: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      const status = (error as { status?: number }).status;
      const retryable = status === undefined || status === 429 || status >= 500;
      if (!retryable || attempt >= attempts) throw error;
      const delay = Math.min(8_000, 500 * 2 ** (attempt - 1)) + Math.random() * 250;
      logInfo("rawtree_retry", { label, attempt, status, delayMs: Math.round(delay) });
      await sleep(delay);
    }
  }
}

function spawnBuffer(command: string, args: string[]) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, args);
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${command} exited ${code}: ${stderr.trim().slice(-300)}`)));
  });
}

async function probeFps(filePath: string) {
  const output = await spawnBuffer("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate", "-of", "csv=p=0", filePath]);
  const [num, den] = output.toString().trim().split("/").map(Number);
  const fps = den ? num / den : num;
  return Number.isFinite(fps) ? Math.round(fps * 1000) / 1000 : 0;
}

/** First frame as a ~320px-wide JPEG, ≤ 40 KB (quality lowered until it fits; "" if it can't be made). */
async function thumbnailBase64(filePath: string) {
  for (const [width, quality] of [[320, 5], [320, 10], [240, 14], [160, 20]] as const) {
    try {
      const jpeg = await spawnBuffer("ffmpeg", [
        "-v", "error", "-i", filePath, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", String(quality), "-f", "image2", "-c:v", "mjpeg", "pipe:1",
      ]);
      if (jpeg.length > 0 && jpeg.length <= THUMBNAIL_MAX_BYTES) return jpeg.toString("base64");
    } catch {
      return "";
    }
  }
  return "";
}

const cap = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

function framesJson(project: Project) {
  const frames = project.frames.map((frame) => ({
    index: frame.index,
    startSec: frame.startSec,
    durationSec: frame.durationSec,
    prompt: cap(frame.prompt, 1_500),
    source: frame.source ?? (project.kind === "storyboard" ? "storyboard" : "generated"),
    edits: (frame.edits ?? []).map((edit) => ({ startSec: edit.startSec, endSec: edit.endSec, prompt: cap(edit.prompt, TEXT_CAP), at: edit.at })),
    ...(frame.narration ? { narration: cap(frame.narration, TEXT_CAP) } : {}),
    ...(frame.headline ? { headline: cap(frame.headline, 200) } : {}),
  }));
  let json = JSON.stringify(frames);
  if (json.length > FRAMES_JSON_CAP) json = JSON.stringify(frames.map((frame) => ({ ...frame, prompt: cap(frame.prompt, 300), edits: frame.edits.slice(-3) })));
  if (json.length > FRAMES_JSON_CAP) json = JSON.stringify(frames.map(({ index, startSec, durationSec, source, prompt }) => ({ index, startSec, durationSec, source, prompt: cap(prompt, 120), edits: [] })));
  return json;
}

function promptsSummary(project: Project) {
  const prompts = [...new Set(project.frames.map((frame) => frame.prompt.trim()).filter(Boolean))];
  return cap(prompts.map((prompt, position) => `${position + 1}. ${cap(prompt, 600)}`).join("\n"), PROMPTS_CAP);
}

function storyboardJson(project: Project) {
  if (project.storyboard === undefined) return "";
  const json = JSON.stringify(project.storyboard);
  return json.length <= STORYBOARD_JSON_CAP ? json : "";
}

function chatSummary(project: Project) {
  const messages = Object.entries(project.chats)
    .flatMap(([frame, thread]) => thread.map((message) => ({ frame: Number(frame), role: message.role, text: cap(message.text, TEXT_CAP), at: message.at, ...(message.edited ? { edited: true } : {}) })))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-CHAT_MESSAGES);
  return JSON.stringify(messages);
}

async function recordStatus(projectId: string, status: PublishStatus) {
  try {
    await withProjectLock(projectId, async () => {
      const current = await loadProject(projectId);
      await saveProject({ ...current, published: status });
    });
  } catch (error) {
    logException("rawtree_publish_status_failed", error, { projectId });
  }
}

async function existingChunkIndexes(sha: string) {
  if (!isSha256(sha)) throw new VideoStoreError("Invalid sha256.", 400);
  const client = getClient();
  const counted = await withRetry("chunk_count", () => client.query<{ n: number | string }>({
    sql: `SELECT count() AS n FROM ${CHUNKS_TABLE} WHERE video_sha256 = '${sha}'`,
  }));
  if (Number(counted.data[0]?.n ?? 0) === 0) return new Set<number>();
  const rows = await withRetry("chunk_indexes", () => client.query<{ i: number | string }>({
    sql: `SELECT DISTINCT toUInt32("index") AS i FROM ${CHUNKS_TABLE} WHERE video_sha256 = '${sha}'`,
  }));
  return new Set(rows.data.map((row) => Number(row.i)));
}

async function eventExists(eventId: string) {
  if (!isSha256(eventId)) throw new VideoStoreError("Invalid event id.", 400);
  const result = await withRetry("event_exists", () => getClient().query<{ n: number | string }>({
    sql: `SELECT count() AS n FROM ${EVENTS_TABLE} WHERE event_id = '${eventId}'`,
  }));
  return Number(result.data[0]?.n ?? 0) > 0;
}

/** The first query against a table that doesn't exist yet (nothing inserted) fails; treat that as "no rows". */
function isMissingTable(error: unknown) {
  const text = `${(error as Error)?.message ?? ""} ${(error as { hint?: string })?.hint ?? ""}`;
  return /unknown table|doesn't exist|does not exist|not found|UNKNOWN_TABLE/i.test(text);
}

// One publish per video hash at a time (a second call for the same bytes waits and then dedupes).
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Publishes the project's current video (metadata row + chunked bytes). Never throws: failures are logged and recorded
 * on the project JSON as `published: { status: "failed", error }`.
 */
export async function publishProjectVideo(project: Project, options: { reason: PublishReason }): Promise<PublishResult> {
  const started = Date.now();
  const at = new Date().toISOString();
  let sha = "";
  try {
    if (!isRawTreeConfigured()) throw new VideoStoreError("RAWTREE_API_KEY is not configured on the server.", 503);
    const filePath = videoFilePath(project.videoUrl);
    const bytes = await readFile(filePath);
    sha = createHash("sha256").update(bytes).digest("hex");

    const previous = inFlight.get(sha) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => publishBytes(project, options.reason, filePath, bytes, sha, at));
    inFlight.set(sha, run);
    let result: Omit<PublishResult, "ms">;
    try {
      result = await run;
    } finally {
      if (inFlight.get(sha) === run) inFlight.delete(sha);
    }
    const { eventWritten, ...status } = result;
    await recordStatus(project.id, status);
    const ms = Date.now() - started;
    logInfo("rawtree_publish_completed", { projectId: project.id, sha256: sha, reason: options.reason, eventWritten, chunksWritten: status.chunksWritten, chunkCount: status.chunkCount, ms });
    return { ...result, ms };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logException("rawtree_publish_failed", error, { projectId: project.id, sha256: sha || undefined, reason: options.reason });
    const status: PublishStatus = { sha256: sha, at, status: "failed", videoUrl: project.videoUrl, error: cap(message, 500) };
    await recordStatus(project.id, status);
    return { ...status, eventWritten: false, ms: Date.now() - started };
  }
}

async function publishBytes(project: Project, reason: PublishReason, filePath: string, bytes: Buffer, sha: string, at: string): Promise<Omit<PublishResult, "ms">> {
  const client = getClient();
  const tooBig = bytes.length > maxVideoBytes();
  const chunkCount = tooBig ? 0 : Math.ceil(bytes.length / CHUNK_BYTES);
  const note = tooBig ? `Video is ${(bytes.length / 1024 / 1024).toFixed(1)} MB, above RAWTREE_MAX_VIDEO_MB; metadata only.` : "";

  // Chunks first, so an event row never points at bytes that aren't there.
  let chunksWritten = 0;
  if (!tooBig) {
    let present: Set<number>;
    try {
      present = await existingChunkIndexes(sha);
    } catch (error) {
      if (!isMissingTable(error)) throw error;
      present = new Set();
    }
    const missing = Array.from({ length: chunkCount }, (_, index) => index).filter((index) => !present.has(index));
    for (let offset = 0; offset < missing.length; offset += CHUNKS_PER_INSERT) {
      const batch = missing.slice(offset, offset + CHUNKS_PER_INSERT).map((index) => {
        const data = bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
        return { chunk_id: `${sha}:${index}`, video_sha256: sha, index, total: chunkCount, data_b64: data.toString("base64"), bytes: data.length };
      });
      const response = await withRetry("insert_chunks", () => client.insert({ table: CHUNKS_TABLE, values: batch }));
      chunksWritten += response.inserted;
    }
  }

  const eventId = createHash("sha256").update(project.id + sha).digest("hex");
  let exists = false;
  try {
    exists = await eventExists(eventId);
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  if (!exists) {
    const [media, fps, thumbnail] = await Promise.all([probeMedia(filePath), probeFps(filePath).catch(() => 0), thumbnailBase64(filePath)]);
    const row: PublishedVideo = {
      event_id: eventId,
      project_id: project.id,
      kind: project.kind,
      title: cap(project.title, 300),
      reason,
      video_sha256: sha,
      bytes: bytes.length,
      duration_sec: Math.round((media.durationSeconds || project.durationSeconds) * 1000) / 1000,
      width: media.width,
      height: media.height,
      fps,
      has_audio: media.hasAudio,
      chunk_count: chunkCount,
      chunk_bytes: CHUNK_BYTES,
      mime: "video/mp4",
      thumbnail_b64: thumbnail,
      frames: framesJson(project),
      prompts: promptsSummary(project),
      storyboard: storyboardJson(project),
      chat_summary: chatSummary(project),
      research_session_id: project.researchSessionId ?? "",
      note,
      created_at: at,
      app: "longform",
    };
    await withRetry("insert_event", () => client.insert({ table: EVENTS_TABLE, values: row }));
  }
  return {
    sha256: sha,
    at,
    status: "ok",
    videoUrl: project.videoUrl,
    chunksWritten,
    chunkCount,
    ...(note ? { note } : {}),
    eventWritten: !exists,
  };
}

/** Fire-and-forget publish after a new project video was saved (no-op when RAWTREE_PUBLISH_VIDEOS=0 / no API key). */
export function schedulePublish(project: Project, reason: PublishReason) {
  try {
    if (!publishingEnabled()) return;
  } catch {
    return;
  }
  void publishProjectVideo(project, { reason }).catch((error) => logException("rawtree_publish_unexpected", error, { projectId: project.id }));
}

function cacheDirectory() {
  return path.join(process.cwd(), "output", "rawtree-cache");
}

/** Reassembles a published video from its chunks (paged by index), verifying count and sha256. */
export async function fetchVideoFromRawTree(sha256: string): Promise<Buffer> {
  if (!isSha256(sha256)) throw new VideoStoreError("sha256 must be 64 lowercase hex characters.", 400);
  const client = getClient();
  const chunks = new Map<number, Buffer>();
  let total = -1;
  for (let offset = 0; ; offset += CHUNKS_PER_READ) {
    const page = await withRetry("read_chunks", () => client.query<{ i: number | string; t: number | string; d: string }>({
      sql: `SELECT toUInt32("index") AS i, toUInt32(total) AS t, toString(data_b64) AS d FROM ${CHUNKS_TABLE} WHERE video_sha256 = '${sha256}' ORDER BY i, toString(chunk_id) LIMIT ${CHUNKS_PER_READ} OFFSET ${offset}`,
    }));
    for (const row of page.data) {
      const index = Number(row.i);
      total = Number(row.t);
      if (!chunks.has(index)) chunks.set(index, Buffer.from(row.d, "base64"));
    }
    if (page.data.length < CHUNKS_PER_READ) break;
  }
  if (chunks.size === 0) throw new VideoStoreError(`No chunks for video ${sha256} in RawTree.`, 404);
  if (chunks.size !== total || [...chunks.keys()].some((index) => index < 0 || index >= total)) {
    throw new VideoStoreError(`Video ${sha256} is incomplete in RawTree (${chunks.size}/${total} chunks).`, 502);
  }
  const bytes = Buffer.concat(Array.from({ length: total }, (_, index) => chunks.get(index) as Buffer));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256) throw new VideoStoreError(`Reassembled video hash ${actual} does not match ${sha256}.`, 502);
  return bytes;
}

/** Local path of the reassembled video, fetching it from RawTree once (output/rawtree-cache/<sha>.mp4). */
export async function cachedVideoPath(sha256: string) {
  if (!isSha256(sha256)) throw new VideoStoreError("sha256 must be 64 lowercase hex characters.", 400);
  const target = path.join(cacheDirectory(), `${sha256}.mp4`);
  try {
    if ((await stat(target)).size > 0) return target;
  } catch {
    // not cached yet
  }
  const bytes = await fetchVideoFromRawTree(sha256);
  await mkdir(cacheDirectory(), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, target);
  return target;
}

const LIST_COLUMNS = [
  "event_id", "project_id", "kind", "title", "reason", "video_sha256", "bytes", "duration_sec", "width", "height", "fps", "has_audio",
  "chunk_count", "chunk_bytes", "mime", "thumbnail_b64", "frames", "prompts", "storyboard", "chat_summary", "research_session_id", "note",
  "created_at", "app",
];

/** Metadata rows (no chunks), newest first. */
export async function listPublishedVideos(options: { limit?: number; projectId?: string } = {}): Promise<PublishedVideo[]> {
  const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)));
  if (options.projectId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(options.projectId)) throw new VideoStoreError("Invalid projectId.", 400);
  const where = options.projectId ? `WHERE project_id = '${options.projectId}'` : "";
  try {
    const result = await withRetry("list_videos", () => getClient().query<Record<string, unknown>>({
      sql: `SELECT ${LIST_COLUMNS.map((column) => `"${column}"`).join(", ")} FROM ${EVENTS_TABLE} ${where} ORDER BY toString(created_at) DESC LIMIT ${limit}`,
    }));
    return result.data.map((row) => ({
      ...(Object.fromEntries(LIST_COLUMNS.map((column) => [column, row[column] ?? ""])) as PublishedVideo),
      bytes: Number(row.bytes ?? 0),
      duration_sec: Number(row.duration_sec ?? 0),
      width: Number(row.width ?? 0),
      height: Number(row.height ?? 0),
      fps: Number(row.fps ?? 0),
      has_audio: row.has_audio === true || row.has_audio === "true" || row.has_audio === 1,
      chunk_count: Number(row.chunk_count ?? 0),
      chunk_bytes: Number(row.chunk_bytes ?? 0),
    }));
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}
