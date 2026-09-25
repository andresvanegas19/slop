/* History store: in-memory copy mirrored to localStorage (all access guarded), read with useSyncExternalStore. */
import { useSyncExternalStore } from "react";
import type { HistoryItem } from "../types";
import { EMPTY_HISTORY, HISTORY_KEY, HISTORY_LIMIT, isHistoryItem } from "../utils";

let historyCache: HistoryItem[] | null = null;
const historyListeners = new Set<() => void>();

function loadHistory(): HistoryItem[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter(isHistoryItem) : [];
  } catch (caughtError) {
    console.error("[history] could not read history", caughtError);
    return [];
  }
}

function getHistorySnapshot() {
  if (historyCache === null) historyCache = loadHistory();
  return historyCache;
}

function getHistoryServerSnapshot() {
  return EMPTY_HISTORY;
}

function subscribeHistory(listener: () => void) {
  historyListeners.add(listener);
  function onStorage(event: StorageEvent) {
    if (event.key !== HISTORY_KEY) return;
    historyCache = loadHistory();
    listener();
  }
  window.addEventListener("storage", onStorage);
  return () => {
    historyListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function updateHistory(update: (items: HistoryItem[]) => HistoryItem[]) {
  historyCache = update(getHistorySnapshot()).slice(0, HISTORY_LIMIT);
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(historyCache));
  } catch (caughtError) {
    console.error("[history] could not save history", caughtError);
  }
  historyListeners.forEach((listener) => listener());
}

/* History list open/closed preference (localStorage, guarded). */
const HISTORY_OPEN_KEY = "longform.historyOpen.v1";
let historyOpenCache: boolean | null = null;
const historyOpenListeners = new Set<() => void>();

function getHistoryOpenSnapshot() {
  if (historyOpenCache === null) {
    try {
      historyOpenCache = window.localStorage.getItem(HISTORY_OPEN_KEY) === "1";
    } catch (caughtError) {
      console.error("[history] could not read the history toggle state", caughtError);
      historyOpenCache = false;
    }
  }
  return historyOpenCache;
}

function getHistoryOpenServerSnapshot() {
  return false;
}

function subscribeHistoryOpen(listener: () => void) {
  historyOpenListeners.add(listener);
  return () => {
    historyOpenListeners.delete(listener);
  };
}

export function setHistoryOpen(open: boolean) {
  historyOpenCache = open;
  try {
    window.localStorage.setItem(HISTORY_OPEN_KEY, open ? "1" : "0");
  } catch (caughtError) {
    console.error("[history] could not save the history toggle state", caughtError);
  }
  historyOpenListeners.forEach((listener) => listener());
}

/** The current history outside React (e.g. right after mount, before useHistory has hydrated). */
export function readHistory() {
  return getHistorySnapshot();
}

export function useHistory() {
  return useSyncExternalStore(subscribeHistory, getHistorySnapshot, getHistoryServerSnapshot);
}

export function useHistoryOpen() {
  return useSyncExternalStore(subscribeHistoryOpen, getHistoryOpenSnapshot, getHistoryOpenServerSnapshot);
}
