import { fileSize, logFiles, matcher, parseFilter, parseLine, queryLogs, readRange } from "@/lib/log-reader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

const POLL_MS = 700;
const PING_MS = 15_000;

/**
 * GET /api/logs/stream?backfill=100&traceId=&jobId=&projectId=&level=&source=
 * NDJSON live tail of the log files: first up to `backfill` recent matching lines, then new lines as they are
 * written (web + agent). `{"type":"ping"}` lines keep the connection alive.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const filter = parseFilter(params);
  const backfill = Math.max(0, Math.min(1_000, Math.floor(Number(params.get("backfill") ?? 100)) || 0));
  const encoder = new TextEncoder();
  const match = matcher(filter);
  const offsets = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: object) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        } catch {
          closed = true;
        }
      };
      // Backfill from the query API, then follow every known file from its current end.
      if (backfill > 0) {
        const recent = await queryLogs({ ...filter, limit: backfill }).catch(() => null);
        for (const entry of recent?.entries ?? []) {
          match.learn(entry);
          send(entry);
        }
      }
      for (const item of await logFiles()) offsets.set(item.file, await fileSize(item.file));
      let lastPing = Date.now();
      const tick = async () => {
        if (closed) return;
        try {
          for (const item of await logFiles()) {
            const size = await fileSize(item.file);
            const known = offsets.get(item.file);
            // New file (daily rotation / agent started): read it from the start.
            const from = known === undefined ? 0 : known > size ? 0 : known;
            if (size <= from) {
              offsets.set(item.file, size);
              continue;
            }
            const text = await readRange(item.file, from, size);
            const complete = text.lastIndexOf("\n");
            if (complete < 0) continue;
            offsets.set(item.file, from + Buffer.byteLength(text.slice(0, complete + 1)));
            for (const line of text.slice(0, complete).split("\n")) {
              const entry = parseLine(line, item.source);
              if (!entry) continue;
              match.learn(entry);
              if (match.test(entry, line)) send(entry);
            }
          }
          if (Date.now() - lastPing > PING_MS) {
            lastPing = Date.now();
            send({ type: "ping", ts: new Date().toISOString() });
          }
        } catch {
          // Keep tailing.
        }
        if (!closed) timer = setTimeout(tick, POLL_MS);
      };
      request.signal.addEventListener("abort", () => {
        closed = true;
        if (timer) clearTimeout(timer);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }, { once: true });
      timer = setTimeout(tick, POLL_MS);
    },
    cancel() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
}
