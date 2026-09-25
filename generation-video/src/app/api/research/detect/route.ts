import { withRouteLog } from "@/lib/route-log";
import { NextResponse } from "next/server";
import { jsonBody, proxyJson } from "@/lib/research-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PROMPT_LENGTH = 32_000;

/**
 * POST `{ prompt }` → `{ company: string | null, likely_domain, video_goal, source: "llm" | "rules" | "none" }`.
 * Liquid decides whether the first home prompt names a company (any language), so the studio knows whether to start
 * company + competitor research before generating. Only names written in the prompt are accepted.
 */
async function routePOST(request: Request) {
  const body = await jsonBody(request);
  if (body instanceof NextResponse) return body;
  if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > MAX_PROMPT_LENGTH) {
    return NextResponse.json({ error: '"prompt" must be 1 to 32,000 characters.' }, { status: 400 });
  }
  return proxyJson("research_detect", "/research/detect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: body.prompt.trim() }),
    timeoutMs: 25_000,
  });
}

export const POST = withRouteLog(routePOST);
