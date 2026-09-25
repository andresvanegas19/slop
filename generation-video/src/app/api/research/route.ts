import { NextResponse } from "next/server";
import { forwardedUser, jsonBody, proxyJson } from "@/lib/research-agent";
import { logUserPrompt } from "@/lib/user-prompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PROMPT_LENGTH = 32_000;

/**
 * POST `{ prompt: string, looping?: boolean }` → 201 `{ session_id, status, looping, publish }`.
 * Starts a research session in the local agent (company website research + follow-up questions). The
 * `X-Longform-User` header (UUID) is forwarded so the agent can use this user's past prompts.
 */
async function handlePost(request: Request) {
  const body = await jsonBody(request);
  if (body instanceof NextResponse) return body;
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    return NextResponse.json({ error: '"prompt" is required, e.g. "Make a company video for Coca-Cola".' }, { status: 400 });
  }
  if (body.prompt.length > MAX_PROMPT_LENGTH) {
    return NextResponse.json({ error: `"prompt" is too long (${body.prompt.length} characters); the limit is ${MAX_PROMPT_LENGTH}.` }, { status: 400 });
  }
  if (body.looping !== undefined && typeof body.looping !== "boolean") {
    return NextResponse.json({ error: '"looping" must be a boolean.' }, { status: 400 });
  }
  const user = forwardedUser(request);
  return proxyJson("research_start", "/research", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(user ? { "X-Longform-User": user } : {}) },
    body: JSON.stringify({ prompt: body.prompt.trim(), ...(body.looping === undefined ? {} : { looping: body.looping }) }),
  });
}

export const POST = logUserPrompt("research", handlePost);
