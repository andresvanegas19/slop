import { withRouteLog } from "@/lib/route-log";
import { NextResponse } from "next/server";
import { badSessionId, jsonBody, proxyJson } from "@/lib/research-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST `{ looping: boolean }` → `{ session_id, looping, running }`. `true` on a finished session starts more rounds. */
async function routePOST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invalid = badSessionId(id);
  if (invalid) return invalid;
  const body = await jsonBody(request);
  if (body instanceof NextResponse) return body;
  if (typeof body.looping !== "boolean") return NextResponse.json({ error: '"looping" must be true or false.' }, { status: 400 });
  return proxyJson("research_loop", `/research/${id}/loop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ looping: body.looping }),
  });
}

export const POST = withRouteLog(routePOST);
