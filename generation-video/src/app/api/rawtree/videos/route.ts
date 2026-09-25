import { withRouteLog } from "@/lib/route-log";
import { NextResponse } from "next/server";
import { RawTreeConfigurationError } from "@/lib/rawtree";
import { logException } from "@/lib/runtime-log";
import { listPublishedVideos, VideoStoreError } from "@/lib/video-store";

export const runtime = "nodejs";

/** GET `?limit=&projectId=` → `{ videos }`: published video metadata rows from RawTree (no bytes), newest first. */
async function routeGET(request: Request) {
  const params = new URL(request.url).searchParams;
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return NextResponse.json({ error: "\"limit\" must be an integer between 1 and 200." }, { status: 400 });
  }
  try {
    const videos = await listPublishedVideos({ limit, projectId: params.get("projectId") ?? undefined });
    return NextResponse.json({ videos }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof VideoStoreError ? error.status : error instanceof RawTreeConfigurationError ? 503 : 502;
    logException("rawtree_videos_list_failed", error, { status });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to list RawTree videos." }, { status });
  }
}

export const GET = withRouteLog(routeGET);
