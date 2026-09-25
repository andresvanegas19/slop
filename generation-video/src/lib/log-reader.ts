/*
 * Reads the NDJSON log files written by runtime-log.ts (`<date>.ndjson`) and the Python agent
 * (`agent-<date>.ndjson`) for GET /api/logs and GET /api/logs/stream. Bounded: at most MAX_FILES files and the last
 * MAX_BYTES_PER_FILE of each.
 */
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { logsDirectory, type LogEntry, type LogLevel } from "@/lib/runtime-log";

const FILE_PATTERN = /^(agent-)?(\d{4}-\d{2}-\d{2})\.ndjson$/;
const MAX_FILES = 6;
const MAX_BYTES_PER_FILE = 16 * 1024 * 1024;
export const MAX_LIMIT = 5_000;
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFilter = {
  traceId?: string;
  jobId?: string;
  projectId?: string;
  /** ISO time or ms since epoch; entries at/after it. */
  since?: number;
  level?: LogLevel;
  source?: "web" | "agent";
  /** Substring of the event name. */
  event?: string;
  /** Free-text substring anywhere in the line. */
  q?: string;
};

export function parseFilter(params: URLSearchParams): LogFilter & { limit: number } {
  const text = (name: string, max = 128) => {
    const value = params.get(name)?.trim();
    return value ? value.slice(0, max) : undefined;
  };
  const sinceRaw = text("since", 64);
  let since: number | undefined;
  if (sinceRaw) {
    const numeric = Number(sinceRaw);
    since = Number.isFinite(numeric) ? (numeric < 1e11 ? Date.now() - numeric * 1000 : numeric) : Date.parse(sinceRaw);
    if (!Number.isFinite(since)) since = undefined;
  }
  const levelRaw = text("level", 10)?.toLowerCase();
  const level = levelRaw && levelRaw in LEVELS ? levelRaw as LogLevel : undefined;
  const sourceRaw = text("source", 10);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(params.get("limit")) || 300)));
  return {
    traceId: text("traceId"),
    jobId: text("jobId"),
    projectId: text("projectId"),
    since,
    level,
    source: sourceRaw === "web" || sourceRaw === "agent" ? sourceRaw : undefined,
    event: text("event"),
    q: text("q", 200),
    limit,
  };
}

export async function logFiles(): Promise<{ file: string; date: string; source: "web" | "agent" }[]> {
  const directory = logsDirectory();
  const names = await readdir(directory).catch(() => [] as string[]);
  return names
    .map((name) => ({ name, match: FILE_PATTERN.exec(name) }))
    .filter((item): item is { name: string; match: RegExpExecArray } => Boolean(item.match))
    .map(({ name, match }) => ({ file: path.join(directory, name), date: match[2], source: match[1] ? "agent" as const : "web" as const }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

async function readTail(file: string, maxBytes: number) {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    // Drop a partial first line when we started mid-file.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

export function parseLine(line: string, source: "web" | "agent"): LogEntry | null {
  if (!line.trim()) return null;
  try {
    const entry = JSON.parse(line) as LogEntry;
    if (!entry || typeof entry !== "object" || typeof entry.event !== "string") return null;
    entry.source ??= source;
    if (typeof entry.level !== "string" || !(entry.level in LEVELS)) entry.level = "info";
    return entry;
  } catch {
    return null;
  }
}

/** Matcher for a filter; `relatedTraces` grows as lines of the wanted job/project reveal their trace ids. */
export function matcher(filter: LogFilter) {
  const relatedTraces = new Set<string>();
  const minLevel = filter.level ? LEVELS[filter.level] : 0;
  const q = filter.q?.toLowerCase();
  const owns = (entry: LogEntry) =>
    (filter.jobId !== undefined && entry.jobId === filter.jobId) || (filter.projectId !== undefined && entry.projectId === filter.projectId);
  return {
    relatedTraces,
    /** Records trace ids of lines that belong to the wanted job/project (call on every line first). */
    learn(entry: LogEntry) {
      if ((filter.jobId || filter.projectId) && owns(entry) && typeof entry.traceId === "string") relatedTraces.add(entry.traceId);
    },
    test(entry: LogEntry, line?: string) {
      if (LEVELS[entry.level] < minLevel) return false;
      if (filter.source && entry.source !== filter.source) return false;
      if (filter.since !== undefined && Date.parse(entry.ts) < filter.since) return false;
      if (filter.traceId && entry.traceId !== filter.traceId && !(typeof entry.traceId === "string" && entry.traceId.startsWith(filter.traceId))) return false;
      if ((filter.jobId || filter.projectId) && !owns(entry) && !(typeof entry.traceId === "string" && relatedTraces.has(entry.traceId))) return false;
      if (filter.event && !entry.event.includes(filter.event)) return false;
      if (q && !(line ?? JSON.stringify(entry)).toLowerCase().includes(q)) return false;
      return true;
    },
  };
}

/** Matching entries in chronological order (the newest `limit`). */
export async function queryLogs(filter: LogFilter & { limit: number }) {
  const files = (await logFiles())
    .filter((item) => !filter.source || item.source === filter.source)
    .filter((item) => filter.since === undefined || item.date >= new Date(filter.since - 86_400_000).toISOString().slice(0, 10))
    .slice(0, MAX_FILES);
  const entries: { entry: LogEntry; line: string }[] = [];
  for (const item of files) {
    const text = await readTail(item.file, MAX_BYTES_PER_FILE).catch(() => "");
    for (const line of text.split("\n")) {
      const entry = parseLine(line, item.source);
      if (entry) entries.push({ entry, line });
    }
  }
  entries.sort((a, b) => (a.entry.ts < b.entry.ts ? -1 : a.entry.ts > b.entry.ts ? 1 : 0));
  const match = matcher(filter);
  for (const { entry } of entries) match.learn(entry);
  const matched = entries.filter(({ entry, line }) => match.test(entry, line)).map(({ entry }) => entry);
  return {
    entries: matched.slice(-filter.limit),
    total: matched.length,
    truncated: matched.length > filter.limit,
    files: files.map((item) => path.basename(item.file)),
  };
}

export async function fileSize(file: string) {
  return (await stat(file).catch(() => null))?.size ?? 0;
}

export async function readRange(file: string, start: number, end: number) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, end - start));
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}
