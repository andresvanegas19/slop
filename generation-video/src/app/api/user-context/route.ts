import { NextResponse } from "next/server";
import { getUserContext, parseUserId } from "@/lib/user-context";

export const runtime = "nodejs";

/** GET `?projectId=` with `X-Longform-User` → `{ userId, context }`: the text block injected into the LLM calls. */
export async function GET(request: Request) {
  const userId = parseUserId(request.headers.get("x-longform-user"));
  const projectId = new URL(request.url).searchParams.get("projectId") ?? undefined;
  return NextResponse.json({ userId, context: await getUserContext(userId, { projectId }) }, { headers: { "Cache-Control": "no-store" } });
}
