import { respondMaybeStreaming, type ActionOutcome } from "@/lib/ndjson";
import { logUserPrompt } from "@/lib/user-prompts";
import { ClientAbortedError, emitEvent, emitStage } from "@/lib/progress";
import { frameAt } from "@/lib/frame-grab";
import { detectIntent } from "@/lib/intent";
import {
  ActionError,
  actionErrorResponse,
  appendChat,
  appendToProject,
  askFrame,
  cutProjectRange,
  relevantGuidance,
  type TimeRange,
} from "@/lib/project-actions";
import { clampWindowSec, MOMENT_RANGE, validateMomentRange } from "@/lib/project-edit";
import { loadProject, type Project, type ProjectFrame } from "@/lib/projects";
import { retrieveContext } from "@/lib/rag";
import { logException, logInfo } from "@/lib/runtime-log";

export const runtime = "nodejs";
export const maxDuration = 800;

const MAX_MESSAGE_LENGTH = 4_000;
const round = (value: number) => Math.round(value * 1000) / 1000;

function badRequest(error: string): ActionOutcome {
  return { status: 400, body: { error } };
}

function ok(body: Record<string, unknown>): ActionOutcome {
  return { status: 200, body };
}

function lastFrame(project: Project) {
  return project.frames[project.frames.length - 1];
}

/** Range for an edit when the user didn't drag one: ±0.5s around atSec inside its shot, else the first second. */
function defaultEditRange(project: Project, atSec: number | undefined): { frame: ProjectFrame; range: TimeRange; atSec: number } {
  const at = atSec ?? 0;
  const frame = frameAt(project, at) ?? project.frames[0];
  const segmentStart = frame.startSec;
  const segmentEnd = round(frame.startSec + frame.durationSec);
  let start = atSec === undefined ? segmentStart : Math.max(segmentStart, at - 0.5);
  let end = atSec === undefined ? Math.min(segmentEnd, segmentStart + 1) : Math.min(segmentEnd, at + 0.5);
  // Near a shot edge, grow the other side so the range stays ≥ the minimum.
  if (end - start < MOMENT_RANGE.minSec) {
    if (start === segmentStart) end = Math.min(segmentEnd, start + MOMENT_RANGE.minSec);
    else start = Math.max(segmentStart, end - MOMENT_RANGE.minSec);
  }
  const range = { startSec: round(start), endSec: round(end) };
  const moment = Math.min(Math.max(at, range.startSec), range.endSec - 1 / 30);
  return { frame, range, atSec: round(moment) };
}

/**
 * POST `{ message, atSec?, rangeStartSec?, rangeEndSec?, uploadId?, sourceProjectId? }` → the message decides the
 * action (edit_range | answer | append_shot | cut_range | append_attachment) via OpenRouter + keyword rules, then runs
 * the same code as /ask, /append and /cut.
 */
async function handlePost(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as CommandBody;
  // `Accept: application/x-ndjson` (or ?stream=1) streams progress events, then {"type":"done", …same body…}.
  return respondMaybeStreaming(request, () => runCommand(id, body));
}

type CommandBody = {
  message?: unknown; atSec?: unknown; rangeStartSec?: unknown; rangeEndSec?: unknown; uploadId?: unknown; sourceProjectId?: unknown;
};

async function runCommand(id: string, body: CommandBody): Promise<ActionOutcome> {
  try {
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message || message.length > MAX_MESSAGE_LENGTH) return badRequest(`A message between 1 and ${MAX_MESSAGE_LENGTH} characters is required.`);
    const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
    const present = (value: unknown) => value !== undefined && value !== null;
    if (present(body.atSec) && !finite(body.atSec)) return badRequest(`"atSec" must be a finite number of seconds (got ${JSON.stringify(body.atSec)}).`);
    if (present(body.rangeStartSec) !== present(body.rangeEndSec)) return badRequest("Send both \"rangeStartSec\" and \"rangeEndSec\", or neither.");
    let range: TimeRange | undefined;
    if (present(body.rangeStartSec)) {
      if (!finite(body.rangeStartSec) || !finite(body.rangeEndSec)) return badRequest("\"rangeStartSec\" and \"rangeEndSec\" must be finite numbers of seconds.");
      range = { startSec: round(body.rangeStartSec as number), endSec: round(body.rangeEndSec as number) };
      if (!(range.startSec < range.endSec)) return badRequest(`rangeStartSec (${range.startSec}) must be less than rangeEndSec (${range.endSec}).`);
    }
    const uploadId = typeof body.uploadId === "string" && body.uploadId ? body.uploadId : undefined;
    const sourceProjectId = typeof body.sourceProjectId === "string" && body.sourceProjectId ? body.sourceProjectId : undefined;
    let atSec = finite(body.atSec) ? round(body.atSec as number) : range ? round((range.startSec + range.endSec) / 2) : undefined;

    const project = await loadProject(id);
    if (atSec !== undefined && (atSec < 0 || atSec > project.durationSeconds)) {
      return badRequest(`atSec ${atSec} is outside the video (0–${project.durationSeconds}s).`);
    }
    // The playhead can sit exactly on the end; use the last frame for context there.
    if (atSec !== undefined && atSec >= project.durationSeconds) atSec = round(Math.max(0, project.durationSeconds - 1 / 30));
    const contextFrame = (atSec !== undefined ? frameAt(project, atSec) : undefined) ?? lastFrame(project);

    emitStage("guidance", "Looking up guidance…");
    const rag = relevantGuidance(await retrieveContext(`${message}\n${contextFrame.prompt}`, {
      k: 2, maxChars: 800, tags: ["editing", "flux", project.kind === "storyboard" ? "storyboard" : "motion"],
    }), project.kind);
    emitStage("intent", "Working out what you want…");
    const intent = await detectIntent({
      message,
      project,
      atSec: finite(body.atSec) ? (body.atSec as number) : undefined,
      range,
      hasAttachment: Boolean(uploadId || sourceProjectId),
      framePrompt: contextFrame.prompt,
      guidance: rag.text,
    });
    logInfo("command_intent", { projectId: id, action: intent.action, source: intent.source, atEnd: intent.atEnd });
    const base = { action: intent.action, detectedBy: intent.source, atEnd: intent.atEnd };
    const announce = (window?: TimeRange) => emitEvent({ type: "intent", ...base, ...(window ? { window } : {}) });
    if (intent.action !== "edit_range") announce();

    switch (intent.action) {
      case "answer": {
        const usableRange = range && project.kind === "clip" && !validateMomentRange(contextFrame, range.startSec, range.endSec) ? range : undefined;
        const result = await askFrame({
          projectId: id, index: contextFrame.index, message, atSec, windowSec: clampWindowSec(undefined), range: usableRange, mode: "answer",
          chatExtra: { action: "answer", summary: "Answered your question" },
        });
        return ok({ ...base, summary: "Answered your question", reply: result.reply, project: result.project, ragSources: result.ragSources });
      }
      case "edit_range": {
        const instruction = intent.params.instruction || message;
        if (project.kind === "storyboard") {
          announce();
          const index = contextFrame.index;
          const summary = `Edited shot ${index + 1}`;
          const result = await askFrame({ projectId: id, index, message: instruction, atSec, windowSec: clampWindowSec(undefined), mode: "edit", chatExtra: { action: "edit_range", summary } });
          return ok({ ...base, summary, reply: result.reply, project: result.project, enhancedPrompt: result.enhancedPrompt, ragSources: result.ragSources });
        }
        let target: { frame: ProjectFrame; range: TimeRange; atSec: number };
        if (range) {
          const owner = frameAt(project, (range.startSec + range.endSec) / 2);
          if (!owner) throw new ActionError(`No shot covers ${range.startSec}–${range.endSec}s.`, 400);
          target = { frame: owner, range, atSec: atSec as number };
        } else {
          target = defaultEditRange(project, atSec);
        }
        announce(target.range);
        const summary = `Edited ${target.range.startSec}s–${target.range.endSec}s (shot ${target.frame.index + 1})`;
        const result = await askFrame({
          projectId: id, index: target.frame.index, message: instruction, atSec: target.atSec, windowSec: clampWindowSec(undefined), range: target.range, mode: "edit",
          chatExtra: { action: "edit_range", summary },
        });
        return ok({
          ...base, summary: result.edited ? summary : "No change was made", reply: result.reply, project: result.project,
          ...(result.window ? { window: result.window } : {}), enhancedPrompt: result.enhancedPrompt, ragSources: result.ragSources,
        });
      }
      case "append_shot": {
        if (project.kind !== "clip") throw new ActionError("Extending isn't supported for storyboard projects yet. Generate a clip project to extend it with new shots.", 422);
        const result = await appendToProject({ projectId: id, prompt: intent.params.prompt || message, seconds: intent.params.seconds });
        const shots = result.appendedFrameIndexes.length;
        const summary = `Extended the video by ${result.addedSeconds}s (${shots} new shot${shots === 1 ? "" : "s"})`;
        const updated = await appendChat(id, result.appendedFrameIndex, { text: message }, { text: summary, action: "append_shot", summary, ...(result.enhancedPrompt ? { enhancedPrompt: result.enhancedPrompt } : {}) });
        return ok({
          ...base, summary, project: updated, appendedFrameIndexes: result.appendedFrameIndexes,
          ...(result.enhancedPrompt ? { enhancedPrompt: result.enhancedPrompt } : {}), ...(result.ragSources ? { ragSources: result.ragSources } : {}),
          ...(result.continuationModes ? { continuationModes: result.continuationModes } : {}),
        });
      }
      case "cut_range": {
        if (!range) throw new ActionError("Select a range on the timeline first, then ask to cut it.", 422);
        const result = await cutProjectRange(id, range.startSec, range.endSec);
        const removedSeconds = round(result.removed.endSec - result.removed.startSec);
        const summary = `Removed ${result.removed.startSec}s–${result.removed.endSec}s (${removedSeconds}s)`;
        const index = (frameAt(result.project, Math.min(result.removed.startSec, Math.max(0, result.project.durationSeconds - 0.001))) ?? lastFrame(result.project)).index;
        const updated = await appendChat(id, index, { text: message, rangeStartSec: range.startSec, rangeEndSec: range.endSec }, { text: summary, action: "cut_range", summary });
        return ok({ ...base, summary, project: updated, removed: result.removed });
      }
      case "append_attachment": {
        if (!uploadId && !sourceProjectId) throw new ActionError("Attach a video (or pick one from history) to add it to the end.", 422);
        const result = await appendToProject({ projectId: id, uploadId, sourceProjectId, prompt: uploadId ? message : undefined });
        const summary = `Added the ${uploadId ? "attached video" : "selected video"} at the end (+${result.addedSeconds}s)`;
        const updated = await appendChat(id, result.appendedFrameIndex, { text: message }, { text: summary, action: "append_attachment", summary });
        return ok({ ...base, summary, project: updated, appendedFrameIndexes: result.appendedFrameIndexes });
      }
    }
  } catch (error) {
    if (error instanceof ClientAbortedError) throw error;
    const { status, message } = actionErrorResponse(error, "Unable to run the command.");
    logException("command_failed", error, { projectId: id, status, reason: message });
    return { status, body: { error: message } };
  }
}

export const POST = logUserPrompt("command", handlePost);
