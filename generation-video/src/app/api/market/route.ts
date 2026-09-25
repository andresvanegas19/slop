import { NextResponse } from "next/server";
import { MAX_MARKET_PROMPT, proxyMarket } from "@/lib/market";
import { forwardedUser, jsonBody } from "@/lib/research-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST `{ prompt: string }` (1–4,000 chars, e.g. "We're Acme, invoicing software for freelancers")
 * → 201 `{ session_id, status }` from the agent's POST /market. Poll GET /api/market/{session_id} for progress.
 * The `X-Longform-User` header (UUID) is forwarded.
 */
export async function POST(request: Request) {
  const body = await jsonBody(request);
  if (body instanceof NextResponse) return body;
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    return NextResponse.json({ error: '"prompt" is required — tell us about your company, e.g. "We\'re Acme, invoicing software for freelancers".' }, { status: 400 });
  }
  const prompt = body.prompt.trim();
  if (prompt.length > MAX_MARKET_PROMPT) {
    return NextResponse.json({ error: `"prompt" is too long (${prompt.length} characters); the limit is ${MAX_MARKET_PROMPT.toLocaleString("en-US")}.` }, { status: 400 });
  }
  const user = forwardedUser(request);
  return proxyMarket(request, "market_start", "/market", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(user ? { "X-Longform-User": user } : {}) },
    body: JSON.stringify({ prompt }),
  });
}
