/*
 * Job mode for generating routes: `POST …?job=1` (or `Prefer: respond-async`) answers `202 { jobId }` at once and
 * runs the unchanged route handler in the background (src/lib/jobs.ts). Plain JSON / NDJSON streaming requests are
 * passed straight through, so old clients keep working.
 */
import { NextResponse } from "next/server";
import { ClientAbortedError } from "@/lib/progress";
import { isJobId, resumeStoredJob, resumeToken, startJob, type JobInput, type JobRecord, type JobRunner } from "@/lib/jobs";
import { parseUserId } from "@/lib/user-context";

export const RESUME_HEADER = "x-longform-job-resume";
export const RESUME_TOKEN_HEADER = "x-longform-job-token";
const FORWARDED_HEADERS = ["content-type", "x-longform-user"];
/** Query flags that only concern the transport; the background run gets a plain JSON request. */
const TRANSPORT_PARAMS = ["job", "stream"];

export function wantsJob(request: Request) {
  const flag = new URL(request.url).searchParams.get("job");
  if (flag === "1" || flag === "true") return true;
  return /\brespond-async\b/i.test(request.headers.get("prefer") ?? "");
}

type RouteContext = { params?: Promise<Record<string, string>> };

function runnerFor<Args extends unknown[]>(handler: (request: Request, ...args: Args) => Promise<Response>): JobRunner {
  return async (job: JobRecord) => {
    const { input } = job;
    const headers = new Headers(input.headers);
    headers.set("accept", "application/json");
    // A fresh Request: its signal never aborts, so the work is independent of whoever started it.
    const request = new Request(new URL(input.path, "http://localhost"), {
      method: input.method,
      headers,
      body: input.method === "GET" || input.method === "HEAD" || !input.body ? undefined : input.body,
    });
    const args = (input.params ? [{ params: Promise.resolve(input.params) }] : []) as unknown as Args;
    try {
      const response = await handler(request, ...args);
      const body = await response.json().catch(() => ({ error: "The server returned a response that is not JSON." })) as Record<string, unknown>;
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof ClientAbortedError) throw error;
      return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
    }
  };
}

/**
 * Wraps a route handler (the same function that is exported today, e.g. `logUserPrompt(…, streamable(handlePost))`)
 * so it can also run as a background job of `kind`.
 */
export function jobable<Args extends unknown[]>(kind: string, handler: (request: Request, ...args: Args) => Promise<Response>) {
  const runner = runnerFor(handler);
  return async (request: Request, ...args: Args): Promise<Response> => {
    const resumeId = request.headers.get(RESUME_HEADER);
    if (resumeId !== null) {
      if (request.headers.get(RESUME_TOKEN_HEADER) !== resumeToken() || !isJobId(resumeId)) {
        return NextResponse.json({ error: "Invalid job resume request." }, { status: 403 });
      }
      const resumed = await resumeStoredJob(resumeId, runner);
      if (!("id" in resumed)) return NextResponse.json({ error: resumed.error }, { status: resumed.status });
      return NextResponse.json({ jobId: resumed.id, status: resumed.status }, { status: 202 });
    }
    if (!wantsJob(request)) return handler(request, ...args);

    const url = new URL(request.url);
    for (const name of TRANSPORT_PARAMS) url.searchParams.delete(name);
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    let params: Record<string, string> | null = null;
    try {
      const context = args[0] as RouteContext | undefined;
      params = context?.params ? await context.params : null;
    } catch {
      params = null;
    }
    const input: JobInput = {
      path: `${url.pathname}${url.search}`,
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? "" : await request.text(),
      params,
      userId: parseUserId(request.headers.get("x-longform-user")),
    };
    const job = await startJob(kind, input, runner);
    return NextResponse.json({ jobId: job.id, status: job.status }, { status: 202, headers: { Location: `/api/jobs/${job.id}` } });
  };
}
