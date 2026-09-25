import { withRouteLog } from "@/lib/route-log";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

async function routeGET(_request: Request, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;
  if (!/^[a-zA-Z0-9_-]+\.png$/.test(filename)) return new NextResponse(null, { status: 400 });
  try {
    const asset = await readFile(path.join(process.cwd(), "output", "frames", filename));
    return new NextResponse(asset, { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" } });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}

export const GET = withRouteLog(routeGET);
