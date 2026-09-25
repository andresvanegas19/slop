import { NextResponse } from "next/server";
import { RESUME_HEADER, RESUME_TOKEN_HEADER } from "@/lib/job-route";
import { getJob, isTerminal, publicJob, resumeToken } from "@/lib/jobs";

export const runtime = "nodejs";

/**
 * POST → re-runs an interrupted (or failed/cancelled) job from its stored input under the same id. Goes through the
 * original route (so its module is loaded even right after a restart) in resume mode.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  if (!isTerminal(job.status)) return NextResponse.json({ job: publicJob(job) }, { status: 202 });
  if (job.status === "done") return NextResponse.json({ error: "This job already finished." }, { status: 409 });
  const origin = new URL(request.url).origin;
  let response: Response;
  try {
    response = await fetch(new URL(job.input.path, origin), {
      method: job.input.method,
      headers: { [RESUME_HEADER]: id, [RESUME_TOKEN_HEADER]: resumeToken() },
    });
  } catch (error) {
    return NextResponse.json({ error: `Could not resume the job: ${error instanceof Error ? error.message : String(error)}` }, { status: 502 });
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) return NextResponse.json({ error: typeof body.error === "string" ? body.error : `Could not resume the job (HTTP ${response.status}).` }, { status: response.status });
  const resumed = await getJob(id);
  return NextResponse.json({ jobId: id, job: resumed ? publicJob(resumed) : null }, { status: 202 });
}
