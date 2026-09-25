import { randomUUID } from "node:crypto";
import { logUserPrompt } from "@/lib/user-prompts";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { BflError, describeError } from "@/lib/bfl";
import { getCompanyContext } from "@/lib/company-agent";
import { createProject, framesFromStoryboard, videoUrl } from "@/lib/projects";
import { schedulePublish } from "@/lib/video-store";
import { logInfo, logException } from "@/lib/runtime-log";
import { renderStoryboard, totalDurationMs } from "@/lib/storyboard-renderer";
import { validateStoryboard, type Storyboard } from "@/lib/storyboard";
import { jobable } from "@/lib/job-route";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 512 * 1024;
const MAX_SCENES = 24;
const MAX_TOTAL_DURATION_MS = 15 * 60 * 1000;
const MAX_TEXT_LENGTH = 8_000;

function responseError(error: string, status: number, details?: unknown) {
  return NextResponse.json({ error, ...(details === undefined ? {} : { details }) }, { status });
}

function renderIssues(storyboard: Storyboard) {
  const issues: { path: string; code: string; message: string }[] = [];
  if (storyboard.scenes.length > MAX_SCENES) {
    issues.push({ path: "$.scenes", code: "invalid_value", message: `At most ${MAX_SCENES} scenes may be rendered.` });
  }
  if (totalDurationMs(storyboard) > MAX_TOTAL_DURATION_MS) {
    issues.push({ path: "$.scenes", code: "invalid_timing", message: "Storyboard duration exceeds the rendering limit." });
  }
  for (const [index, scene] of storyboard.scenes.entries()) {
    const expectedStart = index === 0
      ? 0
      : storyboard.scenes[index - 1].timing.startMs + storyboard.scenes[index - 1].timing.durationMs;
    if (scene.timing.startMs !== expectedStart) {
      issues.push({ path: `$.scenes[${index}].timing.startMs`, code: "invalid_timing", message: "Rendered scenes must start at zero and be contiguous." });
    }
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(scene.id)) {
      issues.push({ path: `$.scenes[${index}].id`, code: "invalid_value", message: "Scene ID contains unsupported characters." });
    }
    if (scene.visualPrompt.length > MAX_TEXT_LENGTH || scene.narration.length > MAX_TEXT_LENGTH || scene.motion.description.length > MAX_TEXT_LENGTH) {
      issues.push({ path: `$.scenes[${index}]`, code: "invalid_value", message: "Scene text exceeds the rendering limit." });
    }
    scene.onScreenText.forEach((text, textIndex) => {
      if (text.text.length > 1_000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text.text)) {
        issues.push({ path: `$.scenes[${index}].onScreenText[${textIndex}].text`, code: "invalid_value", message: "On-screen text contains unsupported content." });
      }
    });
  }
  return issues;
}

async function handlePost(request: Request) {
  try {
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return responseError("Storyboard request is too large.", 413);
    }
    const raw = await request.text();
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return responseError("Storyboard request is too large.", 413);

    let submitted: unknown;
    try {
      submitted = JSON.parse(raw);
    } catch {
      return responseError("Malformed JSON.", 400);
    }
    const validation = validateStoryboard(submitted);
    if (!validation.success) return responseError("Invalid storyboard.", 400, validation.errors);

    const issues = renderIssues(validation.data);
    if (issues.length > 0) return responseError("Storyboard cannot be rendered.", 422, issues);
    const warnings = validation.data.scenes.flatMap((scene, index) => scene.narrationWarnings.map((warning) => ({
      path: `$.scenes[${index}].narrationWarnings`,
      code: warning.code,
      message: warning.message,
    })));
    if (warnings.length > 0) return responseError("Narration requires review.", 422, warnings);

    const runId = randomUUID();
    const manifests = path.join(process.cwd(), "output", "manifests");
    await mkdir(manifests, { recursive: true });
    await writeFile(path.join(manifests, `${runId}.storyboard.json`), JSON.stringify(validation.data), { mode: 0o600 });

    logInfo("storyboard_render_started", { runId, scenes: validation.data.scenes.length, durationMs: totalDurationMs(validation.data) });
    // Submitted storyboards are rendered as validated; the company agent is triggered alongside and its brief is
    // returned for review, never merged into the storyboard.
    const company = getCompanyContext(validation.data.headline, "storyboard");
    const rendered = await renderStoryboard(validation.data, runId);
    const manifest = {
      runId,
      schemaVersion: validation.data.schemaVersion,
      sceneCount: validation.data.scenes.length,
      durationSeconds: rendered.durationSeconds,
      narrationAvailable: rendered.narrationAvailable,
      imageFilenames: rendered.imageFilenames,
      videoFilename: rendered.videoFilename,
    };
    await writeFile(path.join(manifests, `${runId}.manifest.json`), JSON.stringify(manifest), { mode: 0o600 });
    const project = await createProject({
      kind: "storyboard",
      title: validation.data.headline,
      videoUrl: videoUrl(rendered.videoFilename),
      durationSeconds: rendered.durationSeconds,
      frames: framesFromStoryboard(validation.data, rendered.imageFilenames),
      storyboard: validation.data,
    });
    schedulePublish(project, "storyboard");
    logInfo("storyboard_render_completed", { runId, projectId: project.id, scenes: manifest.sceneCount, durationMs: totalDurationMs(validation.data) });
    return NextResponse.json({
      videoUrl: `/api/videos/${rendered.videoFilename}`,
      durationSeconds: rendered.durationSeconds,
      sceneCount: manifest.sceneCount,
      narrationAvailable: rendered.narrationAvailable,
      project,
      companyContext: await company,
    });
  } catch (error) {
    const status = error instanceof BflError && error.status && error.status >= 400 && error.status < 500 ? error.status : 502;
    const message = describeError(error, "Unable to render storyboard.");
    logException("storyboard_render_failed", error, {
      status,
      reason: error instanceof BflError ? "bfl_error" : "render_error",
      message,
    });
    return responseError(message, status);
  }
}

export const POST = jobable("storyboard", logUserPrompt("storyboard", handlePost));
