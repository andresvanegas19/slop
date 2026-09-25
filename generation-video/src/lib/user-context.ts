import { AsyncLocalStorage } from "node:async_hooks";
import { getClient, isRawTreeConfigured } from "@/lib/rawtree";
import { logInfo } from "@/lib/runtime-log";

/**
 * Per-user context from `slop_human_user_prompts` (see docs/RAWTREE_USER_CONTEXT.md): the user's recent prompts,
 * inferred preferences and recent failures, as a short text block for the small LLM calls (and rows for memory.ts). Never throws.
 */

export const USER_PROMPTS_TABLE = "slop_human_user_prompts";
export const ANONYMOUS_USER = "anonymous";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CHARS = 1_200;
const CACHE_MS = 30 * 1000;
const RECENT_PROMPTS = 15;

/** Accepts the X-Longform-User header only when it is a UUID (lowercased); anything else is "anonymous". */
export function parseUserId(header: string | null | undefined) {
  const value = header?.trim().toLowerCase() ?? "";
  return UUID.test(value) ? value : ANONYMOUS_USER;
}

type RequestUser = { userId: string; projectId?: string; researchSessionId?: string };
const requestUser = new AsyncLocalStorage<RequestUser>();

/** Runs `task` with the request's user (read by userContextBlock deep inside the LLM helpers). */
export function runWithUser<T>(user: RequestUser, task: () => T): T {
  return requestUser.run(user, task);
}

export function currentUser(): RequestUser | undefined {
  return requestUser.getStore();
}

const cache = new Map<string, { at: number; rows: Promise<UserPromptRow[]> }>();

export function invalidateUserContext(userId: string) {
  cache.delete(userId);
}

export type UserPromptRow = {
  eventId: string; surface: string; prompt: string; outcome: string; error: string; action: string; duration: number | null; projectId: string; createdAt: string;
};
type PromptRow = UserPromptRow;

const STYLE_TERMS = [
  "cinematic", "golden hour", "slow motion", "drone", "aerial", "close-up", "macro", "neon", "noir", "black and white", "vintage",
  "film grain", "anime", "cartoon", "watercolor", "3d", "photorealistic", "minimalist", "handheld", "timelapse", "sunset", "sunrise",
  "night", "rain", "snow", "warm", "pastel", "moody", "documentary", "retro", "futuristic", "epic", "dramatic", "playful", "corporate",
];

const STOPWORDS = new Set(("the a an and or of to in on at for with from into over under by as is are was were be it its this that these those make "
  + "add more less some very then than now just like want need please video shot clip scene frame show about into onto them they their "
  + "your you our what when where which while have has had would could should will can also more most seconds second longer shorter "
  + "change remove keep same new make made using use each every there here").split(/\s+/));

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function topCounts(values: string[], min: number, limit: number) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count >= min).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

/** Inferred preferences (most-used surfaces/durations, recurring style words and subjects), one sentence per line. */
export function inferPreferences(rows: PromptRow[]) {
  const lines: string[] = [];
  const surfaces = topCounts(rows.map((row) => row.surface), 1, 3);
  if (surfaces.length) lines.push(`Most used: ${surfaces.map(([surface, count]) => `${surface} (${count})`).join(", ")}.`);
  const durations = topCounts(
    rows.filter((row) => /^(new_clip|preset_|storyboard)/.test(row.surface) && row.duration && row.duration > 0).map((row) => `${Math.round(row.duration as number)}s`),
    2, 2,
  );
  if (durations.length) lines.push(`Usual length: ${durations.map(([value]) => value).join(", ")}.`);
  const texts = rows.filter((row) => row.outcome === "ok").map((row) => row.prompt.toLowerCase());
  const styles = STYLE_TERMS
    .map((term) => [term, texts.filter((text) => new RegExp(`\\b${term.replace(/[-\s]/g, "[-\\s]?")}\\b`).test(text)).length] as const)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (styles.length) lines.push(`Recurring style words: ${styles.map(([term]) => term).join(", ")}.`);
  const words = texts.flatMap((text) => [...new Set(text.match(/[a-z][a-z0-9'-]{3,}/g) ?? [])])
    .filter((word) => !STOPWORDS.has(word) && !STYLE_TERMS.includes(word));
  const subjects = topCounts(words, 2, 5);
  if (subjects.length) lines.push(`Recurring subjects: ${subjects.map(([word]) => word).join(", ")}.`);
  return lines;
}

function buildText(rows: PromptRow[], projectId?: string) {
  if (rows.length === 0) return "";
  const seen = new Set<string>();
  const recent: string[] = [];
  for (const row of rows) {
    const key = row.prompt.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    recent.push(`- [${row.surface}${projectId && row.projectId === projectId ? ", this video" : ""}] ${oneLine(row.prompt, 110)}`);
    if (recent.length >= RECENT_PROMPTS) break;
  }
  const failed = rows.filter((row) => row.outcome !== "ok" && row.prompt.trim()).slice(0, 3)
    .map((row) => `- [${row.surface}] ${oneLine(row.prompt, 70)} → ${row.outcome}${row.error ? `: ${oneLine(row.error, 60)}` : ""}`);

  const sections = [
    ...(recent.length ? ["Recent requests (newest first):", ...recent] : []),
    ...inferPreferences(rows),
    ...(failed.length ? ["Recently failed/cancelled (don't repeat):", ...failed] : []),
  ];
  let text = "";
  for (const line of sections) {
    if (text.length + line.length + 1 > MAX_CHARS) continue;
    text += `${text ? "\n" : ""}${line}`;
  }
  return text;
}

async function queryRows(userId: string): Promise<UserPromptRow[]> {
  const result = await getClient().query<Record<string, unknown>>({
    sql: `SELECT toString(event_id) AS event_id, toString(surface) AS surface, toString(prompt) AS prompt, toString(outcome) AS outcome,
      toString(error) AS error, toString(action) AS action, toString(duration_sec) AS duration, toString(project_id) AS project_id,
      toString(created_at) AS created_at
      FROM ${USER_PROMPTS_TABLE} WHERE toString(user_id) = '${userId}' ORDER BY created_at DESC LIMIT 60`,
  });
  const clean = (value: unknown) => {
    const text = typeof value === "string" ? value : value == null ? "" : String(value);
    return text === "NULL" || text === "\\N" ? "" : text;
  };
  return result.data.map((row) => {
    const duration = Number(clean(row.duration));
    return {
      eventId: clean(row.event_id),
      surface: clean(row.surface),
      prompt: clean(row.prompt),
      outcome: clean(row.outcome),
      error: clean(row.error),
      action: clean(row.action),
      duration: clean(row.duration) && Number.isFinite(duration) ? duration : null,
      projectId: clean(row.project_id),
      createdAt: clean(row.created_at),
    };
  });
}

/** The user's last 60 logged prompts, newest first (cached 30 s; [] for anonymous users or on any failure). */
export async function loadUserPrompts(userId: string): Promise<UserPromptRow[]> {
  if (!UUID.test(userId)) return [];
  try {
    if (!isRawTreeConfigured()) return [];
    const cached = cache.get(userId);
    if (cached && Date.now() - cached.at < CACHE_MS) return await cached.rows;
    const rows = queryRows(userId);
    cache.set(userId, { at: Date.now(), rows });
    return await rows;
  } catch (error) {
    cache.set(userId, { at: Date.now(), rows: Promise.resolve([]) });
    logInfo("user_context_unavailable", { reason: error instanceof Error ? error.message.slice(0, 200) : String(error) });
    return [];
  }
}

/** Compact (≤ 1200 chars) summary of the user's recent prompts; "" for anonymous users, missing table, or any failure. */
export async function getUserContext(userId: string, options: { projectId?: string } = {}): Promise<string> {
  try {
    const projectId = options.projectId && /^[a-zA-Z0-9_-]{1,128}$/.test(options.projectId) ? options.projectId : undefined;
    return buildText(await loadUserPrompts(userId), projectId);
  } catch {
    return "";
  }
}

/**
 * The current request user's context as a delimited block for a system prompt ("" when there is none). `maxChars`
 * trims it further for calls where the small model's context is tight (e.g. intent routing).
 */
export async function userContextBlock(options: { maxChars?: number } = {}): Promise<string> {
  const user = currentUser();
  if (!user || user.userId === ANONYMOUS_USER) return "";
  let text = await getUserContext(user.userId, { projectId: user.projectId });
  if (!text) return "";
  if (options.maxChars && text.length > options.maxChars) text = text.slice(0, text.lastIndexOf("\n", options.maxChars) > 0 ? text.lastIndexOf("\n", options.maxChars) : options.maxChars);
  return `\n\n=== User context (this user's past requests; use only to match their taste, never copy them into the output, never change the current shot's style because of them) ===\n${text}\n=== End user context ===`;
}
