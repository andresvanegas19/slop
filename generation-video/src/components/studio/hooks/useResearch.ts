"use client";

/*
 * Company research sessions (/api/research). One session is shown at a time: the active "home" session
 * (persisted in localStorage so a reload resumes it) or, in the editor, the session linked to the open history item.
 * Events are read from the NDJSON stream and resumed with ?after=<seq> whenever the stream ends while research runs.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createLineSplitter, parseStreamLine } from "../ndjson";
import { parseStoryline, type Storyline } from "@/lib/storyline";
import { applyResearchEvent, applySnapshot, isResearchFollowing, isResearchRunning, newResearchSession } from "../research";
import type { ResearchSession } from "../types";
import { errorMessage, readJson } from "../utils";
import { userHeaders } from "./storage";

export type ResearchTarget = { id: string; prompt: string; company: string; durationSec: number; startedAt?: string };

/* ---- Active home session (localStorage, guarded) ---- */
const ACTIVE_KEY = "longform.research.active.v1";
let activeCache: ResearchTarget | null | undefined;
const activeListeners = new Set<() => void>();

function readActive(): ResearchTarget | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ACTIVE_KEY) ?? "null") as unknown;
    const value = parsed as Partial<ResearchTarget> | null;
    return value && typeof value.id === "string" && typeof value.prompt === "string" ? { id: value.id, prompt: value.prompt, company: typeof value.company === "string" ? value.company : "", durationSec: typeof value.durationSec === "number" ? value.durationSec : 10, startedAt: value.startedAt } : null;
  } catch (caughtError) {
    console.error("[research] could not read the active research session", caughtError);
    return null;
  }
}

function getActiveSnapshot() {
  if (activeCache === undefined) activeCache = readActive();
  return activeCache;
}

function subscribeActive(listener: () => void) {
  activeListeners.add(listener);
  return () => {
    activeListeners.delete(listener);
  };
}

export function setActiveResearch(target: ResearchTarget | null) {
  activeCache = target;
  try {
    if (target) window.localStorage.setItem(ACTIVE_KEY, JSON.stringify(target));
    else window.localStorage.removeItem(ACTIVE_KEY);
  } catch (caughtError) {
    console.error("[research] could not save the active research session", caughtError);
  }
  activeListeners.forEach((listener) => listener());
}

export function getActiveResearchId() {
  return getActiveSnapshot()?.id ?? null;
}

export function useActiveResearch() {
  return useSyncExternalStore(subscribeActive, getActiveSnapshot, () => null);
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = window.setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { window.clearTimeout(timer); resolve(); }, { once: true });
});

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, { method: "POST", headers: { ...userHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const result = await readJson<{ error?: unknown }>(response, `The research service returned HTTP ${response.status}.`);
  if (!response.ok) {
    console.error(`[research] POST ${url} failed with HTTP ${response.status}`, result);
    throw new Error(errorMessage(result, `The research service returned HTTP ${response.status}.`));
  }
  return result;
}

/** Starts a research session and returns its id. */
export async function startResearchSession(prompt: string): Promise<string> {
  const result = await postJson("/api/research", { prompt }) as { session_id?: unknown; sessionId?: unknown; id?: unknown };
  const id = [result.session_id, result.sessionId, result.id].find((value): value is string => typeof value === "string" && value.length > 0);
  if (!id) throw new Error("The research service did not return a session id.");
  return id;
}

/** Follows `target` (snapshot + event stream) while it is set. */
export function useResearch(target: ResearchTarget | null) {
  const [session, setSession] = useState<ResearchSession | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [restartKey, setRestartKey] = useState(0);
  const sessionRef = useRef<ResearchSession | null>(null);
  const targetKey = target ? JSON.stringify(target) : null;

  function mutate(id: string, update: (current: ResearchSession) => ResearchSession) {
    const current = sessionRef.current;
    if (!current || current.id !== id) return;
    sessionRef.current = update(current);
    setSession(sessionRef.current);
  }

  useEffect(() => {
    if (!targetKey) return;
    const followed = JSON.parse(targetKey) as ResearchTarget;
    const controller = new AbortController();
    const { signal } = controller;
    const id = followed.id;
    if (sessionRef.current?.id !== id) sessionRef.current = newResearchSession(followed);

    async function loadSnapshot() {
      const response = await fetch(`/api/research/${encodeURIComponent(id)}`, { signal });
      if (response.status === 404) throw Object.assign(new Error("This research session is no longer available."), { fatal: true });
      const result = await readJson<Record<string, unknown>>(response, `Could not load the research session (HTTP ${response.status}).`);
      if (!response.ok) throw new Error(errorMessage(result, `Could not load the research session (HTTP ${response.status}).`));
      mutate(id, (current) => applySnapshot(current, result));
    }

    async function readEvents() {
      const after = sessionRef.current?.lastSeq ?? 0;
      const response = await fetch(`/api/research/${encodeURIComponent(id)}/events?after=${after}`, { signal, headers: { Accept: "application/x-ndjson" } });
      if (!response.ok || !response.body) throw new Error(`The research event stream returned HTTP ${response.status}.`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const lines = createLineSplitter();
      const handle = (line: string) => {
        const event = parseStreamLine(line) ?? (() => { try { return JSON.parse(line) as unknown; } catch { return null; } })();
        if (event) mutate(id, (current) => applyResearchEvent(current, event));
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lines.push(decoder.decode(value, { stream: true })).forEach(handle);
      }
      [...lines.push(decoder.decode()), ...lines.flush()].forEach(handle);
    }

    void (async () => {
      setSession(sessionRef.current);
      let failures = 0;
      while (!signal.aborted) {
        try {
          await loadSnapshot();
          await readEvents();
          failures = 0;
        } catch (caughtError) {
          if (signal.aborted) return;
          failures += 1;
          console.error("[research] lost the research stream", caughtError);
          const fatal = (caughtError as { fatal?: boolean }).fatal === true;
          if (fatal || failures >= 5) {
            mutate(id, (current) => ({ ...current, error: caughtError instanceof Error ? caughtError.message : "Lost the connection to the research session." }));
            return;
          }
        }
        const current = sessionRef.current;
        // Competitor research and storylines continue after the company research itself is done.
        if (!current || !isResearchFollowing(current)) break;
        await sleep(failures ? 1500 * failures : 600, signal);
      }
      if (!signal.aborted) await loadSnapshot().catch(() => undefined);
    })();
    return () => controller.abort();
  }, [targetKey, restartKey]);

  async function answer(questionId: string, text: string) {
    const current = sessionRef.current;
    const value = text.trim();
    if (!current || !value) return;
    setActionError(null);
    mutate(current.id, (session) => ({ ...session, questions: session.questions.map((question) => question.id === questionId ? { ...question, answered: true, answer: value } : question) }));
    try {
      await postJson(`/api/research/${encodeURIComponent(current.id)}/answer`, { question_id: questionId, answer: value });
    } catch (caughtError) {
      mutate(current.id, (session) => ({ ...session, questions: session.questions.map((question) => question.id === questionId ? { ...question, answered: false, answer: undefined } : question) }));
      setActionError(caughtError instanceof Error ? caughtError.message : "Could not send your answer.");
    }
  }

  async function setLooping(looping: boolean) {
    const current = sessionRef.current;
    if (!current) return;
    setActionError(null);
    mutate(current.id, (session) => ({ ...session, looping }));
    try {
      await postJson(`/api/research/${encodeURIComponent(current.id)}/loop`, { looping });
      // Resuming a finished session: follow the stream again.
      if (looping && !isResearchRunning(current)) {
        mutate(current.id, (session) => ({ ...session, status: "running", error: undefined }));
        setRestartKey((key) => key + 1);
      }
    } catch (caughtError) {
      mutate(current.id, (session) => ({ ...session, looping: !looping }));
      setActionError(caughtError instanceof Error ? caughtError.message : "Could not change the research loop.");
    }
  }

  async function stop() {
    const current = sessionRef.current;
    if (!current) return;
    setActionError(null);
    try {
      await postJson(`/api/research/${encodeURIComponent(current.id)}/stop`, {});
      mutate(current.id, (session) => ({ ...session, status: "stopped", looping: false }));
    } catch (caughtError) {
      setActionError(caughtError instanceof Error ? caughtError.message : "Could not stop the research.");
    }
  }

  function storylineFrom(result: unknown): Storyline {
    const parsed = parseStoryline((result as { storyline?: unknown } | null)?.storyline);
    if ("error" in parsed) throw new Error(`The agent returned an invalid storyline: ${parsed.error}`);
    return parsed.storyline;
  }

  /**
   * Asks the agent's storyline tool for a storyline (what the user asked + research + competitors) for a video of
   * `durationSec`, optionally forcing a template. Returns it, or null when it failed (see actionError).
   */
  async function requestStoryline(durationSec: number, template?: string): Promise<Storyline | null> {
    const current = sessionRef.current;
    if (!current || current.storylineWriting) return null;
    setActionError(null);
    const wasFollowing = isResearchFollowing(current);
    mutate(current.id, (session) => ({ ...session, storylineWriting: true }));
    // Follow the stream again so competitor progress (the storyline waits for it) shows up while it writes.
    if (!wasFollowing) setRestartKey((key) => key + 1);
    try {
      const storyline = storylineFrom(await postJson(`/api/research/${encodeURIComponent(current.id)}/storyline`, { durationSec, prompt: current.prompt, ...(template ? { template } : {}), waitSec: 45 }));
      mutate(current.id, (session) => ({ ...session, storyline, storylineWriting: false }));
      return storyline;
    } catch (caughtError) {
      mutate(current.id, (session) => ({ ...session, storylineWriting: false }));
      setActionError(caughtError instanceof Error ? caughtError.message : "Could not write the storyline.");
      return null;
    }
  }

  /** Saves the user's beat/title edits (the agent re-checks them: no competitor names). Returns the new version, or null. */
  async function saveStorylineEdits(edits: Record<string, unknown>): Promise<Storyline | null> {
    const current = sessionRef.current;
    if (!current) return null;
    setActionError(null);
    try {
      const storyline = storylineFrom(await postJson(`/api/research/${encodeURIComponent(current.id)}/storyline`, { edits }));
      mutate(current.id, (session) => ({ ...session, storyline }));
      return storyline;
    } catch (caughtError) {
      setActionError(caughtError instanceof Error ? caughtError.message : "Could not save your storyline edits.");
      return null;
    }
  }

  // Until the first update lands, show the target as a fresh "starting" session.
  const shown = target ? session?.id === target.id ? session : newResearchSession(target) : null;
  return { session: shown, actionError, answer, setLooping, stop, requestStoryline, saveStorylineEdits, setActionError };
}

export type Research = ReturnType<typeof useResearch>;
