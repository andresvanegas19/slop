import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const baseHeaders = {
  "Content-Type": "video/mp4",
  "Accept-Ranges": "bytes",
  "Cache-Control": "private, max-age=3600",
};

// Safari only plays <video> when the server answers byte-range requests with 206 Partial Content.
export async function GET(request: Request, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;
  if (!/^[a-zA-Z0-9-]+\.mp4$/.test(filename)) return new NextResponse(null, { status: 400 });
  let asset: Buffer;
  try {
    asset = await readFile(path.join(process.cwd(), "output", "videos", filename));
  } catch {
    return new NextResponse(null, { status: 404 });
  }

  const size = asset.byteLength;
  const range = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (!range) {
    return new NextResponse(new Uint8Array(asset), { headers: { ...baseHeaders, "Content-Length": String(size) } });
  }

  // "bytes=start-end", "bytes=start-" or the suffix form "bytes=-length".
  let start = range[1] === "" ? size - Number(range[2]) : Number(range[1]);
  let end = range[1] === "" || range[2] === "" ? size - 1 : Number(range[2]);
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return new NextResponse(null, { status: 416, headers: { ...baseHeaders, "Content-Range": `bytes */${size}` } });
  }

  return new NextResponse(new Uint8Array(asset.subarray(start, end + 1)), {
    status: 206,
    headers: {
      ...baseHeaders,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${size}`,
    },
  });
}
