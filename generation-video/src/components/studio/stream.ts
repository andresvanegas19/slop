/*
 * NDJSON progress streaming. Requests ask for `application/x-ndjson`; servers that stream send one JSON event
 * per line ending with {"type":"done",...result} or {"type":"error",...}. Servers that don't stream answer with
 * plain JSON, which is handled exactly like before (readJson), so callers work either way.
 */
import { NDJSON_TYPE, createLineSplitter, parseStreamLine, type StreamEvent } from "./ndjson";
import { readJson } from "./utils";
import { userHeaders } from "./hooks/storage";

export type { StreamEvent };

export type StreamOutcome<T> = { ok: boolean; status: number; result: T; streamed: boolean };

/**
 * POSTs `body` as JSON and reports progress events through `onEvent`.
 * Resolves with the final result (the `done` event minus `type`, or the plain JSON body) and whether it succeeded.
 */
export async function streamJson<T extends object>(
  url: string,
  body: unknown,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
  nonJsonError?: (status: number) => string,
): Promise<StreamOutcome<T>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...userHeaders(), "Content-Type": "application/json", Accept: `${NDJSON_TYPE}, application/json` },
    body: JSON.stringify(body),
    signal,
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes(NDJSON_TYPE) || !response.body) {
    return { ok: response.ok, status: response.status, result: await readJson<T>(response, nonJsonError?.(response.status)), streamed: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const lines = createLineSplitter();
  const state: { outcome: StreamOutcome<T> | null } = { outcome: null };
  const handle = (line: string) => {
    const event = parseStreamLine(line);
    if (!event || state.outcome) return;
    if (event.type === "done") {
      const { type: _type, ...result } = event;
      void _type;
      state.outcome = { ok: response.ok, status: response.status, result: result as T, streamed: true };
    } else if (event.type === "error") {
      state.outcome = { ok: false, status: typeof event.status === "number" ? event.status : response.ok ? 500 : response.status, result: { error: event.error } as T, streamed: true };
    } else {
      onEvent(event);
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    lines.push(decoder.decode(value, { stream: true })).forEach(handle);
    if (state.outcome) {
      void reader.cancel().catch(() => undefined);
      break;
    }
  }
  if (!state.outcome) [...lines.push(decoder.decode()), ...lines.flush()].forEach(handle);
  if (!state.outcome) {
    console.error(`[stream] ${url} ended without a result`);
    return { ok: false, status: response.status, result: { error: "The server stopped sending progress before the result arrived." } as T, streamed: true };
  }
  return state.outcome;
}
