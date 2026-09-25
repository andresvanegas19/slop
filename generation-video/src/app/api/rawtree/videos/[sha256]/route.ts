import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { RawTreeConfigurationError } from "@/lib/rawtree";
import { logException } from "@/lib/runtime-log";
import { cachedVideoPath, isSha256, VideoStoreError } from "@/lib/video-store";

export const runtime = "nodejs";
export const maxDuration = 300;

const baseHeaders = {
  "Content-Type": "video/mp4",
  "Accept-Ranges": "bytes",
  // Content-addressed: the bytes for a hash never change.
  "Cache-Control": "private, max-age=31536000, immutable",
};

/** GET → the MP4 reassembled from slop_human_video_chunks (cached in output/rawtree-cache), with Range support. */
export async function GET(request: Request, { params }: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await params;
  if (!isSha256(sha256)) return NextResponse.json({ error: "sha256 must be 64 lowercase hex characters." }, { status: 400 });
  let asset: Buffer;
  try {
    asset = await readFile(await cachedVideoPath(sha256));
  } catch (error) {
    const status = error instanceof VideoStoreError ? error.status : error instanceof RawTreeConfigurationError ? 503 : 502;
    logException("rawtree_video_fetch_failed", error, { sha256, status });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to fetch the video." }, { status });
  }

  const size = asset.byteLength;
  const range = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (!range) {
    return new NextResponse(new Uint8Array(asset), { headers: { ...baseHeaders, "Content-Length": String(size) } });
  }
  let start = range[1] === "" ? size - Number(range[2]) : Number(range[1]);
  let end = range[1] === "" || range[2] === "" ? size - 1 : Number(range[2]);
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return new NextResponse(null, { status: 416, headers: { ...baseHeaders, "Content-Range": `bytes */${size}` } });
  }
  return new NextResponse(new Uint8Array(asset.subarray(start, end + 1)), {
    status: 206,
    headers: { ...baseHeaders, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}` },
  });
}
