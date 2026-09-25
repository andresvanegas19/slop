import { withRouteLog } from "@/lib/route-log";
import { NextResponse } from "next/server";
import { describeError } from "@/lib/bfl";
import { loadProject, ProjectNotFoundError, saveProject, withProjectLock } from "@/lib/projects";
import { logException, logInfo } from "@/lib/runtime-log";
import { removeFrame, TimelineError } from "@/lib/timeline-ops";
import { schedulePublish } from "@/lib/video-store";
import { jobable } from "@/lib/job-route";

export const runtime = "nodejs";
export const maxDuration = 300;

/** DELETE → `{ project }`: removes that frame's segment (shot) and reassembles the video. */
async function handleDelete(_request: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  const { id, index: rawIndex } = await params;
  const index = Number(rawIndex);
  if (!/^\d+$/.test(rawIndex) || !Number.isSafeInteger(index)) {
    return NextResponse.json({ error: `Frame index "${rawIndex}" is not a non-negative integer.` }, { status: 400 });
  }
  try {
    const project = await withProjectLock(id, async () => {
      const updated = await removeFrame(await loadProject(id), index);
      await saveProject(updated);
      return updated;
    });
    schedulePublish(project, "cut");
    logInfo("project_frame_removed", { projectId: id, index, frames: project.frames.length, durationSeconds: project.durationSeconds });
    return NextResponse.json({ project });
  } catch (error) {
    const status = error instanceof ProjectNotFoundError ? 404 : error instanceof TimelineError ? error.status : 502;
    const message = error instanceof ProjectNotFoundError || error instanceof TimelineError ? error.message : describeError(error, "Unable to remove the shot.");
    logException("project_frame_remove_failed", error, { projectId: id, index, status, reason: message });
    return NextResponse.json({ error: message }, { status });
  }
}

export const DELETE = withRouteLog(jobable("remove-frame", handleDelete));
