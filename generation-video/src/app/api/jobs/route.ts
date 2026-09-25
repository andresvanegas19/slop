import { withRouteLog } from "@/lib/route-log";
import { NextResponse } from "next/server";
import { listJobs, publicJob } from "@/lib/jobs";
import { parseUserId } from "@/lib/user-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET `?active=1[&userId=]` → `{ jobs }` of this browser (X-Longform-User header or `userId`), newest first. */
async function routeGET(request: Request) {
  const params = new URL(request.url).searchParams;
  const userId = parseUserId(request.headers.get("x-longform-user") ?? params.get("userId"));
  const active = params.get("active") === "1" || params.get("active") === "true";
  const jobs = await listJobs({ userId, active });
  return NextResponse.json({ jobs: jobs.slice(0, 50).map((job) => publicJob(job)) });
}

export const GET = withRouteLog(routeGET);
