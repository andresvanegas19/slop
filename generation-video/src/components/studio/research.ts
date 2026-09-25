/* Company research sessions: pure helpers (prompt detection, snapshot + event folding). Field names are read tolerantly. */
import type { ResearchFinding, ResearchQuestion, ResearchSession, ResearchStats } from "./types";

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
  return {
    ...session,
    status: str(snapshot.status) ?? session.status,
    company: str(snapshot.company) ?? companyOfProfile(profile) ?? session.company,
    profile,
    questions,
    stats: mergeStats(session.stats, snapshot.stats),
    looping: typeof snapshot.looping === "boolean" ? snapshot.looping : session.looping,
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
