import { NextResponse } from "next/server";
import { isPresetDuration, isPresetId, PRESET_DURATIONS, presetTemplates } from "@/lib/presets";
import { badSessionId, jsonBody, proxyJson } from "@/lib/research-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PROMPT_LENGTH = 2_000;
const MAX_WAIT_S = 45;
// Waiting for competitors (≤ wait_s) + one Liquid call (RESEARCH_STORY_TIMEOUT_S, 90 s by default) + margin.
const STORYLINE_TIMEOUT_MS = 150_000;

/** GET → `{ storyline }` (the latest version) or 404 when none was written yet. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return badSessionId(id) ?? proxyJson("research_storyline_get", `/research/${id}/storyline`);
}

/**
 * POST `{ durationSec, prompt?, template?: "ad" | "company" | "competitive", waitSec? }` → `{ storyline }`: the agent's
 * storyline tool writes one beat per scene of the chosen template (Liquid picks one when `template` is omitted),
 * grounded in the research and never naming competitors.
 * POST `{ edits: { title?, logline?, call_to_action?, beats?: [{ message?, visual? }] } }` → `{ storyline }` saves the
 * user's edits as a new version (rejected with 400 when they name a competitor).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invalid = badSessionId(id);
  if (invalid) return invalid;
  const body = await jsonBody(request);
  if (body instanceof NextResponse) return body;
  const post = (payload: unknown) =>
    proxyJson("research_storyline", `/research/${id}/storyline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: STORYLINE_TIMEOUT_MS,
    });
  if (body.edits !== undefined) {
    if (!body.edits || typeof body.edits !== "object" || Array.isArray(body.edits)) {
      return NextResponse.json({ error: '"edits" must be an object.' }, { status: 400 });
    }
    return post({ edits: body.edits });
  }
  if (!isPresetDuration(body.durationSec)) {
    return NextResponse.json({ error: `"durationSec" must be one of ${PRESET_DURATIONS.join(", ")}.` }, { status: 400 });
  }
  if (body.template !== undefined && !isPresetId(body.template)) {
    return NextResponse.json({ error: '"template" must be "ad", "company" or "competitive".' }, { status: 400 });
  }
  if (body.prompt !== undefined && (typeof body.prompt !== "string" || body.prompt.length > MAX_PROMPT_LENGTH)) {
    return NextResponse.json({ error: `"prompt" must be a string of at most ${MAX_PROMPT_LENGTH} characters.` }, { status: 400 });
  }
  const waitSec = typeof body.waitSec === "number" && Number.isFinite(body.waitSec) ? Math.max(0, Math.min(MAX_WAIT_S, body.waitSec)) : 25;
  return post({
    duration_sec: body.durationSec,
    templates: presetTemplates(body.durationSec),
    ...(body.template ? { template: body.template } : {}),
    ...(typeof body.prompt === "string" && body.prompt.trim() ? { prompt: body.prompt.trim() } : {}),
    wait_s: waitSec,
  });
}
