import { NextResponse } from "next/server";
import { followJob, type StoredEvent } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

const HEARTBEAT_MS = 15_000;

/**
 * GET `?after=<seq>` → NDJSON: `{"type":"job",…}` first, then every event after `seq` (replay), then live events until
 * the job ends with `{"type":"done",…}` / `{"type":"error",…}` (same shapes as the streaming routes). Heartbeats
 * (`{"type":"heartbeat"}`) every 15s. An interrupted job ends with an error event carrying `interrupted: true`.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const after = Math.max(0, Number(new URL(request.url).searchParams.get("after")) || 0);
  const encoder = new TextEncoder();
  let cleanup = () => undefined as void;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
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
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const onEvent = (event: StoredEvent) => {
        write(event);
        if (event.type === "done" || event.type === "error") close();
      };
      const followed = await followJob(id, after, onEvent);
      if (!followed) {
        write({ type: "error", status: 404, error: "Job not found." });
        close();
        return;
      }
      const { job, replay, following, unsubscribe } = followed;
      const heartbeat = setInterval(() => write({ type: "heartbeat", ts: Date.now() }), HEARTBEAT_MS);
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.signal.addEventListener("abort", close, { once: true });
      write({ type: "job", id: job.id, kind: job.kind, status: job.status, attempt: job.attempt, createdAt: job.createdAt, projectId: job.projectId, ts: Date.parse(job.startedAt ?? job.createdAt) });
      for (const event of replay) write(event);
      if (following) return;
      const ended = replay.some((event) => event.type === "done" || event.type === "error");
      if (!ended) {
        write(job.status === "interrupted"
          ? { type: "error", status: 503, error: "Interrupted by a server restart.", interrupted: true }
          : job.status === "cancelled"
          ? { type: "error", status: 499, error: "Cancelled.", cancelled: true }
          : job.status === "done"
          ? { type: "done", ...job.result }
          : { type: "error", status: job.httpStatus ?? 500, error: job.error ?? "The job failed." });
      }
      close();
    },
    cancel() {
      cleanup();
    },
  });
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
