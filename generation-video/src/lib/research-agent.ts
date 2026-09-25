import { loadEnvConfig } from "@next/env";
import path from "node:path";
import { NextResponse } from "next/server";
import { describeError } from "@/lib/bfl";
import { currentTrace, log, logError, logException, logInfo, logWarn } from "@/lib/runtime-log";
import type { Storyline } from "@/lib/storyline";
import { ANONYMOUS_USER, parseUserId } from "@/lib/user-context";

/**
 * Client for the Python research agent's session API (`python -m agent worker`, see agent/README.md).
 * A session researches a company on its own website, asks follow-up questions and keeps a grounded CompanyProfile.
 * The API routes under /api/research are thin proxies to it; generate-preset reads a session's profile.
 */

const DEFAULT_URL = "http://127.0.0.1:8765";
const DEFAULT_TIMEOUT_MS = 15_000;
export const SESSION_ID = /^[A-Za-z0-9_]{1,64}$/;
export const NOT_RUNNING = "Research agent isn't running — start it with ./run";

export class ResearchAgentError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type SourcedText = { text: string; evidence_url?: string | null; finding_ids?: string[] };
export type ResearchFinding = { finding_id: string; topic: string; claim: string; evidence_url: string; quote: string };
export type VideoBrief = {
  goal: string;
  audience: string;
  featured_product: string;
  tone: string;
  length_format: string;
  call_to_action: string;
  avoid: string;
  notes: string[];
};
export type CompanyProfile = {
  session_id: string;
  name: string;
  domain?: string | null;
  one_line?: SourcedText | null;
  what_they_do?: SourcedText | null;
  products: SourcedText[];
  audience?: SourcedText | null;
  brand_voice?: SourcedText | null;
  visual_identity: { colors: string[]; logo_url?: string | null; og_image?: string | null; imagery_style: string; evidence_url?: string | null };
  key_messages: SourcedText[];
  recent_news: { title: string; date?: string | null; url: string }[];
  proof_points: ResearchFinding[];
  open_questions: string[];
  video_brief: VideoBrief;
  version: number;
  updated_at: string;
  model: string;
};
export type ResearchQuestion = { id: string; topic: string; question: string; options: string[]; answered: boolean; answer?: string | null; source: string };
export type ResearchSession = {
  session_id: string;
  status: "starting" | "researching" | "waiting" | "done" | "stopped" | "error";
  looping: boolean;
  running: boolean;
  publish: boolean;
  prompt: string;
  user_id?: string | null;
  company: string | null;
  domain: string | null;
  home_url: string | null;
  video_goal: string | null;
  profile: CompanyProfile | null;
  questions: ResearchQuestion[];
  answers: { question_id: string; topic: string; question: string; answer: string; answered_at: string }[];
  findings: ResearchFinding[];
  pages: { url: string; title: string; status: number; chars: number; fetched_at: string }[];
  stats: { pages: number; findings: number; tokens: number; input_tokens: number; output_tokens: number; llm_calls: number; rounds: number };
  error: string | null;
  /** Competitor research (agent/story_api.py); names stay server-side except as `avoid_terms` for filtering. */
  competitors?: CompetitorLandscape | null;
  /** Latest storyline written by the agent's storyline tool, if any. */
  storyline?: Storyline | null;
};
export type CompetitorLandscape = {
  status: string;
  message?: string;
  competitors: { id?: string; name: string; domain?: string | null; verified: boolean; summary?: string; claims?: string[]; pages?: number }[];
  differentiators: string[];
  competitor_themes: string[];
  avoid_terms: string[];
};

function agentUrl() {
  const development = process.env.NODE_ENV !== "production";
  loadEnvConfig(process.cwd(), development, undefined, true);
  loadEnvConfig(path.resolve(process.cwd(), ".."), development, undefined, true);
  const raw = process.env.AGENT_URL?.trim() || DEFAULT_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ResearchAgentError(`AGENT_URL is not a valid URL (${raw}).`, 500);
  }
  // The agent only listens on loopback; never send prompts anywhere else this way.
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new ResearchAgentError("AGENT_URL must point at 127.0.0.1/localhost (the agent only listens on loopback).", 500);
  }
  if (process.env.AGENT_DISABLED === "1") throw new ResearchAgentError("The research agent is disabled (AGENT_DISABLED=1).", 503);
  return url;
}

function errorCode(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** fetch() to the agent. Connection failures become a ResearchAgentError with a sentence the UI can show. */
export async function agentFetch(pathname: string, init: RequestInit & { timeoutMs?: number | null } = {}) {
  const base = agentUrl();
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = init;
  const signals = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined].filter((s): s is AbortSignal => Boolean(s));
  // The agent logs with the same trace id (X-Trace-Id), so /api/logs?traceId=… shows both sides.
  const headers = new Headers(rest.headers);
  const trace = currentTrace();
  if (trace) headers.set("X-Trace-Id", trace.traceId);
  const startedAt = Date.now();
  try {
    const response = await fetch(new URL(pathname, base), { ...rest, headers, cache: "no-store", signal: signals.length ? AbortSignal.any(signals) : undefined });
    log(response.ok ? "debug" : "warn", "agent_call_done", { method: rest.method ?? "GET", path: pathname.split("?")[0], status: response.status, durationMs: Date.now() - startedAt });
    return response;
  } catch (error) {
    log("warn", "agent_call_failed", { method: rest.method ?? "GET", path: pathname.split("?")[0], error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt });
    const code = errorCode(error);
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH") {
      throw new ResearchAgentError(`${NOT_RUNNING} (nothing is listening on ${base.host}).`, 503);
    }
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") && !signal?.aborted) {
      throw new ResearchAgentError(`The research agent on ${base.host} did not answer within ${Math.round((timeoutMs ?? 0) / 1000)}s.`, 504);
    }
    throw new ResearchAgentError(describeError(error, `Could not reach the research agent on ${base.host}`), 502);
  }
}

async function readJson(response: Response) {
  const text = await response.text();
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return { error: text.slice(0, 300) || `HTTP ${response.status}` };
  }
}

/** Maps agent replies to what the browser sees; an old worker without research routes answers a bare "not found". */
function agentReply(status: number, body: Record<string, unknown>, route: string) {
  if (status === 404 && body.error === "not found") {
    return NextResponse.json(
      { error: "The running agent doesn't have the research API yet — restart ./run to load the new agent code." },
      { status: 501 },
    );
  }
  if (status >= 400) (status >= 500 ? logWarn : logInfo)("research_agent_error", { route, status, error: String(body.error ?? "").slice(0, 200) });
  return NextResponse.json(body, { status });
}

export function agentErrorResponse(error: unknown, route: string) {
  const status = error instanceof ResearchAgentError ? error.status : 502;
  const message = error instanceof ResearchAgentError ? error.message : describeError(error, "Research agent request failed");
  // Expected conditions (agent not running, timeouts) get one log line; anything else gets the full stack.
  if (error instanceof ResearchAgentError) logError("research_agent_failed", { route, status, message });
  else logException("research_agent_failed", error, { route, status, message });
  return NextResponse.json({ error: message }, { status });
}

/** Proxies one JSON call to the agent and returns its status + body (errors as `{ error }`). */
export async function proxyJson(route: string, pathname: string, init: RequestInit & { timeoutMs?: number | null } = {}) {
  try {
    const response = await agentFetch(pathname, init);
    return agentReply(response.status, await readJson(response), route);
  } catch (error) {
    return agentErrorResponse(error, route);
  }
}

/** Parses a JSON object body; returns a 400 response instead when it isn't one. */
export async function jsonBody(request: Request): Promise<Record<string, unknown> | NextResponse> {
  try {
    const text = await request.text();
    const parsed: unknown = text.trim() ? JSON.parse(text) : {};
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
    }
    return parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400 });
  }
}

export function badSessionId(id: string) {
  return SESSION_ID.test(id) ? undefined : NextResponse.json({ error: `"${id.slice(0, 80)}" is not a research session id.` }, { status: 400 });
}

/** The X-Longform-User header (UUID) to forward, or undefined for anonymous users. */
export function forwardedUser(request: Request) {
  const user = parseUserId(request.headers.get("x-longform-user"));
  return user === ANONYMOUS_USER ? undefined : user;
}

/** A session's current state (profile, questions, answers). Throws ResearchAgentError when unavailable. */
export async function getResearchSession(id: string): Promise<ResearchSession> {
  if (!SESSION_ID.test(id)) throw new ResearchAgentError(`"${id.slice(0, 80)}" is not a research session id.`, 400);
  const response = await agentFetch(`/research/${id}`);
  const body = await readJson(response);
  if (response.status === 404) {
    throw new ResearchAgentError(
      body.error === "not found"
        ? "The running agent doesn't have the research API yet — restart ./run to load the new agent code."
        : `Research session ${id} was not found.`,
      404,
    );
  }
  if (!response.ok) throw new ResearchAgentError(String(body.error ?? `Research agent returned HTTP ${response.status}.`), 502);
  return body as unknown as ResearchSession;
}

const clip = (text: string | null | undefined, max: number) => {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * Grounded context for the LLM writer: only facts from the research profile (each backed by a quote on the company's
 * site) plus what the user answered. Numbers stay in the facts; the writer is told never to invent more.
 */
export function researchContextForWriter(session: ResearchSession, maxChars = 3_000) {
  const profile = session.profile;
  const name = profile?.name || session.company || "the company";
  const lines: string[] = [`Company: ${name}${profile?.domain ? ` (${profile.domain})` : ""}.`];
  const add = (label: string, item?: SourcedText | null) => {
    if (item?.text) lines.push(`${label}: ${clip(item.text, 300)}`);
  };
  if (profile) {
    add("Who they are", profile.one_line);
    add("What they do", profile.what_they_do);
    if (profile.products.length) lines.push(`Products and brands: ${profile.products.slice(0, 6).map((p) => clip(p.text, 120)).join("; ")}`);
    add("Audience", profile.audience);
    add("Brand voice", profile.brand_voice);
    if (profile.key_messages.length) lines.push(`Key messages: ${profile.key_messages.slice(0, 5).map((m) => clip(m.text, 140)).join("; ")}`);
    if (profile.proof_points.length) lines.push(`Proof points: ${profile.proof_points.slice(0, 5).map((f) => clip(f.claim, 160)).join("; ")}`);
    if (profile.recent_news.length) lines.push(`Recent news: ${profile.recent_news.slice(0, 3).map((n) => `${clip(n.title, 140)}${n.date ? ` (${n.date})` : ""}`).join("; ")}`);
  }
  const brief = profile?.video_brief;
  const wishes = brief
    ? [
      ["goal", brief.goal], ["audience", brief.audience], ["feature", brief.featured_product], ["tone", brief.tone],
      ["length/format", brief.length_format], ["call to action", brief.call_to_action], ["avoid", brief.avoid],
    ].filter(([, value]) => value).map(([key, value]) => `${key}: ${clip(value, 160)}`)
    : [];
  if (brief?.notes.length) wishes.push(...brief.notes.slice(0, 3).map((note) => clip(note, 160)));
  if (wishes.length) lines.push(`The user's wishes for this video (follow them): ${wishes.join("; ")}`);
  let text = "";
  for (const line of lines) {
    if (text.length + line.length + 1 > maxChars) break;
    text += `${text ? "\n" : ""}${line}`;
  }
  return text;
}

const NAMED_COLORS: [string, [number, number, number]][] = [
  ["red", [220, 30, 40]], ["crimson", [160, 20, 40]], ["orange", [245, 130, 30]], ["golden yellow", [250, 200, 20]],
  ["green", [40, 160, 70]], ["teal", [0, 130, 130]], ["sky blue", [80, 170, 230]], ["blue", [30, 80, 200]],
  ["navy", [20, 30, 90]], ["purple", [120, 50, 170]], ["pink", [240, 110, 170]], ["brown", [120, 70, 40]],
  ["black", [15, 15, 15]], ["white", [250, 250, 250]], ["grey", [128, 128, 128]], ["beige", [230, 215, 180]],
];

/** "#e41e2b" -> "red" (nearest named color), so image prompts carry the palette without digits. */
export function colorName(hex: string) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return undefined;
  const full = match[1].length === 3 ? match[1].split("").map((c) => c + c).join("") : match[1];
  const rgb = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const [name, ref] of NAMED_COLORS) {
    const distance = ref.reduce((sum, value, i) => sum + (value - rgb[i]) ** 2, 0);
    if (distance < bestDistance) [best, bestDistance] = [name, distance];
  }
  return best;
}

/**
 * Visual-only hint for image prompts: palette names and imagery style, digits/symbols removed, and an explicit
 * "no text, no logos" so the image model never tries to draw the brand's wordmark.
 */
export function researchVisualHint(session: ResearchSession | null | undefined, maxChars = 320) {
  const identity = session?.profile?.visual_identity;
  if (!identity) return "";
  const colors = [...new Set(identity.colors.map(colorName).filter((name): name is string => Boolean(name)))].slice(0, 3);
  const tone = session?.profile?.video_brief.tone;
  const parts = [
    colors.length ? `brand palette of ${colors.join(", ")} tones` : "",
    identity.imagery_style ? clip(identity.imagery_style, 160) : "",
    tone ? `${clip(tone, 60)} mood` : "",
  ].filter(Boolean);
  const hint = parts.join("; ").replace(/[0-9$€£%#@®™©]+/g, "").replace(/\b(logo|logos|text|letters|words|wordmark)\b/gi, "").replace(/\s+/g, " ").trim().slice(0, maxChars);
  return hint ? ` Visual direction (no text, no letters, no logos): ${hint}.` : "";
}
