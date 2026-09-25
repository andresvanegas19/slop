import { loadEnvConfig } from "@next/env";
import path from "node:path";
import { NextResponse } from "next/server";
import { describeError } from "@/lib/bfl";
import { getClient, isRawTreeConfigured } from "@/lib/rawtree";
import { ResearchAgentError } from "@/lib/research-agent";
import { logError, logInfo } from "@/lib/runtime-log";
import { validateStoryboard, type Storyboard, type StoryboardValidationIssue } from "@/lib/storyboard";

/**
 * Market updates (contracts/market.py, contracts/video.py). The Python agent turns "We're Acme, invoicing software for
 * freelancers" into competitors, grounded developments and a VideoStoryboard stored in RawTree
 * `slop_human_video_storyboards`. The web app only proxies the session API and renders the stored storyboard; it never
 * builds competitor storyboards itself.
 *
 *   POST /market {"prompt"}                 -> 201 {session_id, status}
 *   GET  /market/{session_id}               -> MarketSessionView
 *   GET  /market/storyboards/{storyboard_id} -> VideoStoryboardRecord (agent's local copy, used as a fallback)
 */

export const MARKET_SESSION_ID = /^[A-Za-z0-9_]{1,64}$/;
export const STORYBOARD_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_MARKET_PROMPT = 4_000;
export const STORYBOARDS_TABLE = "slop_human_video_storyboards";

const DEFAULT_URL = "http://127.0.0.1:8765";
const DEFAULT_TIMEOUT_MS = 15_000;
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];
/** Development only: lets a test point one request at a mock agent without restarting the dev server. */
export const AGENT_OVERRIDE_HEADER = "x-market-agent-url";

export type MarketStatus = "starting" | "discovering" | "collecting" | "analyzing" | "storyboarding" | "ready" | "error";
export const MARKET_STATUSES: MarketStatus[] = ["starting", "discovering", "collecting", "analyzing", "storyboarding", "ready", "error"];

export type CompanyBrief = { company_id: string; name: string; domain?: string | null; description: string; category: string; region: string; prompt: string };
export type CompetitorCandidate = { entity_id: string; name: string; domain?: string | null; score: number; mentions: number; seen_in: string[]; reason: string };
export type MarketDevelopment = {
  development_id: string;
  entity_id: string;
  entity_name: string;
  kind: "launch" | "pricing" | "partnership" | "funding" | "acquisition" | "hiring" | "leadership" | "other";
  headline: string;
  summary: string;
  quote: string;
  evidence_id: string;
  url: string;
  source_name: string;
  published_at?: string | null;
  observed_at: string;
  significance: number;
};
export type MarketEvent = { at: string; stage: MarketStatus; message: string };
export type MarketSessionView = {
  session_id: string;
  status: MarketStatus;
  message: string;
  company?: CompanyBrief | null;
  competitors: CompetitorCandidate[];
  pages_fetched: number;
  developments: MarketDevelopment[];
  storyboard_id?: string | null;
  watch_id?: string | null;
  published: boolean;
  error?: string | null;
  events: MarketEvent[];
  started_at: string;
  updated_at: string;
};
export type EvidenceRef = { obs_id: string; url: string; title: string; source_name: string; entity_id: string };
export type VideoStoryboardRecord = {
  storyboard_id: string;
  watch_id: string;
  company_name: string;
  run_id: string;
  created_at: string;
  headline: string;
  total_duration_ms: number;
  scene_count: number;
  development_ids: string;
  is_test: boolean;
  storyboard_json: string;
  evidence_json: string;
  schema_version: string;
};
export type StoredStoryboard = {
  record: VideoStoryboardRecord;
  storyboard: Storyboard;
  evidence: EvidenceRef[];
  source: "rawtree" | "agent";
};

export class StoryboardNotFoundError extends Error {}
export class StoredStoryboardInvalidError extends Error {
  constructor(message: string, readonly details?: StoryboardValidationIssue[]) {
    super(message);
  }
}

/* ---------- agent transport ---------- */

function parseLoopback(raw: string, name: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ResearchAgentError(`${name} is not a valid URL (${raw.slice(0, 120)}).`, 500);
  }
  // The agent only listens on loopback; never send prompts anywhere else this way.
  if (!LOOPBACK.includes(url.hostname) || !["http:", "https:"].includes(url.protocol)) {
    throw new ResearchAgentError(`${name} must point at 127.0.0.1/localhost (the agent only listens on loopback).`, 500);
  }
  return url;
}

/**
 * Agent base URL: MARKET_AGENT_URL, then AGENT_URL, then the default port. In development only, the
 * `X-Market-Agent-Url` request header (loopback only) overrides it so routes can be exercised against a mock agent.
 */
export function marketAgentUrl(request?: Request) {
  const development = process.env.NODE_ENV !== "production";
  const override = development ? request?.headers.get(AGENT_OVERRIDE_HEADER)?.trim() : undefined;
  if (override) return parseLoopback(override, AGENT_OVERRIDE_HEADER);
  loadEnvConfig(process.cwd(), development, undefined, true);
  loadEnvConfig(path.resolve(process.cwd(), ".."), development, undefined, true);
  if (process.env.AGENT_DISABLED === "1") throw new ResearchAgentError("The agent is disabled (AGENT_DISABLED=1).", 503);
  const raw = process.env.MARKET_AGENT_URL?.trim() || process.env.AGENT_URL?.trim() || DEFAULT_URL;
  return parseLoopback(raw, process.env.MARKET_AGENT_URL?.trim() ? "MARKET_AGENT_URL" : "AGENT_URL");
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

async function marketAgentFetch(base: URL, pathname: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  try {
    return await fetch(new URL(pathname, base), { ...rest, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const code = errorCode(error);
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH") {
      throw new ResearchAgentError(`The market-update agent isn't running — start it with ./run (nothing is listening on ${base.host}).`, 503);
    }
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new ResearchAgentError(`The agent on ${base.host} did not answer within ${Math.round(timeoutMs / 1000)}s.`, 504);
    }
    throw new ResearchAgentError(describeError(error, `Could not reach the agent on ${base.host}`), 502);
  }
}

async function readJson(response: Response) {
  const text = await response.text();
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { error: "The agent returned a non-object JSON body." };
  } catch {
    return { error: text.slice(0, 300) || `HTTP ${response.status}` };
  }
}

const OLD_AGENT = "The running agent doesn't have the market-update API yet — restart ./run to load the new agent code.";

/** Proxies one JSON call to the agent's /market API; `{ error }` bodies on failure. */
export async function proxyMarket(request: Request, route: string, pathname: string, init: RequestInit = {}) {
  try {
    const response = await marketAgentFetch(marketAgentUrl(request), pathname, init);
    const body = await readJson(response);
    // An agent without market routes answers a bare "not found".
    if (response.status === 404 && body.error === "not found") return NextResponse.json({ error: OLD_AGENT }, { status: 501 });
    if (response.status >= 400) logInfo("market_agent_error", { route, status: response.status, error: String(body.error ?? "").slice(0, 200) });
    return NextResponse.json(body, { status: response.status });
  } catch (error) {
    const status = error instanceof ResearchAgentError ? error.status : 502;
    const message = error instanceof ResearchAgentError ? error.message : describeError(error, "Agent request failed");
    logError("market_agent_failed", { route, status, message });
    return NextResponse.json({ error: message }, { status });
  }
}

/* ---------- stored storyboards ---------- */

function text(value: unknown) {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

function bool(value: unknown) {
  return value === true || value === 1 || value === "true" || value === "1";
}

function num(value: unknown) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Normalizes a RawTree row / agent JSON (every RawTree column is Dynamic) into a VideoStoryboardRecord. */
export function toRecord(row: Record<string, unknown>): VideoStoryboardRecord {
  return {
    storyboard_id: text(row.storyboard_id),
    watch_id: text(row.watch_id),
    company_name: text(row.company_name),
    run_id: text(row.run_id),
    created_at: text(row.created_at),
    headline: text(row.headline),
    total_duration_ms: num(row.total_duration_ms),
    scene_count: num(row.scene_count),
    development_ids: text(row.development_ids),
    is_test: bool(row.is_test),
    storyboard_json: text(row.storyboard_json),
    evidence_json: text(row.evidence_json) || "[]",
    schema_version: text(row.schema_version),
  };
}

function isMissingTable(error: unknown) {
  const message = `${(error as Error)?.message ?? ""} ${(error as { hint?: string })?.hint ?? ""}`;
  return /unknown table|table not found|doesn't exist|does not exist|UNKNOWN_TABLE/i.test(message);
}

const COLUMNS = ["storyboard_id", "watch_id", "company_name", "run_id", "created_at", "headline", "total_duration_ms", "scene_count", "development_ids", "is_test", "storyboard_json", "evidence_json", "schema_version"];

/** The newest RawTree row for `storyboardId` (null when absent, the table doesn't exist yet, or RawTree isn't set up). */
async function fromRawTree(storyboardId: string, includeTest: boolean): Promise<VideoStoryboardRecord | null> {
  if (!STORYBOARD_ID.test(storyboardId)) throw new StoryboardNotFoundError(`"${storyboardId.slice(0, 80)}" is not a storyboard id.`);
  if (!isRawTreeConfigured()) return null;
  // The SDK has no bound parameters: the id is validated against [A-Za-z0-9_-]{1,64} above, so it can't break out of
  // the string literal. Dynamic columns are compared through toString().
  const where = [`toString(storyboard_id) = '${storyboardId}'`, includeTest ? "" : "ifNull(toString(is_test), '') NOT IN ('true', '1')"].filter(Boolean).join(" AND ");
  const sql = `SELECT ${COLUMNS.map((c) => `toString("${c}") AS "${c}"`).join(", ")} FROM ${STORYBOARDS_TABLE} WHERE ${where} ORDER BY toString(created_at) DESC LIMIT 1`;
  try {
    const result = await getClient().query<Record<string, unknown>>({ sql });
    const row = result.data[0];
    return row ? toRecord(row) : null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    // RawTree unavailable: fall back to the agent's copy rather than failing the render.
    logError("market_storyboard_rawtree_failed", { storyboardId, message: describeError(error, "RawTree query failed") });
    return null;
  }
}

async function fromAgent(storyboardId: string, request?: Request): Promise<VideoStoryboardRecord | null> {
  let response: Response;
  try {
    response = await marketAgentFetch(marketAgentUrl(request), `/market/storyboards/${storyboardId}`);
  } catch (error) {
    // Agent down is only a problem when RawTree didn't have the row either; report "not found" with the reason.
    logInfo("market_storyboard_agent_unavailable", { storyboardId, message: error instanceof Error ? error.message : String(error) });
    return null;
  }
  if (response.status === 404) return null;
  const body = await readJson(response);
  if (!response.ok) throw new ResearchAgentError(String(body.error ?? `The agent returned HTTP ${response.status}.`), 502);
  return toRecord(body);
}

function parseEvidence(raw: string): EvidenceRef[] {
  try {
    const parsed: unknown = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const e = item as Record<string, unknown>;
      if (typeof e.obs_id !== "string" || typeof e.url !== "string") return [];
      return [{ obs_id: e.obs_id, url: e.url, title: text(e.title), source_name: text(e.source_name), entity_id: text(e.entity_id) }];
    });
  } catch {
    return [];
  }
}

/**
 * Loads a stored storyboard: RawTree `slop_human_video_storyboards` first (newest non-test row), then the agent's local
 * copy. Throws StoryboardNotFoundError (404) or StoredStoryboardInvalidError (422).
 */
export async function loadStoredStoryboard(storyboardId: string, options: { includeTest?: boolean; request?: Request } = {}): Promise<StoredStoryboard> {
  if (!STORYBOARD_ID.test(storyboardId)) throw new StoryboardNotFoundError(`"${storyboardId.slice(0, 80)}" is not a storyboard id.`);
  let source: StoredStoryboard["source"] = "rawtree";
  let record = await fromRawTree(storyboardId, Boolean(options.includeTest));
  if (!record) {
    source = "agent";
    record = await fromAgent(storyboardId, options.request);
    if (record?.is_test && !options.includeTest) record = null;
  }
  if (!record) throw new StoryboardNotFoundError(`Storyboard ${storyboardId} was not found in RawTree or the agent.`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(record.storyboard_json);
  } catch {
    throw new StoredStoryboardInvalidError(`Storyboard ${storyboardId} has malformed storyboard_json.`);
  }
  const validation = validateStoryboard(parsed);
  if (!validation.success) throw new StoredStoryboardInvalidError(`Stored storyboard ${storyboardId} is invalid.`, validation.errors);
  return { record, storyboard: validation.data, evidence: parseEvidence(record.evidence_json), source };
}

/** Context for the cinematic shot writer: the storyboard headline plus each scene's on-screen facts. */
export function marketBrief(stored: StoredStoryboard, maxChars = 1_500) {
  const lines = [`Market update for ${stored.record.company_name || "the user's company"}: ${stored.storyboard.headline}`];
  for (const scene of stored.storyboard.scenes) {
    const facts = scene.onScreenText.map((t) => t.text).join(" — ");
    if (facts) lines.push(`- ${facts}`);
  }
  return lines.join("\n").slice(0, maxChars);
}
