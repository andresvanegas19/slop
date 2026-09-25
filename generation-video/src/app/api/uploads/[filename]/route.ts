import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { UPLOAD_CONTENT_TYPES, UPLOAD_FILENAME, uploadsDirectory } from "@/lib/uploads";

export const runtime = "nodejs";

// Same byte-range handling as /api/videos (Safari only plays <video> with 206 Partial Content).
export async function GET(request: Request, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;
  if (!UPLOAD_FILENAME.test(filename)) return new NextResponse(null, { status: 400 });
  const headers = {
    "Content-Type": UPLOAD_CONTENT_TYPES[filename.split(".").pop() as string] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  };
  let asset: Buffer;
  try {
    asset = await readFile(path.join(uploadsDirectory(), filename));
  } catch {
    return new NextResponse(null, { status: 404 });
  }

  const size = asset.byteLength;
  const range = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (!range) {
    return new NextResponse(new Uint8Array(asset), { headers: { ...headers, "Content-Length": String(size) } });
  }
  let start = range[1] === "" ? size - Number(range[2]) : Number(range[1]);
  let end = range[1] === "" || range[2] === "" ? size - 1 : Number(range[2]);
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return new NextResponse(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
  }
  return new NextResponse(new Uint8Array(asset.subarray(start, end + 1)), {
    status: 206,
    headers: { ...headers, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}` },
  });
}
