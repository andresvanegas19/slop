"use client";

/*
 * Market updates: POST /api/market starts an agent session, GET /api/market/{id} is polled every ~2 s until the
 * session is ready (a storyboard is stored) or fails. Rendering the stored storyboard is up to the caller (useStudio).
 */
import { useEffect, useRef, useState } from "react";
import type { MarketRun, MarketStatus, MarketView } from "../types";
import { errorMessage, nowIso, readJson } from "../utils";
import { userHeaders } from "./storage";

const POLL_MS = 2_000;
/** Consecutive failed polls (agent restarting, network blip) before giving up. */
const MAX_POLL_FAILURES = 4;
const STATUSES: MarketStatus[] = ["starting", "discovering", "collecting", "analyzing", "storyboarding", "ready", "error"];

export const MARKET_STAGES: { status: MarketStatus; label: string }[] = [
  { status: "starting", label: "Understanding your company" },
  { status: "discovering", label: "Finding your competitors" },
  { status: "collecting", label: "Reading their recent news and pricing" },
  { status: "analyzing", label: "Working out what changed" },
  { status: "storyboarding", label: "Writing the video storyboard" },
];

export function marketStageLabel(status: MarketStatus) {
  return status === "ready" ? "Storyboard ready" : status === "error" ? "Market update failed" : MARKET_STAGES.find((stage) => stage.status === status)?.label ?? "Working";
}

const str = (value: unknown) => (typeof value === "string" ? value : "");
const list = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : []);

/** Defensive parse of the agent's MarketSessionView (unknown fields ignored, missing ones defaulted). */
export function parseMarketView(value: unknown): MarketView | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.session_id !== "string" || !STATUSES.includes(v.status as MarketStatus)) return null;
  const company = v.company && typeof v.company === "object" ? v.company as Record<string, unknown> : null;
  return {
    session_id: v.session_id,
    status: v.status as MarketStatus,
    message: str(v.message),
    company: company && typeof company.name === "string" ? { name: company.name, domain: str(company.domain) || null, category: str(company.category) } : null,
    competitors: list(v.competitors).filter((c) => typeof c.name === "string").map((c) => ({ entity_id: str(c.entity_id) || str(c.name), name: str(c.name), domain: str(c.domain) || null, reason: str(c.reason) })),
    pages_fetched: typeof v.pages_fetched === "number" ? v.pages_fetched : 0,
    developments: list(v.developments).filter((d) => typeof d.headline === "string").map((d) => ({
      development_id: str(d.development_id) || str(d.headline),
      entity_name: str(d.entity_name),
      kind: str(d.kind),
      headline: str(d.headline),
      summary: str(d.summary),
      url: str(d.url),
      source_name: str(d.source_name),
      significance: typeof d.significance === "number" ? d.significance : 0,
    })),
    storyboard_id: str(v.storyboard_id) || null,
    error: str(v.error) || null,
    events: list(v.events).map((e) => ({ at: str(e.at), stage: (STATUSES.includes(e.stage as MarketStatus) ? e.stage : "starting") as MarketStatus, message: str(e.message) })),
  };
}

/** Starts a market-update session; returns its id. Throws with a sentence the UI can show. */
export async function startMarketSession(prompt: string): Promise<string> {
  const response = await fetch("/api/market", {
    method: "POST",
    headers: { ...userHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  const result = await readJson<{ session_id?: unknown; error?: unknown }>(response, `The market-update service returned HTTP ${response.status}.`);
  if (!response.ok || typeof result.session_id !== "string") {
    console.error(`[market] POST /api/market failed with HTTP ${response.status}`, result);
    throw new Error(errorMessage(result, `Could not start the market update (HTTP ${response.status}).`));
  }
  return result.session_id;
}

/** `onReady(sessionId, storyboardId)` fires once per session, when the agent reports a stored storyboard. */
export function useMarket(onReady: (sessionId: string, storyboardId: string) => void) {
  const [run, setRun] = useState<MarketRun | null>(null);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  });
  const runId = run?.id ?? null;
  const polling = run !== null && run.pollError === null && run.view?.status !== "ready" && run.view?.status !== "error";

  useEffect(() => {
    if (!runId || !polling) return;
    const controller = new AbortController();
    let failures = 0;
    let timer: number | undefined;
    const update = (patch: Partial<MarketRun>) => setRun((current) => (current && current.id === runId ? { ...current, ...patch } : current));

    async function poll() {
      try {
        const response = await fetch(`/api/market/${encodeURIComponent(runId!)}`, { headers: userHeaders(), cache: "no-store", signal: controller.signal });
        const result = await readJson<{ error?: unknown }>(response, `The market-update service returned HTTP ${response.status}.`);
        if (controller.signal.aborted) return;
        if (!response.ok) {
          // A lost session (agent restarted) or an agent without the API won't recover by polling again.
          if (response.status === 404 || response.status === 501 || response.status === 400) {
            update({ pollError: errorMessage(result, `The market update could not be found (HTTP ${response.status}).`) });
            return;
          }
          throw new Error(errorMessage(result, `The market-update service returned HTTP ${response.status}.`));
        }
        const view = parseMarketView(result);
        if (!view) throw new Error("The agent returned an unexpected market-update status.");
        failures = 0;
        update({ view });
        if (view.status === "ready" && !view.storyboard_id) {
          update({ pollError: "The agent says the market update is ready but didn't return a storyboard id." });
          return;
        }
        if (view.status === "ready") onReadyRef.current(runId!, view.storyboard_id!);
        if (view.status === "ready" || view.status === "error") return;
      } catch (caughtError) {
        if (controller.signal.aborted) return;
        failures += 1;
        console.error("[market] poll failed", caughtError);
        if (failures >= MAX_POLL_FAILURES) {
          update({ pollError: caughtError instanceof Error ? caughtError.message : "Lost contact with the market-update agent." });
          return;
        }
      }
      timer = window.setTimeout(poll, POLL_MS);
    }
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [runId, polling]);

  return {
    run,
    begin: (id: string, prompt: string) => setRun({ id, prompt, startedAt: nowIso(), view: null, pollError: null, render: { status: "idle" } }),
    setRender: (id: string, render: MarketRun["render"]) => setRun((current) => (current && current.id === id ? { ...current, render } : current)),
    dismiss: () => setRun(null),
  };
}
