/*
 * Server-side structured logging (see docs/LOGGING.md).
 *
 * - Levels debug < info < warn < error. `LOG_LEVEL` (default info) filters the console; `LOG_FILE_LEVEL` (default
 *   debug) filters the NDJSON files.
 * - Trace context (AsyncLocalStorage): `withTrace({ traceId, jobId, projectId, userId, route }, fn)`. Every line logged
 *   inside `fn` (and inside promises/timers it starts) carries those fields automatically.
 * - Console: one colored line per event, e.g.
 *   `[longform] 15:23:48.141 INFO  trace=ab12cd34 cinematic_scene_phase scene=1/2 phase="generating video" (+12.3s)`
 * - Files: `output/logs/<YYYY-MM-DD>.ndjson` (one JSON object per line, rotated daily, read by /api/logs). The Python
 *   agent writes `agent-<YYYY-MM-DD>.ndjson` to the same folder.
 * - Secrets are never written: secret-looking keys are redacted, key-looking substrings are masked, strings are capped
 *   (prompts/messages to 200 chars).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { appendFile, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, unknown>;

export type TraceContext = {
  traceId: string;
  jobId?: string;
  projectId?: string;
  userId?: string;
  route?: string;
  /** When the trace started (ms since epoch), for the console's `(+12.3s)`. */
  startedAt: number;
};

export type LogEntry = {
  ts: string;
  level: LogLevel;
  event: string;
  source: "web" | "agent";
  traceId?: string;
  jobId?: string;
  projectId?: string;
  userId?: string;
  route?: string;
  durationMs?: number;
  [key: string]: unknown;
};

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_STRING = 500;
const MAX_PROMPT = 200;
const MAX_STACK = 2_000;
const RESERVED = new Set(["ts", "level", "event", "source", "traceId", "jobId", "projectId", "userId", "route"]);
const ENVELOPE = new Set(["ts", "level", "event", "source", "traceId"]);

type Shared = { storage: AsyncLocalStorage<TraceContext>; cleaned: boolean; dirReady: string | null; pending: string[]; flushing: boolean; file: string | null };
// On globalThis so Turbopack HMR keeps one store (a trace started before a reload keeps logging with its id).
const shared: Shared = ((globalThis as { __longformLog?: Shared }).__longformLog ??= {
  storage: new AsyncLocalStorage<TraceContext>(),
  cleaned: false,
  dirReady: null,
  pending: [],
  flushing: false,
  file: null,
});

function parseLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "warning") return "warn";
  return normalized && normalized in LEVELS ? normalized as LogLevel : fallback;
}

const consoleLevel = () => parseLevel(process.env.LOG_LEVEL, "info");
const fileLevel = () => parseLevel(process.env.LOG_FILE_LEVEL, "debug");

export function logsDirectory() {
  return process.env.LOG_DIR?.trim() || path.join(process.cwd(), "output", "logs");
}

// ---------------------------------------------------------------------------------------------------------------------
// Trace context

export function newTraceId() {
  return randomBytes(6).toString("hex");
}

export function currentTrace(): TraceContext | undefined {
  return shared.storage.getStore();
}

/**
 * Runs `fn` inside a trace. Fields not given are inherited from the enclosing trace (a new traceId is generated when
 * there is none), so nested calls can just add `jobId` / `projectId`.
 */
export function withTrace<T>(context: Partial<Omit<TraceContext, "startedAt">> & { startedAt?: number }, fn: () => T): T {
  const parent = shared.storage.getStore();
  const defined = Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined && value !== "")) as Partial<TraceContext>;
  const next: TraceContext = {
    ...parent,
    ...defined,
    traceId: defined.traceId ?? parent?.traceId ?? newTraceId(),
    startedAt: defined.startedAt ?? (defined.traceId && defined.traceId !== parent?.traceId ? Date.now() : parent?.startedAt ?? Date.now()),
  };
  return shared.storage.run(next, fn);
}

/** Adds fields (e.g. the projectId once it is known) to the current trace, for every later line. */
export function annotateTrace(fields: Partial<Pick<TraceContext, "jobId" | "projectId" | "userId">>) {
  const store = shared.storage.getStore();
  if (!store) return;
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string" && value) (store as Record<string, unknown>)[key] = value;
  }
}

/** Runs `fn` with a previously captured trace (callbacks of child processes / event emitters). */
export function runInTrace<T>(context: TraceContext | undefined, fn: () => T): T {
  return context ? shared.storage.run(context, fn) : fn();
}

// ---------------------------------------------------------------------------------------------------------------------
// Sanitizing

const SECRET_KEY = /(api[_-]?key|secret|password|passwd|authorization|cookie|^x-key$|^token$|access[_-]?token|bearer)/i;
const PROMPT_KEY = /(prompt|message|reply|content|instruction|text|query|sql)$/i;
const SECRET_VALUE = [/sk-or-[A-Za-z0-9_-]{8,}/g, /sk-[A-Za-z0-9_-]{16,}/g, /Bearer\s+[A-Za-z0-9._-]{8,}/gi, /([?&](?:key|api_key|token|sig|signature|se|sp|sv|X-Amz-[A-Za-z-]+)=)[^&\s"]+/g];

function cap(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit)}…(+${text.length - limit})` : text;
}

function scrub(text: string) {
  let out = text;
  for (const pattern of SECRET_VALUE) out = out.replace(pattern, (_match, prefix: unknown) => (typeof prefix === "string" ? `${prefix}***` : "***"));
  return out;
}

function sanitizeValue(key: string, value: unknown, depth = 0): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (SECRET_KEY.test(key)) return value ? "[redacted]" : value;
    if (value.startsWith("data:")) return `[data-uri ${value.length} chars]`;
    return scrub(cap(value, PROMPT_KEY.test(key) ? MAX_PROMPT : MAX_STRING));
  }
  if (value instanceof Error) return scrub(cap(value.message, MAX_STRING));
  if (depth >= 2) return "[object]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeValue(key, item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      out[inner] = SECRET_KEY.test(inner) && innerValue ? "[redacted]" : sanitizeValue(inner, innerValue, depth + 1);
    }
    return out;
  }
  return String(value);
}

function sanitize(fields: LogFields | undefined) {
  const out: Record<string, unknown> = {};
  if (!fields) return out;
  for (const [key, value] of Object.entries(fields)) {
    const clean = sanitizeValue(key, value);
    // Explicit jobId/projectId/userId/route override the trace's; the other envelope keys can't be overwritten.
    if (clean !== undefined) out[ENVELOPE.has(key) ? `_${key}` : key] = clean;
  }
  // Older call sites report durations as `ms`.
  if (out.durationMs === undefined && typeof out.ms === "number") {
    out.durationMs = out.ms;
    delete out.ms;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sinks

function localDate(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function cleanupOldFiles(directory: string) {
  const days = Number(process.env.LOG_RETENTION_DAYS ?? 14);
  if (!Number.isFinite(days) || days <= 0) return;
  try {
    for (const name of readdirSync(directory)) {
      if (!/^(agent-)?\d{4}-\d{2}-\d{2}\.ndjson$/.test(name)) continue;
      const file = path.join(directory, name);
      if (Date.now() - statSync(file).mtimeMs > days * 86_400_000) unlinkSync(file);
    }
  } catch {
    // Best effort.
  }
}

function flush() {
  if (shared.flushing || shared.pending.length === 0) return;
  shared.flushing = true;
  const directory = logsDirectory();
  try {
    if (shared.dirReady !== directory) {
      mkdirSync(directory, { recursive: true });
      shared.dirReady = directory;
      if (!shared.cleaned) {
        shared.cleaned = true;
        cleanupOldFiles(directory);
      }
    }
  } catch {
    shared.pending = [];
    shared.flushing = false;
    return;
  }
  const lines = shared.pending.join("");
  shared.pending = [];
  // Rotation: the file name follows the local date of the flush.
  const file = path.join(directory, `${localDate(new Date())}.ndjson`);
  appendFile(file, lines, () => {
    shared.flushing = false;
    if (shared.pending.length) setImmediate(flush);
  });
}

function writeFileLine(entry: LogEntry) {
  let line: string;
  try {
    line = `${JSON.stringify(entry)}\n`;
  } catch {
    return;
  }
  shared.pending.push(line);
  if (shared.pending.length > 5_000) shared.pending.splice(0, shared.pending.length - 5_000);
  if (!shared.flushing) setImmediate(flush);
}

const COLOR = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", gray: "\x1b[90m", cyan: "\x1b[36m", yellow: "\x1b[33m", red: "\x1b[31m", magenta: "\x1b[35m", green: "\x1b[32m" };
const LEVEL_COLOR: Record<LogLevel, string> = { debug: COLOR.gray, info: COLOR.cyan, warn: COLOR.yellow, error: COLOR.red };

function colorEnabled() {
  const setting = process.env.LOG_COLOR?.trim().toLowerCase();
  if (setting === "0" || setting === "false") return false;
  if (setting === "1" || setting === "true") return true;
  return process.env.NODE_ENV !== "production" && !process.env.NO_COLOR;
}

function formatValue(value: unknown) {
  if (typeof value === "string") return /^[^\s"=]+$/.test(value) && value.length > 0 ? value : JSON.stringify(value);
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}

function formatDuration(ms: number) {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1_000)}s`;
}

function writeConsole(entry: LogEntry, trace: TraceContext | undefined, stack?: string) {
  const color = colorEnabled();
  const paint = (code: string, text: string) => (color ? `${code}${text}${COLOR.reset}` : text);
  const date = new Date(entry.ts);
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}.${String(date.getMilliseconds()).padStart(3, "0")}`;
  const parts = [paint(COLOR.dim, "[longform]"), paint(COLOR.dim, clock), paint(LEVEL_COLOR[entry.level], entry.level.toUpperCase().padEnd(5))];
  if (entry.traceId) parts.push(paint(COLOR.magenta, `trace=${entry.traceId.slice(0, 8)}`));
  if (entry.jobId) parts.push(paint(COLOR.magenta, `job=${entry.jobId.slice(0, 8)}`));
  parts.push(paint(COLOR.bold, entry.event));
  for (const [key, value] of Object.entries(entry)) {
    if (RESERVED.has(key) || key === "durationMs" || key === "stack" || value === undefined) continue;
    parts.push(`${paint(COLOR.gray, `${key}=`)}${formatValue(value)}`);
  }
  if (typeof entry.durationMs === "number") parts.push(paint(COLOR.green, `in ${formatDuration(entry.durationMs)}`));
  if (trace) parts.push(paint(COLOR.dim, `(+${((Date.now() - trace.startedAt) / 1_000).toFixed(1)}s)`));
  const line = parts.join(" ");
  if (entry.level === "error") console.error(line);
  else if (entry.level === "warn") console.warn(line);
  else console.info(line);
  if (stack) console.error(color ? `${COLOR.dim}${stack}${COLOR.reset}` : stack);
}

/** Core logger. `fields` are sanitized; trace fields are added from the current trace context. */
export function log(level: LogLevel, event: string, fields?: LogFields, extra?: { stack?: string }) {
  const toConsole = LEVELS[level] >= LEVELS[consoleLevel()];
  const toFile = LEVELS[level] >= LEVELS[fileLevel()];
  if (!toConsole && !toFile) return;
  try {
    const trace = shared.storage.getStore();
    const clean = sanitize(fields);
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      event,
      source: "web",
      ...(trace ? { traceId: trace.traceId, jobId: trace.jobId, projectId: trace.projectId, userId: trace.userId, route: trace.route } : {}),
      ...clean,
    };
    for (const key of ["jobId", "projectId", "userId", "route"] as const) if (entry[key] === undefined) delete entry[key];
    if (extra?.stack && toFile) entry.stack = scrub(cap(extra.stack, MAX_STACK));
    if (toFile) writeFileLine(entry);
    if (toConsole) writeConsole(entry, trace, extra?.stack);
  } catch {
    // Logging must never break a request.
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Public helpers (the first three keep their original signatures)

const WARN_EVENT = /_(failed|error|rejected|unavailable|misconfigured)$/;

export function logDebug(event: string, details?: LogFields) {
  log("debug", event, details);
}

export function logInfo(event: string, details?: Record<string, LogValue> | LogFields) {
  // Older call sites log failures through logInfo; surface them as warnings.
  log(WARN_EVENT.test(event) ? "warn" : "info", event, details);
}

export function logWarn(event: string, details?: LogFields) {
  log("warn", event, details);
}

export function logError(event: string, details?: Record<string, LogValue> | LogFields) {
  log("error", event, details);
}

/** Logs the one-line event (with `error` + `errorName`) and the stack trace (console + file, capped). */
export function logException(event: string, error: unknown, details?: Record<string, LogValue> | LogFields) {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
  log("error", event, { ...details, error: message, errorName: error instanceof Error ? error.name : typeof error, cause }, {
    stack: error instanceof Error ? error.stack : undefined,
  });
}

/**
 * Logs `<name>_started` (debug), runs `fn`, then `<name>_done` (info) with `durationMs` or `<name>_failed` (warn) with
 * the error. `fields` may be a function of the result to add fields to the `_done` line.
 */
export async function logSpan<T>(
  name: string,
  fields: LogFields,
  fn: () => Promise<T> | T,
  options: { resultFields?: (result: T) => LogFields; level?: LogLevel } = {},
): Promise<T> {
  const startedAt = performance.now();
  log("debug", `${name}_started`, fields);
  try {
    const result = await fn();
    log(options.level ?? "info", `${name}_done`, { ...fields, ...options.resultFields?.(result), durationMs: Math.round(performance.now() - startedAt) });
    return result;
  } catch (error) {
    const aborted = error instanceof Error && /ClientAborted|AbortError/.test(`${error.name}${error.constructor?.name ?? ""}`);
    log(aborted ? "info" : "warn", aborted ? `${name}_aborted` : `${name}_failed`, {
      ...fields,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Math.round(performance.now() - startedAt),
    });
    throw error;
  }
}

/** Milliseconds timer: `const done = startTimer(); …; done()` → elapsed ms (rounded). */
export function startTimer() {
  const startedAt = performance.now();
  return () => Math.round(performance.now() - startedAt);
}

/** Truncated preview of a prompt for logs (200 chars, whitespace collapsed). */
export function promptPreview(text: unknown) {
  if (typeof text !== "string") return undefined;
  return cap(text.replace(/\s+/g, " ").trim(), MAX_PROMPT);
}
