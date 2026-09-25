/*
 * `withRouteLog(handler)`: wraps an App Router handler in a trace (see runtime-log.ts) and logs its entry/exit:
 * `route_started` (debug) and `route_done` (info, warn for 4xx, error for 5xx) with method, route, status and
 * durationMs. The trace id comes from the request's `X-Trace-Id` header (so a client can correlate) or is generated,
 * and is returned in the `X-Trace-Id` response header. For NDJSON streams, `route_done` marks the headers; the stream
 * end is logged as `route_stream_closed` with the total duration.
 */
import { installProcessLogging } from "@/lib/process-log";
import { currentTrace, log, newTraceId, runInTrace, startTimer, withTrace, type LogLevel } from "@/lib/runtime-log";

export const TRACE_HEADER = "X-Trace-Id";
const TRACE_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
/** Media / polling endpoints that would drown the log at info level. */
const QUIET_ROUTE = /^\/api\/(videos|assets|uploads\/[^/]+$|logs|jobs\/?$|jobs\/[^/]+$|rawtree\/status|research\/[^/]+$)/;

function idsFrom(pathname: string) {
  const project = /^\/api\/projects\/([^/]+)/.exec(pathname)?.[1];
  const job = /^\/api\/jobs\/([^/]+)/.exec(pathname)?.[1];
  return {
    projectId: project && project !== "from-upload" ? decodeURIComponent(project) : undefined,
    jobId: job ? decodeURIComponent(job) : undefined,
  };
}

function withHeader(response: Response, traceId: string) {
  try {
    response.headers.set(TRACE_HEADER, traceId);
    return response;
  } catch {
    // Immutable headers (e.g. Response.redirect): copy.
    const headers = new Headers(response.headers);
    headers.set(TRACE_HEADER, traceId);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

/** Logs when a streamed body finishes (or the client goes away), without changing what the client receives. */
function observeStream(response: Response, done: () => void): Response {
  if (!response.body) {
    done();
    return response;
  }
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      done();
    }
  };
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: end, value } = await reader.read();
        if (end) {
          controller.close();
          finish();
        } else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        finish();
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function withRouteLog<Req extends Request, Args extends unknown[]>(handler: (request: Req, ...args: Args) => Promise<Response> | Response) {
  return async (request: Req, ...args: Args): Promise<Response> => {
    // Idempotent; also covers a dev server that started before instrumentation.ts installed it.
    installProcessLogging();
    const url = new URL(request.url);
    const route = url.pathname;
    const incoming = request.headers.get(TRACE_HEADER);
    const traceId = incoming && TRACE_PATTERN.test(incoming) ? incoming : newTraceId();
    const user = request.headers.get("x-longform-user")?.slice(0, 64) || undefined;
    const quiet = QUIET_ROUTE.test(route);
    return withTrace({ traceId, route, userId: user, ...idsFrom(route), startedAt: Date.now() }, async () => {
      const elapsed = startTimer();
      const method = request.method;
      const query = url.search.length > 1 ? url.search.slice(0, 200) : undefined;
      log("debug", "route_started", { method, query, contentLength: Number(request.headers.get("content-length")) || undefined });
      try {
        const response = await handler(request, ...args);
        const status = response.status;
        const streamed = (response.headers.get("content-type") ?? "").includes("ndjson");
        const level: LogLevel = status >= 500 ? "error" : status >= 400 ? "warn" : quiet ? "debug" : "info";
        log(level, "route_done", { method, status, streamed: streamed || undefined, durationMs: elapsed() });
        const tagged = withHeader(response, traceId);
        if (!streamed) return tagged;
        const trace = currentTrace();
        return observeStream(tagged, () => runInTrace(trace, () => log(quiet ? "debug" : "info", "route_stream_closed", { method, status, durationMs: elapsed() })));
      } catch (error) {
        log("error", "route_failed", { method, error: error instanceof Error ? error.message : String(error), durationMs: elapsed() });
        throw error;
      }
    });
  };
}
