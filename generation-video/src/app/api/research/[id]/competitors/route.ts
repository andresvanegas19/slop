import { withRouteLog } from "@/lib/route-log";
import { NextResponse } from "next/server";
import { badSessionId, jsonBody, proxyJson } from "@/lib/research-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET → `{ status: "waiting" | "running" | "done" | "skipped" | "error" | "off", message, competitors: [{ id, name, domain,
 * verified, summary, claims, pages }], differentiators, competitor_themes, avoid_terms }`.
 * Competitor research starts by itself after the session's first round (Nimble scrapes each verified competitor).
 */
async function routeGET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return badSessionId(id) ?? proxyJson("research_competitors", `/research/${id}/competitors`);
}

/** POST `{ force?: boolean }` → 202 `{ status, started }`: (re)starts competitor research now. */
async function routePOST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invalid = badSessionId(id);
  if (invalid) return invalid;
  const body = await jsonBody(request);
  if (body instanceof NextResponse) return body;
  return proxyJson("research_competitors_start", `/research/${id}/competitors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force: body.force === true }),
  });
}

export const GET = withRouteLog(routeGET);
export const POST = withRouteLog(routePOST);
