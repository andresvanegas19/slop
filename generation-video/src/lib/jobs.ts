/*
 * Background jobs: a generation/edit request can run detached from the HTTP request that started it (`?job=1` or
 * `Prefer: respond-async`, see job-route.ts). The job keeps its own AbortController (explicit cancel only), streams
 * progress into an event log persisted at output/jobs/<id>.json, and any number of clients can replay + follow it
 * (GET /api/jobs/:id/events). Survives page reloads and Turbopack HMR (registry on globalThis); after a real server
 * restart, jobs that were running are marked `interrupted` and can be resumed (re-run from their input, reusing BFL
 * requests and LLM answers the interrupted attempt already paid for — see progress.ts `takeJobMemo`).
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ClientAbortedError, withProgress, type JobMemo, type ProgressEvent } from "@/lib/progress";
import { logException, logInfo } from "@/lib/runtime-log";

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled" | "interrupted";
export type JobInput = {
  /** Path + query of the original route (job flags removed). */
  path: string;
  method: string;
  /** Headers replayed to the handler (content-type, X-Longform-User). */
  headers: Record<string, string>;
  body: string;
  /** Awaited route params (e.g. `{ id }`). */
  params: Record<string, string> | null;
  userId: string;
};
export type StoredEvent = ProgressEvent & { seq: number; ts: number };
type MemoEntry = { value: string; at: number };
export type JobRecord = {
  id: string;
  kind: string;
  status: JobStatus;
  input: JobInput;
  events: StoredEvent[];
  /** Last sequence number handed out (events may be coalesced/dropped, so seq ≠ index). */
  seq: number;
  result?: Record<string, unknown>;
  httpStatus?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  projectId?: string;
  /** The user's text (prompt / message), for listing. */
  prompt?: string;
  attempt: number;
  /** BFL polling URLs + LLM answers recorded by this attempt, keyed by step (see bfl.ts / openrouter.ts). */
  memo: Record<string, MemoEntry[]>;
};
export type ActionOutcome = { status: number; body: Record<string, unknown> };
export type JobRunner = (job: JobRecord) => Promise<ActionOutcome>;
export type JobListener = (event: StoredEvent) => void;

const MAX_EVENTS = 500;
const SAVE_DEBOUNCE_MS = 250;
const MEMO_MAX_AGE_MS = 60 * 60 * 1000;
const KEEP_FINISHED_MS = 7 * 24 * 60 * 60 * 1000;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERMINAL: JobStatus[] = ["done", "error", "cancelled", "interrupted"];

type LiveJob = {
  job: JobRecord;
  runner: JobRunner;
  controller: AbortController;
  listeners: Set<JobListener>;
  saveTimer: ReturnType<typeof setTimeout> | null;
  saving: Promise<void>;
  /** Memo of the interrupted attempt(s), consumed by this attempt. */
  previousMemo: Record<string, MemoEntry[]>;
};

type Registry = { jobs: Map<string, LiveJob>; queue: string[]; running: Set<string>; boot: Promise<void> | null; resumeToken: string };

// On globalThis so Turbopack HMR re-evaluating this module keeps running jobs (a real restart clears it).
const registry: Registry = ((globalThis as { __longformJobs?: Registry }).__longformJobs ??= {
  jobs: new Map(),
  queue: [],
  running: new Set(),
  boot: null,
  resumeToken: randomUUID(),
});

export function jobsDirectory() {
  return path.join(process.cwd(), "output", "jobs");
}

function jobFile(id: string) {
  return path.join(jobsDirectory(), `${id}.json`);
}

export function isJobId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function isTerminal(status: JobStatus) {
  return TERMINAL.includes(status);
}

function maxRunning() {
  const configured = Number(process.env.JOBS_MAX_RUNNING);
  return Number.isInteger(configured) && configured > 0 ? configured : 3;
}

/** Secret that lets /api/jobs/:id/resume re-enter a route in "resume" mode (see job-route.ts). */
export function resumeToken() {
  return registry.resumeToken;
}

async function writeJob(job: JobRecord) {
  await mkdir(jobsDirectory(), { recursive: true });
  const target = jobFile(job.id);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(job));
  await rename(temporary, target);
}

function save(live: LiveJob, immediate = false) {
  live.job.updatedAt = new Date().toISOString();
  if (live.saveTimer) {
    clearTimeout(live.saveTimer);
    live.saveTimer = null;
  }
  const flush = () => {
    live.saveTimer = null;
    live.saving = live.saving.then(() => writeJob(live.job)).catch((error) => logException("job_save_failed", error, { jobId: live.job.id }));
  };
  if (immediate) flush();
  else live.saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  return live.saving;
}

async function readJob(id: string): Promise<JobRecord | null> {
  try {
    return JSON.parse(await readFile(jobFile(id), "utf8")) as JobRecord;
  } catch {
    return null;
  }
}

/** First access after a (re)start: jobs left running/queued by a previous process are interrupted; old files go. */
function ensureBoot() {
  registry.boot ??= (async () => {
    let names: string[] = [];
    try {
      names = (await readdir(jobsDirectory())).filter((name) => name.endsWith(".json"));
    } catch {
      return;
    }
    const now = Date.now();
    await Promise.all(names.map(async (name) => {
      const id = name.slice(0, -5);
      if (registry.jobs.has(id)) return;
      const job = await readJob(id);
      if (!job) return;
      if (job.status === "running" || job.status === "queued") {
        job.status = "interrupted";
        job.error = "Interrupted by a server restart.";
        job.updatedAt = new Date().toISOString();
        await writeJob(job).catch(() => undefined);
        logInfo("job_interrupted", { jobId: id, kind: job.kind });
      } else if (isTerminal(job.status) && now - Date.parse(job.updatedAt) > KEEP_FINISHED_MS) {
        await unlink(jobFile(id)).catch(() => undefined);
      }
    }));
  })().catch((error) => logException("job_boot_scan_failed", error));
  return registry.boot;
}

function pushEvent(live: LiveJob, event: ProgressEvent) {
  const job = live.job;
  const stored = { ...event, seq: ++job.seq, ts: Date.now() } as StoredEvent;
  const last = job.events[job.events.length - 1];
  if (stored.type === "token" && last?.type === "token" && last.field === stored.field) {
    // Coalesce streamed tokens in the log (live listeners still get each one).
    job.events[job.events.length - 1] = { ...last, text: last.text + stored.text, seq: stored.seq, ts: stored.ts };
  } else {
    job.events.push(stored);
    if (job.events.length > MAX_EVENTS) {
      const droppable = (types: string[]) => job.events.findIndex((item, index) => index < job.events.length - 1 && types.includes(item.type));
      let index = droppable(["progress"]);
      if (index < 0) index = droppable(["token", "preview", "intent", "prompt", "story_status"]);
      job.events.splice(Math.max(0, index), 1);
    }
  }
  for (const listener of live.listeners) {
    try {
      listener(stored);
    } catch {
      // A broken listener (closed stream) must never break the job.
    }
  }
}

function record(live: LiveJob, step: string, value: string, at = Date.now()) {
  (live.job.memo[step] ??= []).push({ value, at });
}

function memoFor(live: LiveJob): JobMemo | undefined {
  if (Object.keys(live.previousMemo).length === 0) return undefined;
  return {
    take(step) {
      const entries = live.previousMemo[step];
      while (entries?.length) {
        const entry = entries.shift()!;
        if (step.startsWith("image:") || step.startsWith("video:") ? Date.now() - entry.at < MEMO_MAX_AGE_MS : true) {
          record(live, step, entry.value, entry.at);
          return entry.value;
        }
      }
      return undefined;
    },
  };
}

function finish(live: LiveJob, status: JobStatus, outcome: { event: ProgressEvent; result?: Record<string, unknown>; httpStatus?: number; error?: string }) {
  const job = live.job;
  job.status = status;
  job.finishedAt = new Date().toISOString();
  job.result = outcome.result;
  job.httpStatus = outcome.httpStatus;
  job.error = outcome.error;
  const project = outcome.result?.project as { id?: unknown } | undefined;
  if (!job.projectId && typeof project?.id === "string") job.projectId = project.id;
  pushEvent(live, outcome.event);
  live.listeners.clear();
  registry.running.delete(job.id);
  void save(live, true);
  logInfo("job_finished", { jobId: job.id, kind: job.kind, status, attempt: job.attempt, ms: Date.now() - Date.parse(job.startedAt ?? job.createdAt) });
  pump();
}

async function execute(live: LiveJob) {
  const job = live.job;
  const { signal } = live.controller;
  job.status = "running";
  job.startedAt = new Date().toISOString();
  void save(live, true);
  logInfo("job_started", { jobId: job.id, kind: job.kind, attempt: job.attempt });
  const emit = (event: ProgressEvent) => {
    if (event.type === "bfl_pending") {
      record(live, event.step, event.pollingUrl);
      void save(live);
      return;
    }
    if (event.type === "memo") {
      record(live, event.step, event.value);
      return;
    }
    pushEvent(live, event);
    save(live);
  };
  try {
    const outcome = await withProgress(emit, signal, () => live.runner(job), { memo: memoFor(live) });
    if (signal.aborted) {
      finish(live, "cancelled", { event: { type: "error", status: 499, error: "Cancelled." }, error: "Cancelled." });
    } else if (outcome.status >= 400) {
      const error = String(outcome.body.error ?? "Request failed.");
      finish(live, "error", { event: { type: "error", ...outcome.body, status: outcome.status, error }, result: outcome.body, httpStatus: outcome.status, error });
    } else {
      finish(live, "done", { event: { type: "done", ...outcome.body }, result: outcome.body, httpStatus: outcome.status });
    }
  } catch (error) {
    if (signal.aborted || error instanceof ClientAbortedError) {
      finish(live, "cancelled", { event: { type: "error", status: 499, error: "Cancelled." }, error: "Cancelled." });
      return;
    }
    logException("job_failed", error, { jobId: job.id, kind: job.kind });
    const message = error instanceof Error ? error.message : String(error);
    finish(live, "error", { event: { type: "error", status: 500, error: message }, httpStatus: 500, error: message });
  }
}

function pump() {
  while (registry.running.size < maxRunning() && registry.queue.length > 0) {
    const id = registry.queue.shift()!;
    const live = registry.jobs.get(id);
    if (!live || live.job.status !== "queued") continue;
    registry.running.add(id);
    void execute(live);
  }
}

function enqueue(live: LiveJob) {
  registry.jobs.set(live.job.id, live);
  registry.queue.push(live.job.id);
  if (registry.running.size >= maxRunning()) {
    pushEvent(live, { type: "stage", stage: "intent", label: "Waiting for another generation to finish…" });
  }
  void save(live, true);
  pump();
}

function promptOf(body: string) {
  try {
    const parsed = JSON.parse(body) as { prompt?: unknown; message?: unknown };
    const text = typeof parsed.prompt === "string" ? parsed.prompt : typeof parsed.message === "string" ? parsed.message : "";
    return text.trim().slice(0, 500) || undefined;
  } catch {
    return undefined;
  }
}

/** Creates a job and runs `runner` detached from the request (queued if JOBS_MAX_RUNNING are already running). */
export async function startJob(kind: string, input: JobInput, runner: JobRunner): Promise<JobRecord> {
  await ensureBoot();
  const now = new Date().toISOString();
  const job: JobRecord = {
    id: randomUUID(),
    kind,
    status: "queued",
    input,
    events: [],
    seq: 0,
    createdAt: now,
    updatedAt: now,
    projectId: input.params?.id,
    prompt: promptOf(input.body),
    attempt: 1,
    memo: {},
  };
  enqueue({ job, runner, controller: new AbortController(), listeners: new Set(), saveTimer: null, saving: Promise.resolve(), previousMemo: {} });
  logInfo("job_queued", { jobId: job.id, kind });
  return job;
}

/**
 * Re-runs an interrupted/failed/cancelled job from its stored input (same id, fresh event log). BFL requests and LLM
 * answers recorded by the previous attempt are offered to this attempt (see progress.ts takeJobMemo).
 */
export async function resumeStoredJob(id: string, runner: JobRunner): Promise<JobRecord | { error: string; status: number }> {
  await ensureBoot();
  if (registry.jobs.get(id) && !isTerminal(registry.jobs.get(id)!.job.status)) return { error: "This job is still running.", status: 409 };
  const job = registry.jobs.get(id)?.job ?? await readJob(id);
  if (!job) return { error: "Job not found.", status: 404 };
  if (job.status === "done") return { error: "This job already finished.", status: 409 };
  const previousMemo = job.memo ?? {};
  job.status = "queued";
  job.attempt = (job.attempt ?? 1) + 1;
  job.events = [];
  job.memo = {};
  job.result = undefined;
  job.error = undefined;
  job.httpStatus = undefined;
  job.finishedAt = undefined;
  const live: LiveJob = { job, runner, controller: new AbortController(), listeners: new Set(), saveTimer: null, saving: Promise.resolve(), previousMemo };
  pushEvent(live, { type: "stage", stage: "intent", label: "Resuming after a server restart…" });
  enqueue(live);
  logInfo("job_resumed", { jobId: id, kind: job.kind, attempt: job.attempt, memoSteps: Object.keys(previousMemo).length });
  return job;
}

export async function getJob(id: string): Promise<JobRecord | null> {
  if (!isJobId(id)) return null;
  await ensureBoot();
  return registry.jobs.get(id)?.job ?? readJob(id);
}

/** Jobs of this user that still need attention (queued, running, or interrupted). */
export async function listJobs(filter: { userId: string; active: boolean }) {
  await ensureBoot();
  const byId = new Map<string, JobRecord>();
  try {
    const names = (await readdir(jobsDirectory())).filter((name) => name.endsWith(".json"));
    const recent = await Promise.all(names.map(async (name) => {
      const file = path.join(jobsDirectory(), name);
      const info = await stat(file).catch(() => null);
      return info && Date.now() - info.mtimeMs < KEEP_FINISHED_MS ? name.slice(0, -5) : null;
    }));
    await Promise.all(recent.filter((id): id is string => Boolean(id)).map(async (id) => {
      const job = registry.jobs.get(id)?.job ?? await readJob(id);
      if (job) byId.set(id, job);
    }));
  } catch {
    // no jobs directory yet
  }
  for (const [id, live] of registry.jobs) byId.set(id, live.job);
  return [...byId.values()]
    .filter((job) => job.input.userId === filter.userId)
    .filter((job) => !filter.active || job.status === "queued" || job.status === "running" || job.status === "interrupted")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Snapshot for clients: no memo, and events only when asked. */
export function publicJob(job: JobRecord, options: { events?: boolean } = {}) {
  const { memo: _memo, input, events, ...rest } = job;
  void _memo;
  return {
    ...rest,
    input: { path: input.path, method: input.method, params: input.params },
    eventCount: events.length,
    ...(options.events ? { events } : {}),
  };
}

export async function cancelJob(id: string): Promise<JobRecord | null> {
  const live = registry.jobs.get(id);
  if (live && !isTerminal(live.job.status)) {
    live.controller.abort();
    if (live.job.status === "queued") {
      registry.queue = registry.queue.filter((queued) => queued !== id);
      finish(live, "cancelled", { event: { type: "error", status: 499, error: "Cancelled." }, error: "Cancelled." });
    }
    // A running job finishes as "cancelled" once its work notices the abort (BFL polling / LLM streaming check it).
    return live.job;
  }
  const job = await getJob(id);
  if (job && job.status === "interrupted") {
    job.status = "cancelled";
    job.error = "Cancelled.";
    job.updatedAt = new Date().toISOString();
    await writeJob(job);
  }
  return job;
}

/**
 * Replays events after `after` and (if the job is live) subscribes to new ones — atomically, so nothing is missed.
 * Returns the replay, whether more will come, and an unsubscribe function.
 */
export async function followJob(id: string, after: number, listener: JobListener) {
  const job = await getJob(id);
  if (!job) return null;
  const live = registry.jobs.get(id);
  const replay = job.events.filter((event) => event.seq > after);
  if (live && !isTerminal(live.job.status)) {
    live.listeners.add(listener);
    return { job, replay, following: true, unsubscribe: () => live.listeners.delete(listener) };
  }
  return { job, replay, following: false, unsubscribe: () => undefined };
}
