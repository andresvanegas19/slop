/*
 * Client side of background jobs (server: src/lib/jobs.ts). Every generation/edit is started with `?job=1`, which
 * answers `202 { jobId }` at once; progress then comes from GET /api/jobs/:id/events (replay + live NDJSON). The job id
 * is remembered in localStorage (`longform.jobs.v1`) so a reload re-attaches to it instead of losing the work.
 */
import { NDJSON_TYPE, createLineSplitter, parseStreamLine, type StreamEvent } from "./ndjson";
import type { StreamOutcome } from "./stream";
import { readJson } from "./utils";
import { userHeaders } from "./hooks/storage";

export const JOBS_KEY = "longform.jobs.v1";

/** What the UI needs to rebuild an operation after a reload (`op` = the params of the studio action). */
export type StoredJob = {
  jobId: string;
  kind: string;
  projectId?: string;
  prompt: string;
  startedAt: number;
  op?: Record<string, unknown>;
  /** Set when the server reported the job as interrupted by a restart (the UI offers Resume). */
  interrupted?: boolean;
};

export type JobSnapshot = { id: string; kind: string; status: "queued" | "running" | "done" | "error" | "cancelled" | "interrupted"; createdAt: string; projectId?: string; prompt?: string; error?: string };

const listeners = new Set<() => void>();

export function loadStoredJobs(): StoredJob[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(JOBS_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is StoredJob => Boolean(entry) && typeof (entry as StoredJob).jobId === "string" && typeof (entry as StoredJob).kind === "string") : [];
  } catch {
    return [];
  }
}

function writeStoredJobs(entries: StoredJob[]) {
  try {
    window.localStorage.setItem(JOBS_KEY, JSON.stringify(entries.slice(-20)));
  } catch (caughtError) {
    console.error("[jobs] could not remember the running job", caughtError);
  }
  listeners.forEach((listener) => listener());
}

export function saveStoredJob(entry: StoredJob) {
  writeStoredJobs([...loadStoredJobs().filter((item) => item.jobId !== entry.jobId), entry]);
}

export function updateStoredJob(jobId: string, change: Partial<StoredJob>) {
  writeStoredJobs(loadStoredJobs().map((item) => item.jobId === jobId ? { ...item, ...change } : item));
}

export function removeStoredJob(jobId: string) {
  writeStoredJobs(loadStoredJobs().filter((item) => item.jobId !== jobId));
}

export function subscribeStoredJobs(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function fetchJob(jobId: string): Promise<JobSnapshot | null> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { headers: userHeaders(), cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not check the job (HTTP ${response.status}).`);
  const body = await response.json() as { job?: JobSnapshot };
  return body.job ?? null;
}

export async function fetchActiveJobs(): Promise<JobSnapshot[]> {
  const response = await fetch("/api/jobs?active=1", { headers: userHeaders(), cache: "no-store" });
  if (!response.ok) return [];
  const body = await response.json() as { jobs?: JobSnapshot[] };
  return Array.isArray(body.jobs) ? body.jobs : [];
}

export function cancelJob(jobId: string) {
  return fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", headers: userHeaders(), keepalive: true }).catch(() => undefined);
}

export async function resumeJob(jobId: string) {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/resume`, { method: "POST", headers: userHeaders() });
  const body = await readJson<{ error?: unknown }>(response);
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Could not resume (HTTP ${response.status}).`);
}

function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(abortError());
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(abortError());
  }, { once: true });
});

/** When the event carries the server time it happened at (`ts`), use it so replayed steps keep their real timing. */
export function eventTime(event: StreamEvent) {
  const ts = (event as { ts?: unknown }).ts;
  return typeof ts === "number" && Number.isFinite(ts) ? Math.min(ts, Date.now()) : Date.now();
}

/**
 * Follows a job's event stream until it ends (reconnecting if the connection drops), passing every event (the first
 * is `{type:"job"}`, useful for the start time) to `onEvent`. Aborting `signal` cancels the job on the server.
 */
export async function followJob<T extends object>(jobId: string, onEvent: (event: StreamEvent, at: number) => void, signal?: AbortSignal): Promise<StreamOutcome<T>> {
  let after = 0;
  let failures = 0;
  const onAbort = () => void cancelJob(jobId);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      let outcome: StreamOutcome<T> | null = null;
      try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/events?after=${after}`, { headers: { ...userHeaders(), Accept: NDJSON_TYPE }, signal, cache: "no-store" });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const lines = createLineSplitter();
        const handle = (line: string) => {
          const event = parseStreamLine(line);
          if (!event || outcome) return;
          const seq = (event as { seq?: unknown }).seq;
          if (typeof seq === "number") {
            if (seq <= after) return;
            after = seq;
          }
          if (event.type === "done") {
            const { type: _type, seq: _seq, ts: _ts, ...result } = event as Record<string, unknown>;
            void _type; void _seq; void _ts;
            outcome = { ok: true, status: 200, result: result as T, streamed: true };
          } else if (event.type === "error") {
            const status = typeof event.status === "number" ? event.status : 500;
            outcome = { ok: false, status, result: { ...(event as object), error: event.error } as T, streamed: true };
          } else if ((event.type as string) !== "heartbeat") {
            // Reconnects skip the `job` header after the first connection has set up the view.
            if ((event.type as string) === "job" && after > 0) return;
            onEvent(event, eventTime(event));
          }
        };
        while (!outcome) {
          const { done, value } = await reader.read();
          if (done) break;
          lines.push(decoder.decode(value, { stream: true })).forEach(handle);
          failures = 0;
        }
        if (!outcome) [...lines.push(decoder.decode()), ...lines.flush()].forEach(handle);
        if (outcome) {
          void reader.cancel().catch(() => undefined);
          return outcome;
        }
      } catch (caughtError) {
        if (signal?.aborted) throw abortError();
        failures += 1;
        // The server may be restarting: keep trying for ~2 minutes (a reload also picks the job up again).
        if (failures > 40) {
          return { ok: false, status: 503, result: { error: `Lost the connection to the server (${caughtError instanceof Error ? caughtError.message : "network error"}). Reload to pick the job up again.`, lost: true } as T, streamed: true };
        }
      }
      await wait(failures > 3 ? 3_000 : 750, signal);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export type RunJobOptions = {
  method?: "POST" | "DELETE";
  /** Stored with the job id so a reload can rebuild the UI (see useStudio's restore). */
  meta: Omit<StoredJob, "jobId" | "startedAt">;
  /** Re-attach to this existing job instead of starting a new one. */
  attach?: string;
  nonJsonError?: (status: number) => string;
  onJob?: (jobId: string) => void;
};

/**
 * Drop-in replacement for streamJson(): starts `url` as a background job (or re-attaches to `options.attach`), follows
 * its progress, and resolves with the final result. The job id stays in localStorage until the result has been
 * handled; interrupted jobs stay listed (flagged) so the UI can offer Resume.
 */
export async function runJob<T extends object>(
  url: string,
  body: unknown,
  onEvent: (event: StreamEvent, at: number) => void,
  signal: AbortSignal | undefined,
  options: RunJobOptions,
): Promise<StreamOutcome<T> & { jobId?: string }> {
  let jobId = options.attach;
  if (!jobId) {
    const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}job=1`, {
      method: options.method ?? "POST",
      headers: body === undefined ? { ...userHeaders(), Prefer: "respond-async" } : { ...userHeaders(), "Content-Type": "application/json", Prefer: "respond-async" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const parsed = contentType.includes("application/json") || !contentType.includes(NDJSON_TYPE)
      ? await readJson<Record<string, unknown>>(response, options.nonJsonError?.(response.status))
      : {};
    if (response.status !== 202 || typeof parsed.jobId !== "string") {
      // A server without job mode answered directly (plain JSON result or error).
      return { ok: response.ok, status: response.status, result: parsed as T, streamed: false };
    }
    jobId = parsed.jobId;
    saveStoredJob({ ...options.meta, jobId, startedAt: Date.now() });
  }
  options.onJob?.(jobId);
  let outcome: StreamOutcome<T>;
  try {
    outcome = await followJob<T>(jobId, onEvent, signal);
  } catch (caughtError) {
    removeStoredJob(jobId);
    throw caughtError;
  }
  const flags = outcome.result as { interrupted?: unknown; lost?: unknown };
  if (flags.interrupted === true) updateStoredJob(jobId, { interrupted: true });
  else if (flags.lost !== true) removeStoredJob(jobId);
  return { ...outcome, jobId };
}
