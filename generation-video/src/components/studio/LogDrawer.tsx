"use client";

/*
 * Live server log drawer (docs/LOGGING.md). Toggle with Ctrl+` or the "Logs" button; `openLogs({ traceId })` opens it
 * filtered to one flow. Tails GET /api/logs/stream (web + Python agent NDJSON files).
 *
 * Trace ids: every /api response carries `X-Trace-Id`. A small fetch tap remembers the trace of each generating request
 * (and the job id of `202 { jobId }` answers) so a chat result can link to "its" log (`ViewLogLink`) without the
 * studio code having to thread ids around. The last 200 flows are kept in localStorage.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "./ui";

type Level = "debug" | "info" | "warn" | "error";
type LogRow = { ts: string; level: Level; event: string; source?: "web" | "agent"; traceId?: string; jobId?: string; projectId?: string; route?: string; durationMs?: number; [key: string]: unknown };
export type LogFilter = { traceId?: string; jobId?: string; projectId?: string };
type Flow = { traceId: string; method: string; path: string; startedAt: number; status?: number; jobId?: string; projectId?: string };

const OPEN_EVENT = "longform:open-logs";
const FLOWS_KEY = "longform.logFlows";
const MAX_FLOWS = 200;
const MAX_ROWS = 3_000;
/** Requests that start a user-visible flow (generation, edit, question…), as opposed to polling / uploads. */
const FLOW_ROUTE = /^\/api\/(projects\/[^/]+\/(command|append|cut|frames|publish)|projects\/from-upload|generate|generate-video|generate-preset|generate-multishot|render-storyboard|slop-video|stories|research(?!\/detect)|jobs\/[^/]+\/resume)/;
const LEVEL_STYLE: Record<Level, string> = {
  debug: "text-[#6f6f6f]",
  info: "text-[#7cc4d8]",
  warn: "text-[#e2b44f]",
  error: "text-[#ff7b72]",
};
const HIDDEN_FIELDS = new Set(["ts", "level", "event", "source", "traceId", "jobId", "projectId", "userId", "route", "durationMs", "stack", "logger"]);

/* ---------------------------------------------------------------------------------------------------------------- */
/* Flow registry (trace ids of this browser's requests)                                                              */

let flows: Flow[] | null = null;
let version = 0;
const listeners = new Set<() => void>();

function loadFlows(): Flow[] {
  if (flows) return flows;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(FLOWS_KEY) ?? "[]") as unknown;
    flows = Array.isArray(parsed) ? parsed.filter((flow): flow is Flow => typeof flow?.traceId === "string" && typeof flow?.startedAt === "number") : [];
  } catch {
    flows = [];
  }
  return flows;
}

function changed() {
  version += 1;
  try {
    window.localStorage.setItem(FLOWS_KEY, JSON.stringify(loadFlows().slice(-MAX_FLOWS)));
  } catch {
    // Storage full / blocked: keep in memory.
  }
  for (const listener of listeners) listener();
}

function recordFlow(flow: Flow) {
  const list = loadFlows();
  list.push(flow);
  if (list.length > MAX_FLOWS) list.splice(0, list.length - MAX_FLOWS);
  changed();
}

/** The flow that produced something shown at `at` (ISO or ms): the latest generating request started before it. */
export function flowAt(at?: string | number): Flow | undefined {
  if (typeof window === "undefined") return undefined;
  const limit = at === undefined ? Infinity : (typeof at === "number" ? at : Date.parse(at)) + 2_000;
  let best: Flow | undefined;
  for (const flow of loadFlows()) {
    if (!FLOW_ROUTE.test(flow.path) || flow.startedAt > limit) continue;
    if (!best || flow.startedAt > best.startedAt) best = flow;
  }
  return best;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useFlowsVersion() {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}

function installFetchTap() {
  const tagged = window as unknown as { __longformFetchTap?: boolean };
  if (tagged.__longformFetchTap) return;
  tagged.__longformFetchTap = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const startedAt = Date.now();
    const response = await original(input, init);
    try {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, window.location.href);
      const traceId = response.headers.get("x-trace-id");
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (traceId && url.origin === window.location.origin && url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/logs") && method !== "GET") {
        const flow: Flow = { traceId, method, path: url.pathname, startedAt, status: response.status, projectId: /^\/api\/projects\/([^/]+)\//.exec(url.pathname)?.[1] };
        recordFlow(flow);
        if (response.status === 202) {
          void response.clone().json().then((body: { jobId?: unknown }) => {
            if (typeof body?.jobId === "string") {
              flow.jobId = body.jobId;
              changed();
            }
          }).catch(() => undefined);
        }
      }
    } catch {
      // Never interfere with the request.
    }
    return response;
  };
}

export function openLogs(filter: LogFilter = {}) {
  window.dispatchEvent(new CustomEvent<LogFilter>(OPEN_EVENT, { detail: filter }));
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Small entry points                                                                                                */

/** "View log" for a result shown at `at` (defaults to the latest flow). Hidden when no trace is known. */
export function ViewLogLink({ at, traceId, jobId, className }: { at?: string | number; traceId?: string; jobId?: string; className?: string }) {
  useFlowsVersion();
  // localStorage-backed: render only on the client.
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  if (!mounted) return null;
  const flow = traceId || jobId ? undefined : flowAt(at);
  const filter: LogFilter | null = traceId ? { traceId } : jobId ? { jobId } : flow ? { traceId: flow.traceId } : null;
  if (!filter) return null;
  return (
    <button type="button" className={cn("border-0 bg-transparent p-0 text-[10px] text-[#7c7c7c] underline decoration-dotted underline-offset-2 hover:text-white", className)} onClick={() => openLogs(filter)} title={`Server log for this request (trace ${filter.traceId ?? filter.jobId})`}>
      View log
    </button>
  );
}

/** Footer button for the side panel. */
export function LogsButton({ className }: { className?: string }) {
  return (
    <button type="button" className={cn("rounded-[5px] border border-[#2a2a2a] bg-transparent px-2 py-0.5 font-mono text-[10px] text-[#8a8a8a] hover:border-[#444] hover:text-white", className)} onClick={() => openLogs()} title="Server logs (Ctrl+`)">
      Logs
    </button>
  );
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Drawer                                                                                                            */

function clock(ts: string) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function duration(ms: unknown) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1_000)}s`;
}

function fieldText(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

type Scope = "all" | "project" | "flow";

export default function LogDrawer() {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<LogFilter>({});
  const [scope, setScope] = useState<Scope>("all");
  const [level, setLevel] = useState<Level>("info");
  const [search, setSearch] = useState("");
  const [paused, setPaused] = useState(false);
  // Rows belong to one stream (query); a new query starts from an empty list.
  const [stored, setStored] = useState<{ key: string; rows: LogRow[] }>({ key: "", rows: [] });
  const [connected, setConnected] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const pending = useRef<LogRow[]>([]);
  const pausedRef = useRef(paused);
  const flowsVersion = useFlowsVersion();

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    installFetchTap();
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && (event.code === "Backquote" || event.key === "`")) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<LogFilter>).detail ?? {};
      setOpen(true);
      if (detail.traceId || detail.jobId || detail.projectId) {
        setFilter(detail);
        setScope("all");
        setLevel("debug");
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  // The effective server-side filter: an explicit trace/job/project, else the scope toggle.
  const effective = useMemo<LogFilter>(() => {
    void flowsVersion;
    if (filter.traceId || filter.jobId || filter.projectId) return filter;
    if (scope === "flow") {
      const flow = flowAt();
      return flow ? (flow.jobId ? { jobId: flow.jobId } : { traceId: flow.traceId }) : {};
    }
    if (scope === "project") {
      const flow = [...loadFlows()].reverse().find((item) => item.projectId);
      return flow?.projectId ? { projectId: flow.projectId } : {};
    }
    return {};
  }, [filter, scope, flowsVersion]);

  const query = useMemo(() => {
    const params = new URLSearchParams({ level, backfill: effective.traceId || effective.jobId || effective.projectId ? "1000" : "300" });
    for (const [key, value] of Object.entries(effective)) if (value) params.set(key, value);
    return params.toString();
  }, [effective, level]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let frame = 0;
    const flush = () => {
      frame = 0;
      if (pausedRef.current || pending.current.length === 0) return;
      const batch = pending.current;
      pending.current = [];
      setStored((current) => {
        const next = (current.key === query ? current.rows : []).concat(batch);
        return { key: query, rows: next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next };
      });
    };
    pending.current = [];
    stick.current = true;
    (async () => {
      let retry = 0;
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(`/api/logs/stream?${query}`, { signal: controller.signal, cache: "no-store" });
          if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
          setConnected(true);
          retry = 0;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let newline = buffer.indexOf("\n");
            while (newline >= 0) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              newline = buffer.indexOf("\n");
              if (!line) continue;
              try {
                const row = JSON.parse(line) as LogRow & { type?: string };
                if (row.type === "ping" || typeof row.event !== "string") continue;
                pending.current.push(row);
              } catch {
                // skip malformed
              }
            }
            if (!frame) frame = requestAnimationFrame(flush);
          }
        } catch {
          if (controller.signal.aborted) return;
        }
        setConnected(false);
        // Reconnect (server restart / HMR); new lines only.
        await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, 800 * 2 ** retry++)));
      }
    })();
    return () => {
      controller.abort();
      if (frame) cancelAnimationFrame(frame);
      setConnected(false);
    };
  }, [open, query]);

  const rows = useMemo(() => (stored.key === query ? stored.rows : []), [stored, query]);

  useEffect(() => {
    if (paused) return;
    const list = listRef.current;
    if (list && stick.current) list.scrollTop = list.scrollHeight;
  }, [rows, paused]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => JSON.stringify(row).toLowerCase().includes(needle));
  }, [rows, search]);

  const focusTrace = useCallback((traceId: string) => {
    setFilter({ traceId });
    setLevel("debug");
  }, []);

  if (!open) return null;
  const filterLabel = effective.traceId ? `trace ${effective.traceId}` : effective.jobId ? `job ${effective.jobId.slice(0, 8)}` : effective.projectId ? `project ${effective.projectId.slice(0, 8)}` : null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex h-[42vh] min-h-[220px] flex-col border-t border-[#2a2a2a] bg-[#0a0a0a]/[.97] font-mono text-[11px] text-[#cfcfcf] shadow-[0_-18px_50px_#000c] backdrop-blur" role="region" aria-label="Server logs">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#1f1f1f] px-3 py-1.5">
        <strong className="text-[12px] text-white">Logs</strong>
        <span className={cn("h-1.5 w-1.5 rounded-full", connected ? "bg-[#3fb950]" : "bg-[#6e4040]")} title={connected ? "Live" : "Reconnecting…"} />
        <select className="rounded border border-[#2a2a2a] bg-[#111] px-1 py-0.5 text-[11px]" value={level} onChange={(event) => setLevel(event.target.value as Level)} aria-label="Minimum level">
          <option value="debug">debug+</option>
          <option value="info">info+</option>
          <option value="warn">warn+</option>
          <option value="error">error</option>
        </select>
        <div className="flex overflow-hidden rounded border border-[#2a2a2a]" role="group" aria-label="Scope">
          {(["all", "flow", "project"] as const).map((value) => (
            <button key={value} type="button" className={cn("border-0 px-2 py-0.5 text-[11px]", scope === value && !filterLabel ? "bg-[#2a2a2a] text-white" : "bg-transparent text-[#8a8a8a] hover:text-white")} onClick={() => { setFilter({}); setScope(value); }}>
              {value === "all" ? "All" : value === "flow" ? "Current job" : "Current project"}
            </button>
          ))}
        </div>
        {filterLabel && (
          <span className="flex items-center gap-1 rounded border border-[#3b2f5c] bg-[#1d1733] px-1.5 py-0.5 text-[#c9b8ff]">
            {filterLabel}
            {(filter.traceId || filter.jobId || filter.projectId) && <button type="button" className="border-0 bg-transparent p-0 text-[#c9b8ff] hover:text-white" onClick={() => setFilter({})} aria-label="Clear filter">✕</button>}
          </span>
        )}
        <input className="min-w-[120px] flex-1 rounded border border-[#2a2a2a] bg-[#111] px-1.5 py-0.5 text-[11px] text-white placeholder:text-[#555]" placeholder="search…" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search logs" />
        <span className="text-[#555]">{visible.length}</span>
        <button type="button" className="rounded border border-[#2a2a2a] bg-transparent px-1.5 py-0.5 text-[11px] text-[#8a8a8a] hover:text-white" onClick={() => setPaused((value) => !value)}>{paused ? "Resume" : "Pause"}</button>
        <button type="button" className="rounded border border-[#2a2a2a] bg-transparent px-1.5 py-0.5 text-[11px] text-[#8a8a8a] hover:text-white" onClick={() => setStored({ key: query, rows: [] })}>Clear</button>
        <button type="button" className="border-0 bg-transparent px-1 text-[13px] text-[#8a8a8a] hover:text-white" onClick={() => setOpen(false)} aria-label="Close logs" title="Close (Ctrl+`)">✕</button>
      </div>
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-auto px-1 py-1"
        onScroll={(event) => {
          const target = event.currentTarget;
          stick.current = target.scrollHeight - target.scrollTop - target.clientHeight < 24;
        }}
      >
        {visible.length === 0 && <p className="px-2 py-3 text-[#555]">{connected ? "Waiting for log lines…" : "Connecting to /api/logs/stream…"}</p>}
        {visible.map((row, index) => {
          const fields = Object.entries(row).filter(([key, value]) => !HIDDEN_FIELDS.has(key) && value !== undefined && value !== null && value !== "");
          return (
            <div key={`${row.ts}-${index}`} className={cn("group rounded px-1.5 py-[1px] hover:bg-[#161616]", expanded === index && "bg-[#141414]")}>
              <div className="flex cursor-pointer items-baseline gap-2 whitespace-nowrap" onClick={() => setExpanded(expanded === index ? null : index)}>
                <span className="flex-none text-[#5d5d5d]">{clock(row.ts)}</span>
                <span className={cn("w-[38px] flex-none uppercase", LEVEL_STYLE[row.level] ?? "")}>{row.level}</span>
                {row.traceId ? (
                  <button type="button" className="flex-none border-0 bg-transparent p-0 text-[#a78bfa] hover:underline" onClick={(event) => { event.stopPropagation(); focusTrace(row.traceId!); }} title={`Show only trace ${row.traceId}`}>
                    {row.traceId.slice(0, 8)}
                  </button>
                ) : <span className="w-[56px] flex-none text-[#333]">—</span>}
                {row.source === "agent" && <span className="flex-none rounded bg-[#1d2a1d] px-1 text-[9px] text-[#8fd18f]">agent</span>}
                <span className="flex-none font-semibold text-[#e8e8e8]">{row.event}</span>
                <span className="min-w-0 flex-1 truncate text-[#8d8d8d]">
                  {fields.slice(0, 10).map(([key, value]) => (
                    <span key={key} className="mr-2"><span className="text-[#5a5a5a]">{key}=</span>{fieldText(value)}</span>
                  ))}
                </span>
                <span className="flex-none text-[#3fb950] tabular-nums">{duration(row.durationMs)}</span>
              </div>
              {expanded === index && (
                <pre className="mt-1 mb-1.5 max-h-[220px] overflow-auto whitespace-pre-wrap rounded border border-[#222] bg-[#0f0f0f] p-2 text-[10.5px] text-[#bdbdbd] [overflow-wrap:anywhere]">{JSON.stringify(row, null, 2)}</pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
