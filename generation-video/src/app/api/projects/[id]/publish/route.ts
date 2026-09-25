import { NextResponse } from "next/server";
import { isRawTreeConfigured } from "@/lib/rawtree";
import { loadProject, ProjectNotFoundError } from "@/lib/projects";
import { publishProjectVideo } from "@/lib/video-store";

export const runtime = "nodejs";
export const maxDuration = 300;

/** POST → `{ published }`: publishes the project's current video to RawTree now (manual retry; deduped by sha256). */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isRawTreeConfigured()) return NextResponse.json({ error: "RAWTREE_API_KEY is not configured on the server." }, { status: 503 });
  let project;
  try {
    project = await loadProject(id);
  } catch (error) {
    const status = error instanceof ProjectNotFoundError ? 404 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load the project." }, { status });
  }
  const published = await publishProjectVideo(project, { reason: "manual" });
  return NextResponse.json({ published }, { status: published.status === "ok" ? 200 : 502 });
}
