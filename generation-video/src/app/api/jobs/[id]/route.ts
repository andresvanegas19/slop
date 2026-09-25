import { withRouteLog } from "@/lib/route-log";
import { NextResponse } from "next/server";
import { getJob, publicJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET → job snapshot (`?events=1` includes the event log). */
async function routeGET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  const withEvents = new URL(request.url).searchParams.get("events") === "1";
  return NextResponse.json({ job: publicJob(job, { events: withEvents }) });
}

export const GET = withRouteLog(routeGET);
