import { NextResponse } from "next/server";
import { describeError } from "@/lib/bfl";
import { loadProject, ProjectNotFoundError, saveProject, withProjectLock } from "@/lib/projects";
import { logException, logInfo } from "@/lib/runtime-log";
import { cutRange, TimelineError } from "@/lib/timeline-ops";

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
    if (!(start < end)) return NextResponse.json({ error: `rangeStartSec (${start}) must be less than rangeEndSec (${end}).` }, { status: 400 });

    const result = await withProjectLock(id, async () => {
      const project = await loadProject(id);
      const removed = { startSec: Math.max(0, Math.round(start * 1000) / 1000), endSec: Math.min(project.durationSeconds, Math.round(end * 1000) / 1000) };
      const updated = await cutRange(project, start, end);
      await saveProject(updated);
      return { project: updated, removed };
    });
    logInfo("project_cut_completed", { projectId: id, startSec: result.removed.startSec, endSec: result.removed.endSec, durationSeconds: result.project.durationSeconds });
    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof ProjectNotFoundError ? 404 : error instanceof TimelineError ? error.status : 502;
    const message = error instanceof ProjectNotFoundError || error instanceof TimelineError ? error.message : describeError(error, "Unable to cut the range.");
    logException("project_cut_failed", error, { projectId: id, status, reason: message });
    return NextResponse.json({ error: message }, { status });
  }
}
