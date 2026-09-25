import { NextResponse } from "next/server";
import { ClientAbortedError, withProgress, type Emit } from "@/lib/progress";

/** Streaming is requested with `Accept: application/x-ndjson` or `?stream=1`. */
export function wantsStream(request: Request) {
  if ((request.headers.get("accept") ?? "").includes("application/x-ndjson")) return true;
  const stream = new URL(request.url).searchParams.get("stream");
  return stream === "1" || stream === "true";
}

export type ActionOutcome = { status: number; body: Record<string, unknown> };

/**
 * Runs `run` and returns either a plain JSON response (today's behaviour) or, when the client asked for it, an NDJSON
 * stream: progress events as they happen, then `{"type":"done", …body}` or `{"type":"error", status, error}`.
 * `run` must return the non-streaming body (and status) so both paths send identical results.
 */
export async function respondMaybeStreaming(request: Request, run: (emit: Emit) => Promise<ActionOutcome>) {
  if (!wantsStream(request)) {
    const outcome = await run(() => undefined);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }

  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (event: object) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal.addEventListener("abort", () => { closed = true; }, { once: true });

      void withProgress(write, request.signal, async () => {
        try {
          const outcome = await run(write);
          write(outcome.status >= 400
            ? { type: "error", status: outcome.status, ...outcome.body, error: String(outcome.body.error ?? "Request failed.") }
            : { type: "done", ...outcome.body });
        } catch (error) {
          if (!(error instanceof ClientAbortedError)) {
            write({ type: "error", status: 500, error: error instanceof Error ? error.message : String(error) });
          }
        } finally {
          close();
        }
      });
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

/** Adapts an existing JSON route handler (returning NextResponse.json) to `respondMaybeStreaming`. */
export async function outcomeOf(response: Response): Promise<ActionOutcome> {
  const body = await response.json().catch(() => ({ error: "The server returned a response that is not JSON." })) as Record<string, unknown>;
  return { status: response.status, body };
}

/** Wraps a JSON route handler so it can also stream NDJSON progress (headers/signal only; the handler reads the body). */
export function streamable<Args extends unknown[]>(handler: (request: Request, ...args: Args) => Promise<Response>) {
  return (request: Request, ...args: Args) => respondMaybeStreaming(request, async () => {
    try {
      return await outcomeOf(await handler(request, ...args));
    } catch (error) {
      if (error instanceof ClientAbortedError) throw error;
      return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
    }
  });
}
