import { randomUUID } from "node:crypto";
import { logUserPrompt } from "@/lib/user-prompts";
import { streamable } from "@/lib/ndjson";
import { emitStage } from "@/lib/progress";
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
import { companyContextForWriter, getCompanyContext } from "@/lib/company-agent";
import {
  ResearchAgentError,
  SESSION_ID,
  getResearchSession,
  researchContextForWriter,
  researchVisualHint,
  type ResearchSession,
} from "@/lib/research-agent";
import { createProject, framesFromStoryboard, isValidProjectId, videoUrl } from "@/lib/projects";
import { schedulePublish } from "@/lib/video-store";
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
 * POST `{ preset: "ad" | "company", prompt: string, durationSec?: 5 | 10 | 15 | 30, aspect?: "16:9", dryRun?: boolean,
 *   researchSessionId?: string }`
 * → `{ videoUrl, durationSeconds, sceneCount, narrationAvailable, storyboard, project, research? }` (dryRun → `{ storyboard, research? }`).
 * `researchSessionId` (from POST /api/research) grounds the script in that session's CompanyProfile and the user's
 * answers, and steers image prompts with its visual identity; without it the company agent brief is used as before.
 */
async function handlePost(request: Request) {
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
  if (body.researchSessionId !== undefined && (typeof body.researchSessionId !== "string" || !SESSION_ID.test(body.researchSessionId))) {
    return responseError('"researchSessionId" must be a research session id from POST /api/research (e.g. "research_1a2b…").', 400);
  }

  let research: ResearchSession | undefined;
  if (typeof body.researchSessionId === "string") {
    try {
      emitStage("prompt", "Reading the company research…");
      research = await getResearchSession(body.researchSessionId);
    } catch (error) {
      const status = error instanceof ResearchAgentError ? error.status : 502;
      const message = describeError(error, "Unable to read the research session");
      logException("generate_preset_research_failed", error, { preset, status, message });
      return responseError(message, status);
    }
    if (!research.profile) {
      return responseError(`Research session ${research.session_id} has no company profile yet (status: ${research.status}); wait for its first round to finish.`, 409);
    }
  }
  const researchInfo = research
    ? { sessionId: research.session_id, company: research.profile?.name ?? research.company, profileVersion: research.profile?.version, answers: research.answers.length }
    : undefined;
  const researchSessionId = typeof body.researchSessionId === "string" && isValidProjectId(body.researchSessionId) ? body.researchSessionId : undefined;

  let storyboard: PresetStoryboard;
  try {
    emitStage("prompt", "Writing the storyboard…");
    // A research session is specific to this company; the tracked-competitor brief would only add noise then.
    const companyContext = research ? researchContextForWriter(research) : companyContextForWriter(await getCompanyContext(prompt, "preset"));
    ({ storyboard } = await buildPresetStoryboard({ preset, prompt, durationSec, aspect, companyContext, visualHint: researchVisualHint(research) }));
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

  if (dryRun) return NextResponse.json({ storyboard, ...(researchInfo ? { research: researchInfo } : {}) });

  const runId = randomUUID();
  let storyboardPath: string;
  try {
    storyboardPath = await saveStoryboard(storyboard, preset, runId);
  } catch (error) {
    return failure(error, "save", preset);
  }

  try {
    logInfo("generate_preset_render_started", { runId, preset, durationSec, scenes: validation.data.scenes.length });
    emitStage("render", "Generating scenes and rendering the video…");
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
    emitStage("save", "Saving the project…");
    const project = await createProject({
      kind: "storyboard",
      title: validation.data.headline,
      videoUrl: videoUrl(rendered.videoFilename),
      durationSeconds: rendered.durationSeconds,
      frames: framesFromStoryboard(validation.data, rendered.imageFilenames),
      storyboard: validation.data,
      ...(researchSessionId ? { researchSessionId } : {}),
    });
    schedulePublish(project, "preset");
    logInfo("generate_preset_render_completed", { runId, preset, projectId: project.id, video: rendered.videoFilename });
    return NextResponse.json({
      videoUrl: videoUrl(rendered.videoFilename),
      durationSeconds: rendered.durationSeconds,
      sceneCount: validation.data.scenes.length,
      narrationAvailable: rendered.narrationAvailable,
      storyboard,
      project,
      ...(researchInfo ? { research: researchInfo } : {}),
    });
  } catch (error) {
    return failure(error, "render", preset);
  }
}

/** Same as above; `Accept: application/x-ndjson` (or ?stream=1) streams progress events, then {"type":"done", …body}. */
export const POST = logUserPrompt((body) => (body.preset === "company" ? "preset_company" : "preset_ad"), streamable(handlePost));
