import { AsyncLocalStorage } from "node:async_hooks";
import { logProgressEvent } from "@/lib/progress-log";

export type ProgressStage = "intent" | "guidance" | "prompt" | "image" | "video" | "splice" | "render" | "save";

export type ProgressEvent =
  | { type: "stage"; stage: ProgressStage; label: string; at?: number }
  | { type: "intent"; action: string; detectedBy: string; atEnd: boolean; window?: { startSec: number; endSec: number } }
  | { type: "token"; field: "enhancedPrompt" | "reply"; text: string }
  | { type: "prompt"; enhancedPrompt: string }
  | { type: "preview"; imageUrl: string; label: string; storyId?: string; beat?: number }
  /** /api/stories: a story was written (stills follow as `preview` events with storyId + beat). */
  | { type: "story"; story: Record<string, unknown> }
  /** /api/stories/:id/render: per-story render status. */
  | { type: "story_status"; storyId: string; status: string; elapsedMs: number; projectId?: string; videoUrl?: string; error?: string }
  | { type: "progress"; stage: "image" | "video"; status: string; progress?: number; elapsedMs: number }
  /** Internal (jobs): a BFL request was submitted; `step` identifies it so a resumed job can poll it instead of paying again. */
  | { type: "bfl_pending"; step: string; pollingUrl: string }
  /** Internal (jobs): a deterministic-enough intermediate result (e.g. an LLM answer) a resumed job may reuse. */
  | { type: "memo"; step: string; value: string }
  | { type: "done"; [key: string]: unknown }
  | { type: "error"; status: number; error: string };

export type Emit = (event: ProgressEvent) => void;

/** Thrown when the streaming client disconnected; callers stop waiting (the remote BFL job may keep running). */
export class ClientAbortedError extends Error {
  constructor() {
    super("The client disconnected; stopped waiting.");
  }
}

/** Set by background jobs (src/lib/jobs.ts) being resumed: BFL polling URLs / LLM answers of the previous attempt. */
export type JobMemo = { take(step: string): string | undefined };

type Context = { emit: Emit; signal?: AbortSignal; startedAt: number; memo?: JobMemo };

const storage = new AsyncLocalStorage<Context>();

/**
 * Runs `task` with a progress sink + abort signal that deep helpers (BFL polling, OpenRouter streaming, frame edits)
 * pick up without threading parameters through every call. Stage events get `at` = ms since start.
 */
export function withProgress<T>(emit: Emit, signal: AbortSignal | undefined, task: () => Promise<T>, options: { memo?: JobMemo } = {}): Promise<T> {
  const startedAt = Date.now();
  // Nested scopes (parallel sub-tasks with a private sink) keep the job's resume state.
  const memo = options.memo ?? storage.getStore()?.memo;
  // Only the outermost sink mirrors events into the server log (nested sinks forward to it).
  const logged = !storage.getStore();
  const safeEmit: Emit = (event) => {
    if (logged) logProgressEvent(event, Date.now() - startedAt);
    if (signal?.aborted) return;
    try {
      emit(event.type === "stage" ? { ...event, at: Date.now() - startedAt } : event);
    } catch {
      // A failing sink (closed stream) must never break the work itself.
    }
  };
  return storage.run({ emit: safeEmit, signal, startedAt, memo }, task);
}

/** Emits an event to the current request's stream (no-op outside a streaming request). */
export function emitEvent(event: ProgressEvent) {
  storage.getStore()?.emit(event);
}

export function emitStage(stage: ProgressStage, label: string) {
  emitEvent({ type: "stage", stage, label });
}

/** Whether anyone is listening (lets callers skip work like token streaming for plain JSON requests). */
export function isStreaming() {
  return Boolean(storage.getStore());
}

/**
 * What the interrupted attempt of the current (resumed) background job recorded for `step` — a BFL polling URL
 * (< 1h old) or an LLM answer — consumed once. Undefined outside a resumed job.
 */
export function takeJobMemo(step: string) {
  return storage.getStore()?.memo?.take(step);
}

/** Records `value` for `step` so a resume of the current background job can reuse it (no-op outside jobs). */
export function recordJobMemo(step: string, value: string) {
  emitEvent({ type: "memo", step, value });
}

export function progressSignal() {
  return storage.getStore()?.signal;
}

export function throwIfClientAborted() {
  if (storage.getStore()?.signal?.aborted) throw new ClientAbortedError();
}

/** setTimeout that rejects with ClientAbortedError as soon as the client disconnects. */
export function abortableDelay(ms: number) {
  const signal = progressSignal();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ClientAbortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ClientAbortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The current request's progress sink (undefined outside a streaming request). Lets parallel sub-tasks run in their own
 * withProgress() context and aggregate their events before forwarding them here.
 */
export function currentEmitter(): Emit | undefined {
  return storage.getStore()?.emit;
}
