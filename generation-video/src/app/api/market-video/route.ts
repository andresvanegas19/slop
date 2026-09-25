import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { BflError, describeError } from "@/lib/bfl";
import { StoredStoryboardInvalidError, StoryboardNotFoundError, STORYBOARD_ID, loadStoredStoryboard, marketBrief, type StoredStoryboard } from "@/lib/market";
import { createProject, framesFromStoryboard, videoUrl } from "@/lib/projects";
import { RawTreeConfigurationError } from "@/lib/rawtree";
import { ResearchAgentError, jsonBody } from "@/lib/research-agent";
import { logException, logInfo } from "@/lib/runtime-log";
import { renderStoryboard, totalDurationMs } from "@/lib/storyboard-renderer";
import { schedulePublish } from "@/lib/video-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function responseError(error: string, status: number, details?: unknown) {
  return NextResponse.json({ error, ...(details === undefined ? {} : { details }) }, { status });
}

function failure(error: unknown, stage: "load" | "render", storyboardId: string) {
  if (error instanceof StoryboardNotFoundError) {
    logInfo("market_video_not_found", { storyboardId });
    return responseError(error.message, 404);
  }
  if (error instanceof StoredStoryboardInvalidError) {
    logInfo("market_video_invalid", { storyboardId, issues: error.details?.length ?? 0 });
    return responseError(error.message, 422, error.details);
  }
  if (error instanceof RawTreeConfigurationError) {
    logException("market_video_misconfigured", error, { stage, storyboardId });
    return responseError(error.message, 500);
  }
  if (error instanceof ResearchAgentError) {
    logInfo("market_video_agent_error", { stage, storyboardId, status: error.status, message: error.message });
    return responseError(error.message, error.status >= 500 ? error.status : 502);
  }
  const status = error instanceof BflError && error.status && error.status >= 400 && error.status < 500 ? error.status : 502;
  const message = describeError(error, stage === "render" ? "Unable to render the market update." : "Unable to load the stored storyboard.");
  logException("market_video_failed", error, { stage, storyboardId, status, message });
  return responseError(message, status);
}

function summary(stored: StoredStoryboard) {
  return {
    storyboardId: stored.record.storyboard_id,
    storyboardSource: stored.source,
    companyName: stored.record.company_name,
    watchId: stored.record.watch_id,
    createdAt: stored.record.created_at,
    evidence: stored.evidence,
  };
}

/**
 * POST `{ storyboard_id: string, dryRun?: boolean, includeTest?: boolean }`.
 * Loads the storyboard the agent stored (RawTree `slop_human_video_storyboards`, falling back to the agent's copy)
 * and renders it with the cinematic renderer.
 *   dryRun → `{ dryRun: true, storyboard, storyboardId, storyboardSource, companyName, watchId, createdAt, evidence,
 *              durationSeconds, sceneCount }` (nothing is rendered)
 *   render → `{ videoUrl, durationSeconds, sceneCount, narrationAvailable, storyboardId, storyboardSource, evidence,
 *              companyName, project }`
 * Errors: 400 bad body/id, 404 not found, 422 stored storyboard invalid, 5xx render/agent failures.
 */
export async function POST(request: Request) {
  const body = await jsonBody(request);
  if (body instanceof NextResponse) return body;
  const storyboardId = body.storyboard_id;
  if (typeof storyboardId !== "string" || !STORYBOARD_ID.test(storyboardId)) {
    return responseError('"storyboard_id" is required (letters, digits, "_" or "-", at most 64 characters).', 400);
  }
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") return responseError('"dryRun" must be a boolean.', 400);
  if (body.includeTest !== undefined && typeof body.includeTest !== "boolean") return responseError('"includeTest" must be a boolean.', 400);

  let stored: StoredStoryboard;
  try {
    stored = await loadStoredStoryboard(storyboardId, { includeTest: body.includeTest === true, request });
  } catch (error) {
    return failure(error, "load", storyboardId);
  }
  const storyboard = stored.storyboard;
  const durationSeconds = totalDurationMs(storyboard) / 1000;
  if (body.dryRun === true) {
    return NextResponse.json({ dryRun: true, storyboard, durationSeconds, sceneCount: storyboard.scenes.length, ...summary(stored) });
  }

  const runId = randomUUID();
  try {
    logInfo("market_video_render_started", { runId, storyboardId, source: stored.source, scenes: storyboard.scenes.length });
    const rendered = await renderStoryboard(storyboard, runId, {
      mode: "cinematic",
      brief: marketBrief(stored),
      companyContext: stored.record.company_name ? `The viewer's company: ${stored.record.company_name}. The video summarizes what its competitors did recently.` : undefined,
      captions: "final",
    });
    const manifests = path.join(process.cwd(), "output", "manifests");
    await mkdir(manifests, { recursive: true });
    await writeFile(path.join(manifests, `${runId}.manifest.json`), JSON.stringify({
      runId,
      source: "market-video",
      storyboardId,
      storyboardSource: stored.source,
      watchId: stored.record.watch_id,
      sceneCount: storyboard.scenes.length,
      durationSeconds: rendered.durationSeconds,
      narrationAvailable: rendered.narrationAvailable,
      imageFilenames: rendered.imageFilenames,
      videoFilename: rendered.videoFilename,
    }), { mode: 0o600 });
    const project = await createProject({
      kind: "storyboard",
      title: storyboard.headline,
      videoUrl: videoUrl(rendered.videoFilename),
      durationSeconds: rendered.durationSeconds,
      frames: framesFromStoryboard(storyboard, rendered.imageFilenames),
      storyboard,
    });
    schedulePublish(project, "storyboard");
    logInfo("market_video_render_completed", { runId, storyboardId, projectId: project.id, video: rendered.videoFilename });
    return NextResponse.json({
      videoUrl: `/api/videos/${rendered.videoFilename}`,
      durationSeconds: rendered.durationSeconds,
      sceneCount: storyboard.scenes.length,
      narrationAvailable: rendered.narrationAvailable,
      ...summary(stored),
      project,
    });
  } catch (error) {
    return failure(error, "render", storyboardId);
  }
}
