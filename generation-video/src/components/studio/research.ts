/* Company research sessions: pure helpers (prompt detection, snapshot + event folding). Field names are read tolerantly. */
import { parseStoryline } from "@/lib/storyline";
import type { ResearchCompetitor, ResearchCompetitors, ResearchFinding, ResearchQuestion, ResearchSession, ResearchStats } from "./types";

type Loose = Record<string, unknown>;
const str = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;

const NOT_COMPANIES = new Set(["Christmas", "Halloween", "Easter", "Thanksgiving", "Valentine's", "Valentines", "New", "My", "Our", "The", "A", "An", "Me", "Us", "Mom", "Dad", "Instagram", "TikTok", "YouTube", "Reels"]);

/**
 * The company named by prompts like "make a video for Coca-Cola" / "an ad about Acme Corp", or null.
 * Only capitalized names directly after "video/short/ad/promo … for/about" count, so ordinary clip prompts are unaffected.
 */
export function companyFromPrompt(prompt: string): string | null {
  const match = /\b(?:video|short|ad|advert|advertisement|commercial|promo|brand film)\s+(?:for|about)\s+(?:the\s+)?(?:company\s+|brand\s+)?([A-Z0-9][\w&.'’-]*(?:\s+[A-Z0-9][\w&.'’-]*){0,3})/.exec(prompt);
  if (!match) return null;
  const name = match[1].replace(/[.'’-]+$/, "");
  if (!name || NOT_COMPANIES.has(name.split(/\s+/)[0])) return null;
  return name;
}

export const TERMINAL_STATUSES = new Set(["done", "complete", "completed", "finished", "stopped", "cancelled", "canceled", "error", "failed", "published"]);

export function isResearchRunning(session: ResearchSession) {
  return !TERMINAL_STATUSES.has(session.status) && !session.error;
}

const COMPETITORS_ACTIVE = new Set(["waiting", "running"]);

export function isCompetitorResearchActive(session: ResearchSession) {
  return Boolean(session.competitors && COMPETITORS_ACTIVE.has(session.competitors.status));
}

/** Keep following the session: the company research, its competitor research or a storyline is still in progress. */
export function isResearchFollowing(session: ResearchSession) {
  if (session.error && !isCompetitorResearchActive(session)) return false;
  return isResearchRunning(session) || isCompetitorResearchActive(session) || session.storylineWriting === true;
}

export function newResearchSession(init: { id: string; prompt: string; company: string; durationSec: number; startedAt?: string }): ResearchSession {
  return {
    id: init.id,
    prompt: init.prompt,
    company: init.company,
    durationSec: init.durationSec,
    startedAt: init.startedAt ?? new Date().toISOString(),
    status: "starting",
    profile: null,
    published: false,
    questions: [],
    findings: [],
    stats: { pages: 0, findings: 0, tokens: 0 },
    looping: false,
    lastSeq: 0,
    pagesSeen: 0,
  };
}

function mergeStats(current: ResearchStats, value: unknown): ResearchStats {
  if (!value || typeof value !== "object") return current;
  const stats = value as Loose;
  return {
    pages: Math.max(current.pages, num(stats.pages) ?? 0),
    findings: Math.max(current.findings, num(stats.findings) ?? 0),
    tokens: Math.max(current.tokens, num(stats.tokens) ?? 0),
  };
}

function toQuestion(value: unknown, answers: Record<string, string>): ResearchQuestion | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Loose;
  const id = str(raw.id) ?? str(raw.question_id) ?? (typeof raw.id === "number" ? String(raw.id) : undefined);
  const question = str(raw.question) ?? str(raw.text);
  if (!id || !question) return null;
  const options = Array.isArray(raw.options) ? raw.options.flatMap((option) => typeof option === "string" ? [option] : option && typeof option === "object" && str((option as Loose).label) ? [str((option as Loose).label) as string] : []) : [];
  const answer = answers[id] ?? str(raw.answer);
  return { id, question, options, answered: raw.answered === true || answer !== undefined, answer };
}

function answersMap(value: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const raw = entry as Loose;
      const id = str(raw.question_id) ?? str(raw.id);
      const answer = str(raw.answer);
      if (id && answer) map[id] = answer;
    }
  } else if (value && typeof value === "object") {
    for (const [id, answer] of Object.entries(value as Loose)) if (typeof answer === "string") map[id] = answer;
  }
  return map;
}

function upsertQuestion(questions: ResearchQuestion[], next: ResearchQuestion) {
  const index = questions.findIndex((question) => question.id === next.id);
  if (index === -1) return [...questions, next];
  const merged = { ...questions[index], ...next, answered: questions[index].answered || next.answered, answer: next.answer ?? questions[index].answer };
  return questions.map((question, position) => position === index ? merged : question);
}

/** Folds GET /api/research/{id} into the session (findings come from the event stream). */
export function applySnapshot(session: ResearchSession, value: unknown): ResearchSession {
  if (!value || typeof value !== "object") return session;
  const snapshot = value as Loose;
  const answers = answersMap(snapshot.answers);
  let questions = session.questions.map((question) => answers[question.id] ? { ...question, answered: true, answer: answers[question.id] } : question);
  if (Array.isArray(snapshot.questions)) {
    for (const raw of snapshot.questions) {
      const question = toQuestion(raw, answers);
      if (question) questions = upsertQuestion(questions, question);
    }
  }
  const profile = snapshot.profile ?? session.profile;
  const storyline = snapshot.storyline === null ? session.storyline ?? null : toStoryline(snapshot.storyline) ?? session.storyline;
  return {
    ...session,
    status: str(snapshot.status) ?? session.status,
    company: str(snapshot.company) ?? companyOfProfile(profile) ?? session.company,
    profile,
    questions,
    stats: mergeStats(session.stats, snapshot.stats),
    looping: typeof snapshot.looping === "boolean" ? snapshot.looping : session.looping,
    competitors: toCompetitors(snapshot.competitors, session.competitors) ?? session.competitors,
    storyline,
  };
}

function toStoryline(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const parsed = parseStoryline(value);
  if ("error" in parsed) {
    console.error("[research] ignored an invalid storyline from the agent", parsed.error);
    return undefined;
  }
  return parsed.storyline;
}

const strings = (value: unknown, max: number) => Array.isArray(value) ? value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []).slice(0, max) : [];

function toCompetitor(value: unknown, previous?: ResearchCompetitor): ResearchCompetitor | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Loose;
  const id = str(raw.id) ?? str(raw.competitor_id) ?? previous?.id;
  const name = str(raw.name) ?? previous?.name;
  if (!id || !name) return null;
  const claims = strings(raw.claims, 8);
  return {
    id,
    name,
    domain: str(raw.domain) ?? previous?.domain,
    verified: typeof raw.verified === "boolean" ? raw.verified : previous?.verified ?? false,
    summary: str(raw.summary) ?? previous?.summary,
    claims: claims.length ? claims : previous?.claims ?? [],
    pages: num(raw.pages) ?? (Array.isArray(raw.pages) ? raw.pages.length : undefined) ?? previous?.pages ?? 0,
    stage: str(raw.stage) ?? previous?.stage,
    currentPage: previous?.currentPage,
    error: str(raw.error) ?? previous?.error,
  };
}

function upsertCompetitor(items: ResearchCompetitor[], value: unknown) {
  const raw = value && typeof value === "object" ? value as Loose : {};
  const id = str(raw.id) ?? str(raw.competitor_id);
  const index = items.findIndex((item) => item.id === id);
  const next = toCompetitor(value, index === -1 ? undefined : items[index]);
  if (!next) return items;
  return index === -1 ? [...items, next] : items.map((item, position) => position === index ? next : item);
}

/** The competitor landscape from a snapshot (`competitors`) or a `competitors` event (`landscape`). */
function toCompetitors(value: unknown, current: ResearchCompetitors | undefined, status?: string, message?: string): ResearchCompetitors | undefined {
  if (!value || typeof value !== "object") {
    if (!status) return undefined;
    return { items: [], differentiators: [], avoidTerms: [], ...current, status, message: message ?? current?.message };
  }
  const raw = value as Loose;
  let items = current?.items ?? [];
  if (Array.isArray(raw.competitors)) for (const competitor of raw.competitors) items = upsertCompetitor(items, competitor);
  const differentiators = Array.isArray(raw.differentiators)
    ? raw.differentiators.flatMap((item) => typeof item === "string" ? [item] : item && typeof item === "object" && str((item as Loose).text) ? [str((item as Loose).text) as string] : []).slice(0, 8)
    : current?.differentiators ?? [];
  const avoid = strings(raw.avoid_terms, 60);
  return {
    status: status ?? str(raw.status) ?? current?.status ?? "none",
    message: message ?? str(raw.message) ?? str(raw.error) ?? current?.message,
    items,
    differentiators,
    avoidTerms: avoid.length ? avoid : current?.avoidTerms ?? [],
  };
}

function companyOfProfile(profile: unknown) {
  if (!profile || typeof profile !== "object") return undefined;
  const raw = profile as Loose;
  return str(raw.company) ?? str(raw.name);
}

/** Folds one line of GET /api/research/{id}/events into the session. */
export function applyResearchEvent(session: ResearchSession, value: unknown): ResearchSession {
  if (!value || typeof value !== "object") return session;
  const event = value as Loose;
  const seq = num(event.seq);
  if (seq !== undefined && seq <= session.lastSeq) return session;
  let next: ResearchSession = { ...session, lastSeq: seq ?? session.lastSeq, stats: mergeStats(session.stats, event.stats) };
  switch (event.type) {
    case "status":
      next = { ...next, status: str(event.status) ?? next.status, statusLabel: str(event.message) ?? str(event.label) ?? str(event.detail) ?? next.statusLabel, looping: typeof event.looping === "boolean" ? event.looping : next.looping, company: str(event.company) ?? next.company };
      break;
    case "page": {
      const url = str(event.url) ?? str(event.page);
      next = { ...next, currentPage: url ?? str(event.title) ?? next.currentPage, pagesSeen: next.pagesSeen + 1 };
      break;
    }
    case "finding": {
      const text = str(event.text) ?? str(event.finding) ?? str(event.summary) ?? str(event.fact) ?? str(event.content);
      if (!text) break;
      const finding: ResearchFinding = { key: `f-${seq ?? next.findings.length}`, text, source: str(event.source) ?? str(event.url), title: str(event.title) };
      next = { ...next, findings: [...next.findings, finding] };
      break;
    }
    case "question": {
      const question = toQuestion(event.question && typeof event.question === "object" ? event.question : event, {});
      if (question) next = { ...next, questions: upsertQuestion(next.questions, question) };
      break;
    }
    case "profile": {
      const profile = event.profile ?? event;
      next = { ...next, profile, company: companyOfProfile(profile) ?? next.company };
      break;
    }
    case "published":
      next = { ...next, published: true, statusLabel: str(event.message) ?? next.statusLabel };
      break;
    case "error":
      next = { ...next, error: str(event.error) ?? str(event.message) ?? "Research failed." };
      break;
    case "competitors":
      next = { ...next, competitors: toCompetitors(event.landscape, next.competitors, str(event.status), str(event.message)) ?? next.competitors };
      break;
    case "competitor": {
      const competitors = next.competitors ?? { status: "running", items: [], differentiators: [], avoidTerms: [] };
      const competitor = event.competitor && typeof event.competitor === "object" ? { ...(event.competitor as Loose), stage: event.stage ?? (event.competitor as Loose).stage } : event;
      next = { ...next, competitors: { ...competitors, items: upsertCompetitor(competitors.items, competitor) } };
      break;
    }
    case "competitor_page": {
      if (!next.competitors) break;
      const competitorId = str(event.competitor_id) ?? str(event.competitor);
      const url = str(event.url) ?? str(event.title);
      next = { ...next, competitors: { ...next.competitors, items: next.competitors.items.map((item) => item.id === competitorId || item.name === competitorId ? { ...item, currentPage: url ?? item.currentPage } : item) } };
      break;
    }
    case "storyline": {
      const storyline = toStoryline(event.storyline);
      next = storyline ? { ...next, storyline, storylineWriting: false } : { ...next, storylineWriting: str(event.stage) === "writing" ? true : str(event.stage) === "error" ? false : next.storylineWriting };
      break;
    }
  }
  return next;
}

/** "coca-colacompany.com/about" from a URL. */
export function shortUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname === "/" ? "" : parsed.pathname}`.slice(0, 60);
  } catch {
    return url.slice(0, 60);
  }
}

/** Pages / findings / tokens to display (server stats, or what the event stream has shown so far). */
export function researchCounts(session: ResearchSession): ResearchStats {
  return { pages: Math.max(session.stats.pages, session.pagesSeen), findings: Math.max(session.stats.findings, session.findings.length), tokens: session.stats.tokens };
}
