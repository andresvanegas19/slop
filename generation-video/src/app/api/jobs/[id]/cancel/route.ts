import { NextResponse } from "next/server";
import { cancelJob, isJobId, publicJob } from "@/lib/jobs";

export const runtime = "nodejs";

/** POST → aborts the job (its work stops at the next abort check; the job ends as `cancelled`). */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isJobId(id)) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  const job = await cancelJob(id);
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  return NextResponse.json({ job: publicJob(job) });
}
