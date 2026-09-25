import { loadEnvConfig } from "@next/env";
import path from "node:path";
import { currentTrace, logInfo } from "@/lib/runtime-log";

/**
 * Client for the local Python company agent (`python -m agent worker`, see agent/README.md).
 * The agent reads RawTree through contracts/ tools and uses Liquid to write a short, grounded company brief.
 * This module never throws: when the agent is not running, generation proceeds exactly as before.
 */

const DEFAULT_URL = "http://127.0.0.1:8765";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BRIEF_CHARS = 1_200;

export type CompanyKind = "image" | "video" | "multishot" | "storyboard" | "preset" | "edit";
export type CompanyContext = {
  contextId: string;
  brief: string;
  entities: string[];
  claims: { text: string; beliefKey?: string }[];
  stale: boolean;
  model: string;
};

function settings() {
  const development = process.env.NODE_ENV !== "production";
  loadEnvConfig(process.cwd(), development, undefined, true);
  loadEnvConfig(path.resolve(process.cwd(), ".."), development, undefined, true);
  const raw = process.env.AGENT_URL?.trim() || DEFAULT_URL;
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  // The agent only listens on loopback; refuse anything else so prompts never leave the machine this way.
  if (url && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) url = undefined;
  const timeout = Number(process.env.AGENT_TIMEOUT_MS);
  return {
    url,
    disabled: process.env.AGENT_DISABLED === "1",
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 120_000) : DEFAULT_TIMEOUT_MS,
  };
}

function clean(text: unknown, max: number) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** Asks the agent for company context relevant to `prompt`. Returns null when unavailable. */
export async function getCompanyContext(prompt: string, kind: CompanyKind): Promise<CompanyContext | null> {
  const config = settings();
  if (config.disabled || !config.url) return null;
  const startedAt = Date.now();
  try {
    const response = await fetch(new URL("/context", config.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(currentTrace() ? { "X-Trace-Id": currentTrace()!.traceId } : {}) },
      body: JSON.stringify({ prompt: prompt.slice(0, 32_000), kind }),
      signal: AbortSignal.timeout(config.timeoutMs),
      cache: "no-store",
    });
    if (!response.ok) {
      logInfo("company_agent_unavailable", { kind, status: response.status });
      return null;
    }
    const body = await response.json() as {
      stale?: unknown;
      context?: { context_id?: unknown; brief?: unknown; entities?: unknown; claims?: unknown; model?: unknown };
    };
    const brief = clean(body.context?.brief, MAX_BRIEF_CHARS);
    if (!brief) return null;
    const claims = Array.isArray(body.context?.claims)
      ? (body.context.claims as { text?: unknown; belief_key?: unknown }[])
        .map((claim) => ({ text: clean(claim?.text, 280), beliefKey: typeof claim?.belief_key === "string" ? claim.belief_key : undefined }))
        .filter((claim) => claim.text)
        .slice(0, 8)
      : [];
    const context: CompanyContext = {
      contextId: clean(body.context?.context_id, 64),
      brief,
      entities: Array.isArray(body.context?.entities) ? body.context.entities.filter((e): e is string => typeof e === "string").slice(0, 20) : [],
      claims,
      stale: body.stale === true,
      model: clean(body.context?.model, 120),
    };
    logInfo("company_agent_context", { kind, contextId: context.contextId, stale: context.stale, claims: claims.length, elapsedMs: Date.now() - startedAt });
    return context;
  } catch (error) {
    logInfo("company_agent_unavailable", { kind, reason: error instanceof Error ? error.name : "unknown", elapsedMs: Date.now() - startedAt });
    return null;
  }
}

/** Context for LLM writers (video prompt, preset scripts): brief plus cited facts. */
export function companyContextForWriter(context: CompanyContext | null) {
  if (!context) return undefined;
  const facts = context.claims.map((claim) => `- ${claim.text}`).join("\n");
  return `${context.brief}${facts ? `\nFacts:\n${facts}` : ""}`;
}

/**
 * Short, visual-only hint appended to prompts that go straight to the image model.
 * Digits and symbols are removed so the image model is not tempted to draw prices or text.
 */
export function companyVisualHint(context: CompanyContext | null, maxChars = 360) {
  if (!context) return "";
  const hint = context.brief.replace(/[0-9$€£%]+/g, "").replace(/\s+/g, " ").trim().slice(0, maxChars);
  return hint ? ` Company context for subject and mood only (do not render any text, numbers or logos): ${hint}` : "";
}
