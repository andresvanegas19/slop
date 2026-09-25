import { NextResponse } from "next/server";
import { actionErrorResponse, cutProjectRange } from "@/lib/project-actions";
import { logException } from "@/lib/runtime-log";

export const runtime = "nodejs";
export const maxDuration = 300;

/** POST `{ rangeStartSec, rangeEndSec }` → `{ project, removed: { startSec, endSec } }`: removes that project-time range. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await request.json().catch(() => ({})) as { rangeStartSec?: unknown; rangeEndSec?: unknown };
    const start = body.rangeStartSec;
    const end = body.rangeEndSec;
    if (typeof start !== "number" || !Number.isFinite(start) || typeof end !== "number" || !Number.isFinite(end)) {
      return NextResponse.json({ error: `"rangeStartSec" and "rangeEndSec" must be finite numbers of seconds (got ${JSON.stringify(start)} and ${JSON.stringify(end)}).` }, { status: 400 });
    }
    return NextResponse.json(await cutProjectRange(id, start, end));
  } catch (error) {
    const { status, message } = actionErrorResponse(error, "Unable to cut the range.");
    logException("project_cut_failed", error, { projectId: id, status, reason: message });
    return NextResponse.json({ error: message }, { status });
  }
}
