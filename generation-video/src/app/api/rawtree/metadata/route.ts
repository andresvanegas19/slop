import { withRouteLog } from "@/lib/route-log";
import { NextRequest, NextResponse } from "next/server";
import { RawTreeConfigurationError, RawTreeRequestError, getRawTreeMetadata } from "@/lib/rawtree";

export const runtime = "nodejs";

async function routeGET(request: NextRequest) {
  const table = request.nextUrl.searchParams.get("table") ?? undefined;
  try {
    return NextResponse.json(await getRawTreeMetadata(table), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = error instanceof RawTreeRequestError ? 400 : 503;
    const code = error instanceof RawTreeConfigurationError ? "not_configured" : "unavailable";
    return NextResponse.json({ error: code }, { status });
  }
}

export const GET = withRouteLog(routeGET);
