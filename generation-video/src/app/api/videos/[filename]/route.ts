import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;
  if (!/^[a-zA-Z0-9-]+\.mp4$/.test(filename)) return new NextResponse(null, { status: 400 });
  try {
    const asset = await readFile(path.join(process.cwd(), "output", "videos", filename));
    return new NextResponse(asset, { headers: { "Content-Type": "video/mp4", "Cache-Control": "private, max-age=3600" } });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
