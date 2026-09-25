import { withRouteLog } from "@/lib/route-log";
import { NextResponse } from "next/server";
import { cancelJob, isJobId, publicJob } from "@/lib/jobs";

export const runtime = "nodejs";

/** POST → aborts the job (its work stops at the next abort check; the job ends as `cancelled`). */
async function routePOST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isJobId(id)) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  const job = await cancelJob(id);
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  return NextResponse.json({ job: publicJob(job) });
}

export const POST = withRouteLog(routePOST);
