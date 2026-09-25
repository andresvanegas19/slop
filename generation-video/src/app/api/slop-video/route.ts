import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { BflError, describeError } from "@/lib/bfl";
import { RawTreeConfigurationError } from "@/lib/rawtree";
import { getCompanyContext } from "@/lib/company-agent";
import { createProject, framesFromStoryboard, videoUrl } from "@/lib/projects";
import { schedulePublish } from "@/lib/video-store";
import { logException, logInfo } from "@/lib/runtime-log";
import {
  SHORT_DURATION_SEC,
  SlopConfigurationError,
  SlopNoDataError,
  buildSlopStoryboardFromRawTree,
  type SlopStoryboard,
} from "@/lib/slop-storyboard";
import { renderStoryboard, totalDurationMs } from "@/lib/storyboard-renderer";
import { validateStoryboard } from "@/lib/storyboard";
import { jobable } from "@/lib/job-route";

export const runtime = "nodejs";

type SlopRequest = { dryRun: boolean; includeTestRows: boolean };

function responseError(error: string, status: number, details?: unknown) {
  return NextResponse.json({ error, ...(details === undefined ? {} : { details }) }, { status });
}

async function saveStoryboard(storyboard: SlopStoryboard, runId: string) {
  const directory = path.join(process.cwd(), "storyboards", "generated");
  await mkdir(directory, { recursive: true });
  const filename = `${storyboard.storyboard_id}-${runId}.json`;
  await writeFile(path.join(directory, filename), `${JSON.stringify(storyboard, null, 2)}\n`, { mode: 0o600 });
  return path.join("storyboards", "generated", filename);
}

function failure(error: unknown, stage: string) {
  if (error instanceof SlopNoDataError) {
    logInfo("slop_video_no_data", { ignoredTestRows: error.ignoredTestRows });
    return responseError(error.message, 404, { ignoredTestRows: error.ignoredTestRows });
  }
  if (error instanceof SlopConfigurationError || error instanceof RawTreeConfigurationError) {
    logException("slop_video_misconfigured", error, { stage });
    return responseError(error.message, 500);
  }
  const status = error instanceof BflError && error.status && error.status >= 400 && error.status < 500 ? error.status : 502;
  const message = describeError(error, stage === "render" ? "Unable to render slop video." : "Unable to build storyboard from RawTree.");
  logException("slop_video_failed", error, { stage, status, message });
  return responseError(message, status);
}

async function handle({ dryRun, includeTestRows }: SlopRequest) {
  const runId = randomUUID();
  let storyboard: SlopStoryboard;
  try {
    storyboard = await buildSlopStoryboardFromRawTree({ includeTestRows });
  } catch (error) {
    return failure(error, "build");
  }

  const validation = validateStoryboard(storyboard);
  if (!validation.success) return responseError("Generated storyboard is invalid.", 500, validation.errors);
  if (totalDurationMs(validation.data) !== SHORT_DURATION_SEC * 1000) {
    return responseError(`Generated storyboard is not exactly ${SHORT_DURATION_SEC} seconds.`, 500);
  }

  // Dry runs don't write files, so polling the endpoint doesn't litter storyboards/generated/.
  if (dryRun) return NextResponse.json({ dryRun: true, storyboard });

  let storyboardPath: string;
  try {
    storyboardPath = await saveStoryboard(storyboard, runId);
  } catch (error) {
    return failure(error, "save");
  }

  try {
    logInfo("slop_video_render_started", { runId, scenes: validation.data.scenes.length, includeTestRows });
    const company = getCompanyContext(validation.data.headline, "storyboard");
    const rendered = await renderStoryboard(validation.data, runId);
    const manifests = path.join(process.cwd(), "output", "manifests");
    await mkdir(manifests, { recursive: true });
    await writeFile(path.join(manifests, `${runId}.manifest.json`), JSON.stringify({
      runId,
      source: "slop-video",
      storyboardPath,
      sceneCount: validation.data.scenes.length,
      durationSeconds: rendered.durationSeconds,
      narrationAvailable: rendered.narrationAvailable,
      imageFilenames: rendered.imageFilenames,
      videoFilename: rendered.videoFilename,
    }), { mode: 0o600 });
    const project = await createProject({
      kind: "storyboard",
      title: validation.data.headline,
      videoUrl: videoUrl(rendered.videoFilename),
      durationSeconds: rendered.durationSeconds,
      frames: framesFromStoryboard(validation.data, rendered.imageFilenames),
      storyboard: validation.data,
    });
    schedulePublish(project, "storyboard");
    logInfo("slop_video_render_completed", { runId, projectId: project.id, video: rendered.videoFilename });
    return NextResponse.json({
      videoUrl: `/api/videos/${rendered.videoFilename}`,
      durationSeconds: rendered.durationSeconds,
      sceneCount: validation.data.scenes.length,
      narrationAvailable: rendered.narrationAvailable,
      storyboardPath,
      storyboard,
      project,
      companyContext: await company,
    });
  } catch (error) {
    return failure(error, "render");
  }
}

function flag(value: unknown) {
  return value === true || value === "true" || value === "1";
}

/** GET = dry run. `?includeTestRows=1` disables the test-row filter. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return handle({ dryRun: true, includeTestRows: flag(params.get("includeTestRows")) });
}

/** POST `{ dryRun?: boolean, includeTestRows?: boolean }` (empty body = render with real rows only). */
async function handlePost(request: Request) {
  const raw = await request.text();
  let body: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return responseError("Request body must be a JSON object.", 400);
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return responseError("Malformed JSON.", 400);
    }
  }
  return handle({ dryRun: flag(body.dryRun), includeTestRows: flag(body.includeTestRows) });
}

export const POST = jobable("rawtree", handlePost);
