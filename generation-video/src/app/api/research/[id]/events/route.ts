import { withRouteLog } from "@/lib/route-log";
import { NextResponse } from "next/server";
import { agentErrorResponse, agentFetch, badSessionId } from "@/lib/research-agent";
import { logWarn } from "@/lib/runtime-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

/**
 * GET `?after=<seq>&follow=1` → `application/x-ndjson`, one event per line, flushed as the agent emits them:
 * `{ seq, type: "status"|"page"|"finding"|"question"|"answer"|"profile"|"published"|"error", at, … }`, plus
 * `{ type: "heartbeat", after }` every ~15 s while idle. The stream stays open until the session is done/stopped/error
 * (or 15 min; reconnect with `after` = last seq). `follow=0` returns the backlog and closes (for polling).
 */
async function routeGET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invalid = badSessionId(id);
  if (invalid) return invalid;
  const url = new URL(request.url);
  const after = Number(url.searchParams.get("after") ?? 0);
  if (!Number.isInteger(after) || after < 0) return NextResponse.json({ error: '"after" must be a non-negative integer (the last seq you saw).' }, { status: 400 });
  const follow = url.searchParams.get("follow") === "0" || url.searchParams.get("follow") === "false" ? "0" : "1";

  let upstream: Response;
  try {
    // No timeout: the agent ends the stream itself; the browser disconnecting aborts the upstream request.
    upstream = await agentFetch(`/research/${id}/events?after=${after}&follow=${follow}`, { signal: request.signal, timeoutMs: null });
  } catch (error) {
    return agentErrorResponse(error, "research_events");
  }
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    let body: Record<string, unknown> = { error: text.slice(0, 300) || `Research agent returned HTTP ${upstream.status}.` };
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // keep the raw text
    }
    if (upstream.status === 404 && body.error === "not found") {
      return NextResponse.json({ error: "The running agent doesn't have the research API yet — restart ./run to load the new agent code." }, { status: 501 });
    }
    return NextResponse.json(body, { status: upstream.status });
  }

  // Pass bytes through as they arrive (no buffering), and stop reading upstream when the browser goes away.
  const reader = upstream.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        // The browser leaving is normal; the agent dropping the stream is not. The client reconnects either way.
        if (!request.signal.aborted) logWarn("research_events_stream_failed", { error: error instanceof Error ? error.message : String(error) });
        controller.close();
      }
    },
    cancel() {
      void reader.cancel().catch(() => undefined);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}

export const GET = withRouteLog(routeGET);
