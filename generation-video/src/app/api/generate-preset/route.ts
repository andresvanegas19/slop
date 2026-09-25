import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { BflError, describeError } from "@/lib/bfl";
import {
  PRESET_DURATIONS,
  PRESET_IDS,
  buildPresetStoryboard,
  isPresetDuration,
  isPresetId,
  type PresetId,
  type PresetStoryboard,
} from "@/lib/presets";
import { createProject, framesFromStoryboard, videoUrl } from "@/lib/projects";
import { logException, logInfo } from "@/lib/runtime-log";
import { renderStoryboard, totalDurationMs } from "@/lib/storyboard-renderer";
import { validateStoryboard } from "@/lib/storyboard";

export const runtime = "nodejs";

const MAX_PROMPT_LENGTH = 2_000;
const DEFAULT_DURATION_SEC = 10;

function responseError(error: string, status: number, details?: unknown) {
  return NextResponse.json({ error, ...(details === undefined ? {} : { details }) }, { status });
}

async function saveStoryboard(storyboard: PresetStoryboard, preset: PresetId, runId: string) {
  const directory = path.join(process.cwd(), "storyboards", "generated");
  await mkdir(directory, { recursive: true });
  const filename = `${preset}-${runId}.json`;
  await writeFile(path.join(directory, filename), `${JSON.stringify(storyboard, null, 2)}\n`, { mode: 0o600 });
  return path.join("storyboards", "generated", filename);
}

function failure(error: unknown, stage: string, preset: PresetId) {
  const status = error instanceof BflError && error.status && error.status >= 400 && error.status < 500 ? error.status : 502;
  const fallback = stage === "render" ? "Unable to render the preset video." : stage === "save" ? "Unable to save the storyboard." : "Unable to write the preset storyboard.";
  const message = describeError(error, fallback);
  logException("generate_preset_failed", error, { stage, preset, status, message });
  return responseError(message, status);
}

/**
 * POST `{ preset: "ad" | "company", prompt: string, durationSec?: 5 | 10 | 15 | 30, aspect?: "16:9", dryRun?: boolean }`
 * → `{ videoUrl, durationSeconds, sceneCount, narrationAvailable, storyboard, project }` (dryRun → `{ storyboard }`).
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await request.text());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return responseError("Request body must be a JSON object.", 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return responseError("Malformed JSON: send a body like {\"preset\":\"ad\",\"prompt\":\"...\"}.", 400);
  }

  const { preset } = body;
  if (!isPresetId(preset)) {
    return responseError(`"preset" must be one of ${PRESET_IDS.map((id) => `"${id}"`).join(", ")}.`, 400);
  }
  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    return responseError('"prompt" is required: describe the product or company in a sentence or two.', 400);
  }
  const prompt = body.prompt.trim();
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return responseError(`"prompt" is too long (${prompt.length} characters); the limit is ${MAX_PROMPT_LENGTH}.`, 400);
  }
  const durationSec = body.durationSec === undefined ? DEFAULT_DURATION_SEC : body.durationSec;
  if (!isPresetDuration(durationSec)) {
    return responseError(`"durationSec" must be one of ${PRESET_DURATIONS.join(", ")} (seconds).`, 400);
  }
  const aspect = body.aspect === undefined ? "16:9" : body.aspect;
  if (aspect === "9:16") {
    return responseError('"aspect" 9:16 is not supported yet: the storyboard renderer outputs a fixed 1920x1080 (16:9) video. Use "16:9".', 400);
  }
  if (aspect !== "16:9") return responseError('"aspect" must be "16:9".', 400);
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    return responseError('"dryRun" must be a boolean.', 400);
  }
  const dryRun = body.dryRun === true;

  let storyboard: PresetStoryboard;
  try {
    ({ storyboard } = await buildPresetStoryboard({ preset, prompt, durationSec, aspect }));
  } catch (error) {
    return failure(error, "build", preset);
  }

  const validation = validateStoryboard(storyboard);
  if (!validation.success) {
    logInfo("generate_preset_invalid_storyboard", { preset, errors: validation.errors.length });
    return responseError("Generated storyboard is invalid.", 500, validation.errors);
  }
  if (totalDurationMs(validation.data) !== durationSec * 1000) {
    return responseError(`Generated storyboard is ${totalDurationMs(validation.data) / 1000}s, not exactly ${durationSec}s.`, 500);
  }

  if (dryRun) return NextResponse.json({ storyboard });

  const runId = randomUUID();
  let storyboardPath: string;
  try {
    storyboardPath = await saveStoryboard(storyboard, preset, runId);
  } catch (error) {
    return failure(error, "save", preset);
  }

  try {
    logInfo("generate_preset_render_started", { runId, preset, durationSec, scenes: validation.data.scenes.length });
    const rendered = await renderStoryboard(validation.data, runId);
    const manifests = path.join(process.cwd(), "output", "manifests");
    await mkdir(manifests, { recursive: true });
    await writeFile(path.join(manifests, `${runId}.manifest.json`), JSON.stringify({
      runId,
      source: "generate-preset",
      preset,
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
    logInfo("generate_preset_render_completed", { runId, preset, projectId: project.id, video: rendered.videoFilename });
    return NextResponse.json({
      videoUrl: videoUrl(rendered.videoFilename),
      durationSeconds: rendered.durationSeconds,
      sceneCount: validation.data.scenes.length,
      narrationAvailable: rendered.narrationAvailable,
      storyboard,
      project,
    });
  } catch (error) {
    return failure(error, "render", preset);
  }
}
