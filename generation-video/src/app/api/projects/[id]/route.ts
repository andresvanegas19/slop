import { NextResponse } from "next/server";
import { describeError } from "@/lib/bfl";
import { loadProject, ProjectNotFoundError } from "@/lib/projects";
import { logException } from "@/lib/runtime-log";

export const runtime = "nodejs";

/** GET → `{ project }` */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json({ project: await loadProject(id) });
  } catch (error) {
    if (error instanceof ProjectNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    const message = describeError(error, `Unable to load project "${id}".`);
    logException("project_load_failed", error, { projectId: id, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
