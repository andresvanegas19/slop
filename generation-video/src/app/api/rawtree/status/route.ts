import { withRouteLog } from "@/lib/route-log";
import { NextResponse } from "next/server";
import { getRawTreeStatus } from "@/lib/rawtree";

export const runtime = "nodejs";

async function routeGET() {
  return NextResponse.json(await getRawTreeStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export const GET = withRouteLog(routeGET);
