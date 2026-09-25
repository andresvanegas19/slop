/* sessionStorage / localStorage helpers for the editor (all access guarded). */
import type { ContinueAction, ThreadEntry } from "../types";

export const THREAD_KEY_PREFIX = "longform.thread.";
export const CONTINUE_MODE_KEY = "longform.continueMode";
export const USER_ID_KEY = "longform.userId";

let memoryUserId: string | undefined;

/** Anonymous, stable per-browser id (random UUID in localStorage), sent as X-Longform-User for per-user context. */
export function getUserId(): string {
  try {
    const stored = window.localStorage.getItem(USER_ID_KEY);
    if (stored && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stored)) return stored;
    const created = crypto.randomUUID();
    window.localStorage.setItem(USER_ID_KEY, created);
    return created;
  } catch {
    memoryUserId ??= typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : undefined;
    return memoryUserId ?? "";
  }
}

/** Headers for API requests: the anonymous user id (omitted when it can't be made). */
export function userHeaders(): Record<string, string> {
  const id = getUserId();
  return id ? { "X-Longform-User": id } : {};
}

export function loadContinueMode(): ContinueAction {
  try {
    const stored = window.sessionStorage.getItem(CONTINUE_MODE_KEY);
    return stored === "edit" || stored === "append" || stored === "auto" ? stored : "auto";
  } catch {
    return "auto";
  }
}

export function saveContinueMode(mode: ContinueAction) {
  try {
    window.sessionStorage.setItem(CONTINUE_MODE_KEY, mode);
  } catch (caughtError) {
    console.error("[editor] could not remember the continue mode", caughtError);
  }
}

export function loadLocalThread(projectId: string): ThreadEntry[] {
  try {
    const raw = window.localStorage.getItem(THREAD_KEY_PREFIX + projectId);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((entry): entry is ThreadEntry => Boolean(entry) && typeof (entry as ThreadEntry).text === "string" && typeof (entry as ThreadEntry).at === "string") : [];
  } catch (caughtError) {
    console.error("[thread] could not read the local thread", caughtError);
    return [];
  }
}

export function saveLocalThread(projectId: string, entries: ThreadEntry[]) {
  try {
    window.localStorage.setItem(THREAD_KEY_PREFIX + projectId, JSON.stringify(entries.slice(-200)));
  } catch (caughtError) {
    console.error("[thread] could not save the local thread", caughtError);
  }
}

