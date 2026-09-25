/* First home prompt → does it name a company? Liquid decides via the agent (/api/research/detect); regex fallback. */
import { companyFromPrompt } from "./research";
import type { HistoryKind } from "./types";
import { PRESET_LENGTHS } from "./utils";
import { userHeaders } from "./hooks/storage";

const DETECT_TIMEOUT_MS = 15_000;

/**
 * The company to research before generating, "" to research without a known name (company shorts), or null to
 * generate normally. Only the first prompt on the home screen asks the agent; it never throws.
 */
export async function researchCompanyFor(kind: HistoryKind, prompt: string, firstPrompt: boolean): Promise<string | null> {
  if (kind === "company") return "";
  if (kind !== "clip" && kind !== "ad") return null;
  const fallback = kind === "clip" ? companyFromPrompt(prompt) : null;
  if (!firstPrompt || !prompt) return fallback;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), DETECT_TIMEOUT_MS);
  try {
    const response = await fetch("/api/research/detect", {
      method: "POST",
      headers: { ...userHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => null) as { company?: unknown; source?: unknown } | null;
    if (!response.ok || !result) {
      console.error(`[research] company detection returned HTTP ${response.status}; using the prompt rules`, result);
      return fallback;
    }
    return typeof result.company === "string" && result.company.trim() ? result.company.trim() : null;
  } catch (caughtError) {
    console.error("[research] company detection failed; using the prompt rules", caughtError);
    return fallback;
  } finally {
    window.clearTimeout(timer);
  }
}

/** The preset length closest to `seconds` (storylines are written for a preset's scene plan). */
export function presetDuration(seconds: number) {
  return PRESET_LENGTHS.reduce((best, length) => Math.abs(length - seconds) < Math.abs(best - seconds) ? length : best, 10);
}
