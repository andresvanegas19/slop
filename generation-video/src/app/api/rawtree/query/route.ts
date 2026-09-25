import { withRouteLog } from "@/lib/route-log";
import { NextRequest, NextResponse } from "next/server";
import { RawTreeConfigurationError, RawTreeRequestError, queryRawTreeForStoryboard } from "@/lib/rawtree";

export const runtime = "nodejs";

type QueryBody = {
  table?: unknown;
  columns?: unknown;
  limit?: unknown;
  sql?: unknown;
};

function parseBody(value: QueryBody) {
  if (value.sql !== undefined) throw new RawTreeRequestError("Direct SQL is not allowed.");
  const allowedKeys = new Set(["table", "columns", "limit"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new RawTreeRequestError("Unsupported query options.");
  }
  if (value.table !== undefined && typeof value.table !== "string") {
    throw new RawTreeRequestError("table must be a string.");
  }
  if (value.columns !== undefined && (!Array.isArray(value.columns) || value.columns.some((column) => typeof column !== "string"))) {
    throw new RawTreeRequestError("columns must be an array of strings.");
  }
  if (value.limit !== undefined && typeof value.limit !== "number") {
    throw new RawTreeRequestError("limit must be a number.");
  }
  return { table: value.table, columns: value.columns as string[] | undefined, limit: value.limit };
}

async function routePOST(request: NextRequest) {
  try {
    const body: unknown = await request.json();
    if (body === null || Array.isArray(body) || typeof body !== "object") {
      throw new RawTreeRequestError("A JSON object is required.");
    }
    return NextResponse.json(await queryRawTreeForStoryboard(parseBody(body as QueryBody)), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = error instanceof RawTreeRequestError ? 400 : 503;
    const code = error instanceof RawTreeConfigurationError ? "not_configured" : "unavailable";
    return NextResponse.json({ error: code }, { status });
  }
}

export const POST = withRouteLog(routePOST);
