import { withRouteLog } from "@/lib/route-log";
import { randomUUID } from "node:crypto";
import { logUserPrompt } from "@/lib/user-prompts";
import { streamable } from "@/lib/ndjson";
import { emitStage } from "@/lib/progress";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { BflError, describeError, isVideoQuality, type VideoQuality } from "@/lib/bfl";
import {
  PRESETS,
  PRESET_DURATIONS,
  PRESET_IDS,
  buildPresetStoryboard,
  isPresetDuration,
  isPresetId,
  type PresetId,
  type PresetStoryboard,
} from "@/lib/presets";
import { parseStoryline, type Storyline } from "@/lib/storyline";
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
import type { MemorySource } from "@/lib/memory";
import { logException, logInfo } from "@/lib/runtime-log";
import { isStoryboardRenderMode, renderStoryboard, totalDurationMs, type StoryboardRenderMode } from "@/lib/storyboard-renderer";
import { validateStoryboard } from "@/lib/storyboard";
import { jobable } from "@/lib/job-route";

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
 * POST `{ preset: "ad" | "company" | "competitive", prompt: string, durationSec?: 5 | 10 | 15 | 30, aspect?: "16:9",
 *   dryRun?: boolean, researchSessionId?: string, storyline?: Storyline }`
 * → `{ videoUrl, durationSeconds, sceneCount, narrationAvailable, storyboard, project, research? }` (dryRun → `{ storyboard, research? }`).
 * `researchSessionId` (from POST /api/research) grounds the script in that session's CompanyProfile and the user's
 * answers, and steers image prompts with its visual identity; without it the company agent brief is used as before.
 * `storyline` (from POST /api/research/{id}/storyline, possibly edited by the user) must match the preset's scenes;
 * each scene follows its beat and competitor names are filtered out of every line.
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
  if (aspect !== "16:9" && aspect !== "9:16") return responseError('"aspect" must be "16:9" or "9:16".', 400);
  // Render options: style "cinematic" (default: real FLUX 3 shots) | "still" (legacy slideshow); quality "final" | "draft".
  if (body.style !== undefined && !isStoryboardRenderMode(body.style)) return responseError('"style" must be "cinematic" or "still".', 400);
  if (body.quality !== undefined && !isVideoQuality(body.quality)) return responseError('"quality" must be "final" or "draft".', 400);
  if (aspect === "9:16" && body.style === "still") return responseError('"aspect" 9:16 needs the cinematic style (the still renderer is 16:9 only).', 400);
  const renderOptions = { mode: body.style as StoryboardRenderMode | undefined, quality: body.quality as VideoQuality | undefined, brief: prompt };
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    return responseError('"dryRun" must be a boolean.', 400);
  }
  const dryRun = body.dryRun === true;
  if (body.researchSessionId !== undefined && (typeof body.researchSessionId !== "string" || !SESSION_ID.test(body.researchSessionId))) {
    return responseError('"researchSessionId" must be a research session id from POST /api/research (e.g. "research_1a2b…").', 400);
  }
  let storyline: Storyline | undefined;
  if (body.storyline !== undefined) {
    if (typeof body.researchSessionId !== "string") return responseError('"storyline" needs the "researchSessionId" it was written for.', 400);
    const checked = parseStoryline(body.storyline);
    if ("error" in checked) return responseError(checked.error, 400);
    storyline = checked.storyline;
    const scenes = PRESETS[preset].roles[durationSec].length;
    if (storyline.template !== preset) return responseError(`The storyline was written for the "${storyline.template}" template, not "${preset}".`, 400);
    if (storyline.beats.length !== scenes) return responseError(`The storyline has ${storyline.beats.length} scenes; the ${preset} template at ${durationSec}s has ${scenes}.`, 400);
    if (storyline.session_id && storyline.session_id !== body.researchSessionId) return responseError("The storyline belongs to a different research session.", 400);
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
    if (storyline) {
      // The agent's list is authoritative: the browser copy may have dropped names from avoid_terms.
      const avoid = [...new Set([...storyline.avoid_terms, ...(research.competitors?.avoid_terms ?? []), ...(research.storyline?.avoid_terms ?? [])])];
      const checked = parseStoryline({ ...storyline, avoid_terms: avoid });
      if ("error" in checked) return responseError(checked.error, 400);
      storyline = checked.storyline;
    }
  }
  const researchInfo = research
    ? { sessionId: research.session_id, company: research.profile?.name ?? research.company, profileVersion: research.profile?.version, answers: research.answers.length, ...(storyline ? { storylineId: storyline.storyline_id, storylineVersion: storyline.version } : {}) }
    : undefined;
  const researchSessionId = typeof body.researchSessionId === "string" && isValidProjectId(body.researchSessionId) ? body.researchSessionId : undefined;

  let storyboard: PresetStoryboard;
  let memorySources: MemorySource[] = [];
  let companyContext: string | undefined;
  try {
    emitStage("prompt", "Writing the storyboard…");
    // A research session is specific to this company; the tracked-competitor brief would only add noise then.
    companyContext = research ? researchContextForWriter(research) : companyContextForWriter(await getCompanyContext(prompt, "preset"));
    ({ storyboard, memorySources } = await buildPresetStoryboard({ preset, prompt, durationSec, aspect, companyContext, visualHint: researchVisualHint(research), storyline }));
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

  if (dryRun) return NextResponse.json({ storyboard, memorySources, ...(researchInfo ? { research: researchInfo } : {}) });

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
    const rendered = await renderStoryboard(validation.data, runId, { ...renderOptions, companyContext });
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
      engine: rendered.engine,
      quality: rendered.quality,
      sceneEngines: rendered.sceneEngines,
      storyboard,
      project,
      memorySources,
      ...(researchInfo ? { research: researchInfo } : {}),
    });
  } catch (error) {
    return failure(error, "render", preset);
  }
}

/** Same as above; `Accept: application/x-ndjson` (or ?stream=1) streams progress events, then {"type":"done", …body}. */
export const POST = withRouteLog(jobable("preset", logUserPrompt((body) => (body.preset === "company" ? "preset_company" : "preset_ad"), streamable(handlePost))));
