import { bigramsOf, formatGuidanceLine, jaccard, searchKnowledge, tokenize } from "@/lib/rag";
import { getClient, isRawTreeConfigured } from "@/lib/rawtree";
import { logInfo } from "@/lib/runtime-log";
import { currentUser, inferPreferences, loadUserPrompts } from "@/lib/user-context";
import { EVENTS_TABLE } from "@/lib/video-store";

/**
 * One retrieval step for every LLM call ("memory"): knowledge docs + learned edit examples (src/lib/rag.ts), past
 * published videos (slop_human_video_events), the user's own past prompts (slop_human_user_prompts) and company
 * research findings (slop_human_research_events, when a research session is known). Candidates from every source are
 * scored on a common 0..1 scale, weighted per source, decayed by age, de-duplicated, capped per source and fitted
 * into `maxChars`. Every line says where it comes from, and `sources` lists them for the UI. Never throws.
 */

export type MemoryKind = "knowledge" | "video" | "user_prompt" | "research" | "example";

export type MemorySource = {
  kind: MemoryKind;
  title: string;
  /** file#section | video_sha256 | event_id | url */
  ref: string;
  /** App link (e.g. /api/rawtree/videos/<sha>) or the evidence URL. */
  url?: string;
  at?: string;
  score: number;
};

export type MemoryContext = { text: string; sources: MemorySource[] };

export type MemoryOptions = {
  userId?: string;
  projectId?: string;
  researchSessionId?: string;
  tags?: string[];
  k?: number;
  maxChars?: number;
  /** Restrict the sources searched (default: all). */
  kinds?: MemoryKind[];
};

const RESEARCH_TABLE = "slop_human_research_events";
const HEADER = "Memory (reference notes; each says where it comes from — never copy its sentences or change the current style because of it):";
const CACHE_MS = 30_000;
const RAWTREE_TIMEOUT_MS = 4_000;
const WEIGHT: Record<MemoryKind, number> = { knowledge: 1, research: 0.9, example: 0.8, video: 0.75, user_prompt: 0.65 };
const CAP: Record<MemoryKind, number> = { knowledge: 3, example: 1, video: 2, user_prompt: 2, research: 2 };
const HALF_LIFE_DAYS: Record<MemoryKind, number> = { knowledge: Infinity, example: 30, video: 21, user_prompt: 14, research: 60 };
/** BM25 score at which a match counts as "half relevant" when mapping raw scores to 0..1. */
const SATURATION = 4;
const MIN_SCORE = 0.12;
const MIN_RELATIVE = 0.25;
const NEAR_DUPLICATE = 0.7;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

type Candidate = MemorySource & { label: string; body: string; tokens: Set<string> };

// ---------- RawTree reads (cached 30 s, time-boxed) ----------

const rawCache = new Map<string, { at: number; value: Promise<Record<string, unknown>[]> }>();

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function cachedRows(key: string, sql: string): Promise<Record<string, unknown>[]> {
  const hit = rawCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = (async () => {
    try {
      if (!isRawTreeConfigured()) return [];
      return (await withTimeout(getClient().query<Record<string, unknown>>({ sql }), RAWTREE_TIMEOUT_MS)).data;
    } catch (error) {
      logInfo("memory_source_unavailable", { key: key.split(":")[0], reason: error instanceof Error ? error.message.slice(0, 160) : String(error) });
      return [];
    }
  })();
  rawCache.set(key, { at: Date.now(), value });
  return value;
}

const text = (value: unknown) => {
  const raw = typeof value === "string" ? value : value == null ? "" : String(value);
  return raw === "NULL" || raw === "\\N" ? "" : raw;
};
const flat = (value: string, max: number) => {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** "2026-09-25 22:03:14.224" (RawTree DateTime) or ISO → ms. */
function timeOf(value?: string) {
  if (!value) return NaN;
  return Date.parse(value.includes("T") ? value : `${value.replace(" ", "T").slice(0, 23)}Z`);
}

function ago(value?: string) {
  const at = timeOf(value);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, (Date.now() - at) / 60_000);
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

function isoOf(value?: string) {
  const at = timeOf(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

// ---------- candidates per source ----------

async function knowledgeCandidates(query: string, options: MemoryOptions, k: number): Promise<Candidate[]> {
  const hits = await searchKnowledge(query, { k: k + 2, tags: options.tags });
  return hits.map((hit) => {
    const example = hit.kind === "example";
    const title = example ? "Past edit example" : hit.title;
    return {
      kind: hit.kind,
      title,
      ref: hit.ref,
      ...(hit.at ? { at: hit.at } : {}),
      score: hit.score / (hit.score + SATURATION),
      label: example ? `Example of an earlier edit${hit.at ? ` (${ago(hit.at)})` : ""}` : `Knowledge › ${hit.title}`,
      body: hit.body,
      tokens: new Set(tokenize(hit.body)),
    };
  });
}

/** Scores small in-memory docs against the query with BM25 (same tokenizer as the knowledge index) + bigram boost. */
function rankDocs<T extends { doc: string }>(query: string, docs: T[]): (T & { raw: number })[] {
  const ordered = tokenize(query);
  const terms = [...new Set(ordered)];
  const pairs = [...bigramsOf(ordered)];
  if (!terms.length || !docs.length) return [];
  const tokenized = docs.map((entry) => tokenize(entry.doc));
  const docFreq = new Map<string, number>();
  for (const tokens of tokenized) for (const term of new Set(tokens)) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
  const avg = tokenized.reduce((sum, tokens) => sum + tokens.length, 0) / tokenized.length || 1;
  // A floor on N keeps idf meaningful when there are only a few rows.
  const n = Math.max(tokenized.length, 20);
  return docs.map((entry, position) => {
    const tokens = tokenized[position];
    const freq = new Map<string, number>();
    for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
    let raw = 0;
    for (const term of terms) {
      const tf = freq.get(term);
      if (!tf) continue;
      const df = docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      raw += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * tokens.length) / avg));
    }
    if (raw > 0 && pairs.length) {
      const own = bigramsOf(tokens);
      raw *= 1 + Math.min(0.5, pairs.filter((pair) => own.has(pair)).length * 0.12);
    }
    return { ...entry, raw };
  }).filter((entry) => entry.raw > 0);
}

async function videoCandidates(query: string, options: MemoryOptions): Promise<Candidate[]> {
  const rows = await cachedRows("videos", `SELECT toString(event_id) AS event_id, toString(project_id) AS project_id, toString(title) AS title,
    toString(reason) AS reason, toString(video_sha256) AS video_sha256, toString(prompts) AS prompts, toString(frames) AS frames,
    toString(duration_sec) AS duration_sec, toString(created_at) AS created_at
    FROM ${EVENTS_TABLE} WHERE toString(app) = 'longform' ORDER BY created_at DESC LIMIT 150`);
  const seen = new Set<string>();
  const docs: { row: Record<string, unknown>; doc: string; edits: string[] }[] = [];
  for (const row of rows) {
    const projectId = text(row.project_id);
    // The current project is already in the prompt; one (newest) version per other project.
    if (!projectId || projectId === options.projectId || seen.has(projectId)) continue;
    seen.add(projectId);
    const frames = parseJson(text(row.frames));
    const edits = Array.isArray(frames)
      ? frames.flatMap((frame) => (Array.isArray((frame as { edits?: unknown }).edits) ? (frame as { edits: { prompt?: unknown }[] }).edits : []))
        .map((edit) => (typeof edit.prompt === "string" ? edit.prompt : "")).filter(Boolean)
      : [];
    docs.push({ row, edits, doc: `${text(row.title)} ${text(row.title)} ${text(row.prompts)} ${edits.join(" ")}` });
  }
  return rankDocs(query, docs).map(({ row, edits, raw }) => {
    const sha = text(row.video_sha256);
    const title = text(row.title) || "Untitled video";
    const createdAt = text(row.created_at);
    const duration = Number(text(row.duration_sec));
    const prompts = text(row.prompts).replace(/^\d+\.\s*/gm, "").split("\n").filter(Boolean);
    const body = [prompts[0] ? `prompt: ${flat(prompts[0], 180)}` : "", edits.length ? `last edit: ${flat(edits[edits.length - 1], 90)}` : ""]
      .filter(Boolean).join("; ");
    return {
      kind: "video" as const,
      title,
      ref: sha,
      ...(/^[0-9a-f]{64}$/.test(sha) ? { url: `/api/rawtree/videos/${sha}` } : {}),
      ...(isoOf(createdAt) ? { at: isoOf(createdAt) } : {}),
      score: raw / (raw + SATURATION),
      label: `Past video "${flat(title, 60)}" (${[ago(createdAt), text(row.reason), Number.isFinite(duration) && duration > 0 ? `${Math.round(duration * 10) / 10}s` : ""].filter(Boolean).join(", ")})`,
      body: body || flat(title, 120),
      tokens: new Set(tokenize(body)),
    };
  });
}

async function userPromptCandidates(query: string, userId: string, projectId?: string): Promise<Candidate[]> {
  const rows = await loadUserPrompts(userId);
  if (!rows.length) return [];
  const seen = new Set<string>();
  const docs = rows.filter((row) => {
    const key = row.prompt.toLowerCase().replace(/\s+/g, " ").trim();
    if (row.outcome !== "ok" || !key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((row) => ({ row, doc: row.prompt }));
  const candidates: Candidate[] = rankDocs(query, docs).map(({ row, raw }) => ({
    kind: "user_prompt" as const,
    title: flat(row.prompt, 60),
    ref: row.eventId,
    ...(isoOf(row.createdAt) ? { at: isoOf(row.createdAt) } : {}),
    score: raw / (raw + SATURATION),
    label: `Your earlier request (${[ago(row.createdAt), row.surface, projectId && row.projectId === projectId ? "this video" : ""].filter(Boolean).join(", ")})`,
    body: `"${flat(row.prompt, 200)}"`,
    tokens: new Set(tokenize(row.prompt)),
  }));
  const preferences = inferPreferences(rows).filter((line) => !line.startsWith("Most used"));
  if (preferences.length) {
    candidates.push({
      kind: "user_prompt",
      title: "Your usual style",
      ref: `user:${userId}`,
      // Always somewhat relevant, never above a real match.
      score: 0.3,
      label: "Your usual style (inferred from your past requests)",
      body: preferences.join(" "),
      tokens: new Set(tokenize(preferences.join(" "))),
    });
  }
  return candidates;
}

async function researchCandidates(query: string, sessionId: string): Promise<Candidate[]> {
  const rows = await cachedRows(`research:${sessionId}`, `SELECT toString(event_id) AS event_id, toString(type) AS type, toString(payload) AS payload,
    toString(evidence_url) AS evidence_url, toString(company) AS company, toString(created_at) AS created_at
    FROM ${RESEARCH_TABLE} WHERE toString(session_id) = '${sessionId}' AND toString(type) IN ('finding', 'profile') LIMIT 200`);
  const docs = rows.map((row) => {
    const payload = (parseJson(text(row.payload)) ?? {}) as Record<string, unknown>;
    const claim = typeof payload.claim === "string" ? payload.claim
      : Object.values(payload).filter((value): value is string => typeof value === "string").join(" ").slice(0, 400);
    const url = text(row.evidence_url) || (typeof payload.evidence_url === "string" ? payload.evidence_url : "");
    return { row, claim, url, doc: `${claim} ${typeof payload.topic === "string" ? payload.topic : ""} ${text(row.company)}` };
  }).filter((entry) => entry.claim);
  return rankDocs(query, docs).map(({ row, claim, url, raw }) => {
    let domain = "";
    try {
      domain = url ? new URL(url).hostname.replace(/^www\./, "") : "";
    } catch {
      domain = "";
    }
    const createdAt = text(row.created_at);
    return {
      kind: "research" as const,
      title: domain || text(row.company) || "Research",
      ref: url || text(row.event_id),
      ...(/^https?:\/\//.test(url) ? { url } : {}),
      ...(isoOf(createdAt) ? { at: isoOf(createdAt) } : {}),
      score: raw / (raw + SATURATION),
      label: `Research finding${domain ? ` (${domain})` : ""}`,
      body: flat(claim, 220),
      tokens: new Set(tokenize(claim)),
    };
  });
}

// ---------- ranking ----------

function decayed(candidate: Candidate) {
  const halfLife = HALF_LIFE_DAYS[candidate.kind];
  const at = timeOf(candidate.at);
  const recency = Number.isFinite(halfLife) && Number.isFinite(at) ? Math.pow(0.5, Math.max(0, Date.now() - at) / 86_400_000 / halfLife) : 1;
  return candidate.score * WEIGHT[candidate.kind] * (0.7 + 0.3 * recency);
}

/** Retrieves memory for an LLM call; user/project/research session default to the current request's (never throws). */
export async function retrieveMemory(query: string, options: MemoryOptions = {}): Promise<MemoryContext> {
  const startedAt = Date.now();
  try {
    const request = currentUser();
    const userId = options.userId ?? request?.userId;
    const projectId = options.projectId ?? request?.projectId;
    const researchSessionId = options.researchSessionId ?? request?.researchSessionId;
    const k = Math.max(1, Math.min(12, Math.floor(options.k ?? 5)));
    const maxChars = Math.max(200, Math.floor(options.maxChars ?? 1_600));
    const wants = (kind: MemoryKind) => !options.kinds || options.kinds.includes(kind);
    const q = typeof query === "string" ? query : "";
    if (!tokenize(q).length) return { text: "", sources: [] };

    const groups = await Promise.all([
      wants("knowledge") || wants("example")
        ? knowledgeCandidates(q, options, k).then((list) => list.filter((candidate) => wants(candidate.kind)))
        : Promise.resolve([]),
      wants("video") ? videoCandidates(q, { ...options, projectId }) : Promise.resolve([]),
      wants("user_prompt") && userId ? userPromptCandidates(q, userId, projectId) : Promise.resolve([]),
      wants("research") && researchSessionId && SAFE_ID.test(researchSessionId) ? researchCandidates(q, researchSessionId) : Promise.resolve([]),
    ].map((promise) => promise.catch((error: unknown) => {
      logInfo("memory_source_failed", { reason: error instanceof Error ? error.message.slice(0, 200) : String(error) });
      return [] as Candidate[];
    })));

    const ranked = groups.flat().map((candidate) => ({ candidate, value: decayed(candidate) })).sort((a, b) => b.value - a.value);
    if (!ranked.length) return { text: "", sources: [] };
    const floor = Math.max(MIN_SCORE, ranked[0].value * MIN_RELATIVE);
    const picked: { candidate: Candidate; value: number }[] = [];
    const perKind = new Map<MemoryKind, number>();
    for (const entry of ranked) {
      if (picked.length >= k || entry.value < floor) break;
      const { kind } = entry.candidate;
      if ((perKind.get(kind) ?? 0) >= CAP[kind]) continue;
      if (picked.some((other) => jaccard(other.candidate.tokens, entry.candidate.tokens) >= NEAR_DUPLICATE)) continue;
      perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
      picked.push(entry);
    }

    const lines: string[] = [];
    const sources: MemorySource[] = [];
    let used = HEADER.length;
    for (const { candidate, value } of picked) {
      const remaining = maxChars - used - 1;
      if (remaining <= 0) break;
      const line = formatGuidanceLine(lines.length + 1, candidate.label, candidate.body, remaining);
      if (!line) continue;
      lines.push(line);
      used += line.length + 1;
      sources.push({
        kind: candidate.kind,
        title: candidate.title,
        ref: candidate.ref,
        ...(candidate.url ? { url: candidate.url } : {}),
        ...(candidate.at ? { at: candidate.at } : {}),
        score: Math.round(value * 1000) / 1000,
      });
    }
    const byKind = sources.reduce<Record<string, number>>((counts, source) => ({ ...counts, [source.kind]: (counts[source.kind] ?? 0) + 1 }), {});
    logInfo("memory_retrieved", { candidates: ranked.length, sources: sources.length, byKind: Object.entries(byKind).map(([kind, count]) => `${kind}:${count}`).join(","), chars: lines.reduce((sum, line) => sum + line.length + 1, HEADER.length), query: q, durationMs: Date.now() - startedAt });
    if (!lines.length) return { text: "", sources: [] };
    return { text: `${HEADER}\n${lines.join("\n")}`, sources };
  } catch (error) {
    logInfo("memory_failed", { reason: error instanceof Error ? error.message.slice(0, 200) : String(error) });
    return { text: "", sources: [] };
  }
}

/** Merges source lists (e.g. intent + generation memory), keeping the best score per (kind, ref). */
export function mergeMemorySources(...lists: (MemorySource[] | undefined)[]): MemorySource[] {
  const byKey = new Map<string, MemorySource>();
  for (const source of lists.flatMap((list) => list ?? [])) {
    const key = `${source.kind}|${source.ref}`;
    const existing = byKey.get(key);
    if (!existing || existing.score < source.score) byKey.set(key, source);
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score);
}
