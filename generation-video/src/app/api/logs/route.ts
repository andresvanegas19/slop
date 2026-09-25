import { NextResponse } from "next/server";
import { parseFilter, queryLogs } from "@/lib/log-reader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/logs?traceId=&jobId=&projectId=&since=&level=&source=&event=&q=&limit=
 * Reads output/logs/*.ndjson (web + agent). `since` = ISO time, ms epoch, or seconds ago (< 1e11).
 * jobId / projectId also pull in every line of the traces those lines belong to (e.g. the request that started the job).
 */
export async function GET(request: Request) {
  const filter = parseFilter(new URL(request.url).searchParams);
  try {
    return NextResponse.json(await queryLogs(filter), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
