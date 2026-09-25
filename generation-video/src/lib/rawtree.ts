import { loadEnvConfig } from "@next/env";
import { RawTree, type ColumnInfo, type QueryResponse, type TableInfo } from "@rawtree/sdk";
import path from "node:path";

const MAX_COLUMNS = 12;
const MAX_ROWS = 100;
const MAX_VALUE_LENGTH = 2_000;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type RawTreeColumn = Pick<ColumnInfo, "name" | "type">;
export type RawTreeTable = Pick<TableInfo, "name">;
export type StoryboardData = {
  table: string;
  columns: RawTreeColumn[];
  rows: Record<string, string | number | boolean | null>[];
  rowCount: number;
  truncated: boolean;
};

export class RawTreeConfigurationError extends Error {}
export class RawTreeRequestError extends Error {}

function loadServerEnvironment() {
  const development = process.env.NODE_ENV !== "production";
  loadEnvConfig(process.cwd(), development, undefined, true);
  loadEnvConfig(path.resolve(process.cwd(), ".."), development, undefined, true);
}

function configuredTable() {
  loadServerEnvironment();
  const table = process.env.RAWTREE_TABLE?.trim();
  if (table !== undefined && table !== "" && !isIdentifier(table)) {
    throw new RawTreeConfigurationError("RAWTREE_TABLE must be a simple table identifier.");
  }
  return table || undefined;
}

export function getClient() {
  loadServerEnvironment();
  const apiKey = process.env.RAWTREE_API_KEY?.trim();
  if (!apiKey) {
    throw new RawTreeConfigurationError("RAWTREE_API_KEY is not configured on the server.");
  }
  return new RawTree({ apiKey });
}

function isIdentifier(value: string): boolean {
  return identifierPattern.test(value);
}

function quoteIdentifier(value: string): string {
  if (!isIdentifier(value)) throw new RawTreeRequestError("An unsupported identifier was requested.");
  return `"${value}"`;
}

async function allowedTables(): Promise<RawTreeTable[]> {
  const configured = configuredTable();
  const { tables } = await getClient().tables.list();
  const allowed = tables.filter((table) => isIdentifier(table.name));

  if (!configured) return allowed.map(({ name }) => ({ name }));
  if (!allowed.some((table) => table.name === configured)) {
    throw new RawTreeConfigurationError("RAWTREE_TABLE is not available from RawTree.");
  }
  return [{ name: configured }];
}

async function selectedTable(requestedTable?: string) {
  const tables = await allowedTables();
  if (requestedTable !== undefined && !isIdentifier(requestedTable)) {
    throw new RawTreeRequestError("An unsupported table was requested.");
  }
  const selected = requestedTable
    ? tables.find((table) => table.name === requestedTable)
    : tables.length === 1
      ? tables[0]
      : undefined;
  if (!selected) {
    throw new RawTreeRequestError("Select one of the available tables.");
  }
  return selected.name;
}

export function isRawTreeConfigured() {
  loadServerEnvironment();
  return Boolean(process.env.RAWTREE_API_KEY?.trim());
}

export async function getRawTreeStatus() {
  if (!isRawTreeConfigured()) return { connected: false, error: "not_configured" as const };
  try {
    await getClient().tables.list();
    return { connected: true };
  } catch {
    return { connected: false, error: "unavailable" as const };
  }
}

export async function getRawTreeMetadata(requestedTable?: string) {
  const tables = await allowedTables();
  const table = requestedTable === undefined
    ? undefined
    : await selectedTable(requestedTable);
  const columns = table
    ? (await getClient().tables.describe({ table })).table.columns
      .filter((column) => isIdentifier(column.name))
      .map(({ name, type }) => ({ name, type }))
    : [];

  return {
    tables,
    selectedTable: table,
    columns,
    requiresTableSelection: tables.length > 1 && !table,
  };
}

function asBoundedValue(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.slice(0, MAX_VALUE_LENGTH);
  return null;
}

export async function queryRawTreeForStoryboard(input: {
  table?: string;
  columns?: string[];
  limit?: number;
}): Promise<StoryboardData> {
  const table = await selectedTable(input.table);
  const described = await getClient().tables.describe({ table });
  const allowedColumns = described.table.columns
    .filter((column) => isIdentifier(column.name))
    .map(({ name, type }) => ({ name, type }));
  const requestedColumns = input.columns ?? allowedColumns.map((column) => column.name).slice(0, MAX_COLUMNS);

  if (
    requestedColumns.length === 0 ||
    requestedColumns.length > MAX_COLUMNS ||
    new Set(requestedColumns).size !== requestedColumns.length ||
    requestedColumns.some((column) => !allowedColumns.some((allowed) => allowed.name === column))
  ) {
    throw new RawTreeRequestError("Requested columns are not allowed.");
  }

  const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS) {
    throw new RawTreeRequestError(`limit must be an integer between 1 and ${MAX_ROWS}.`);
  }

  const sql = `SELECT ${requestedColumns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table)} LIMIT ${limit}`;
  const result: QueryResponse<Record<string, unknown>> = await getClient().query({ sql });
  const rows = result.data.slice(0, limit).map((row) =>
    Object.fromEntries(requestedColumns.map((column) => [column, asBoundedValue(row[column])])),
  );

  return {
    table,
    columns: allowedColumns.filter((column) => requestedColumns.includes(column.name)),
    rows,
    rowCount: rows.length,
    truncated: result.rows > rows.length,
  };
}
