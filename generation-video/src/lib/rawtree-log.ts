/*
 * Wraps a RawTree client so every query / insert / tables.* call logs `rawtree_query` / `rawtree_insert` /
 * `rawtree_tables` (debug, warn when slow or failed) with table, rows and latency. SQL is logged truncated to 200
 * chars; inserted values are never logged (only the row count).
 */
import type { RawTree } from "@rawtree/sdk";
import { log, startTimer } from "@/lib/runtime-log";

const SLOW_MS = 3_000;
const wrapped = new WeakSet<object>();

function tableFromSql(sql: unknown) {
  if (typeof sql !== "string") return undefined;
  return /\b(?:from|into)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(sql)?.[1];
}

function rowsOf(result: unknown) {
  if (!result || typeof result !== "object") return undefined;
  const value = result as { rows?: unknown; data?: unknown; inserted?: unknown; count?: unknown };
  if (Array.isArray(value.data)) return value.data.length;
  for (const candidate of [value.rows, value.inserted, value.count]) if (typeof candidate === "number") return candidate;
  return undefined;
}

async function timed<T>(event: string, fields: Record<string, unknown>, run: () => Promise<T>, resultFields: (result: T) => Record<string, unknown>) {
  const elapsed = startTimer();
  try {
    const result = await run();
    const durationMs = elapsed();
    log(durationMs > SLOW_MS ? "info" : "debug", event, { ...fields, ...resultFields(result), durationMs });
    return result;
  } catch (error) {
    log("warn", `${event}_failed`, { ...fields, error: error instanceof Error ? error.message : String(error), durationMs: elapsed() });
    throw error;
  }
}

export function instrumentRawTree(client: RawTree): RawTree {
  if (wrapped.has(client)) return client;
  wrapped.add(client);
  const target = client as unknown as {
    query: (input: { sql: string }) => Promise<unknown>;
    insert: (input: { table: string; values: unknown }) => Promise<unknown>;
    tables?: Record<string, unknown>;
  };
  const query = target.query.bind(client);
  const insert = target.insert.bind(client);
  target.query = (input) => timed("rawtree_query", { table: tableFromSql(input?.sql), sql: input?.sql }, () => query(input), (result) => ({ rows: rowsOf(result) }));
  target.insert = (input) => timed("rawtree_insert", { table: input?.table, rows: Array.isArray(input?.values) ? input.values.length : 1 }, () => insert(input), () => ({}));
  const tables = target.tables;
  if (tables && typeof tables === "object") {
    for (const name of ["list", "describe"]) {
      const original = tables[name];
      if (typeof original !== "function") continue;
      const bound = (original as (...args: unknown[]) => Promise<unknown>).bind(tables);
      tables[name] = (...args: unknown[]) => timed("rawtree_tables", { op: name, table: (args[0] as { table?: string } | undefined)?.table }, () => bound(...args), () => ({}));
    }
  }
  return client;
}
