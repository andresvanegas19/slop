import { NextResponse } from "next/server";
import { getRawTreeStatus } from "@/lib/rawtree";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await getRawTreeStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}
