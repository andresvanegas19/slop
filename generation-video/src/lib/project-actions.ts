import path from "node:path";
import { BflError, describeError } from "@/lib/bfl";
import { CLIP_SECONDS } from "@/lib/clip";
import { renderContinuationShot } from "@/lib/continuation";
import { assembleClipProject, ClipProjectError, segmentFrameFromUpload } from "@/lib/clip-project";
import { decideFrameChat } from "@/lib/frame-chat";
import { frameAt, FrameGrabError, grabVideoFrame } from "@/lib/frame-grab";
import { OpenRouterConfigurationError, OpenRouterError } from "@/lib/openrouter";
import { applyFrameEdit, FrameEditError, momentWindow, validateMomentRange } from "@/lib/project-edit";
import {
  frameFilePath,
  frameImageUrl,
  loadProject,
  ProjectNotFoundError,
  saveProject,
  videoUrl,
  withProjectLock,
  type ChatMessage,
  type Project,
  type ProjectFrame,
} from "@/lib/projects";
import { enhanceImagePrompt, enhanceShotPrompt } from "@/lib/prompt-enhance";
import { mergeMemorySources, retrieveMemory, type MemorySource } from "@/lib/memory";
import { recordEditExample } from "@/lib/rag";
import { emitEvent, emitStage, isStreaming } from "@/lib/progress";
import { logInfo } from "@/lib/runtime-log";
import { extractFirstFrame, extractLastFrame, SegmentError, videoFilePath } from "@/lib/segments";
import { appendVideoFile, cutRange, TimelineError, trimSegmentTo } from "@/lib/timeline-ops";
import { loadUpload, UploadError } from "@/lib/uploads";
import { schedulePublish } from "@/lib/video-store";

/** Validation / "not possible" errors raised by the shared project actions (status is the HTTP status to return). */
export class ActionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type TimeRange = { startSec: number; endSec: number };

const GUIDANCE_MAX_CHARS = 1_600;
export const MAX_FRAMES = 40;
export const MAX_APPEND_SECONDS = 15;

/** Maps any error from the project actions to `{ status, message }` for a JSON error response. */
export function actionErrorResponse(error: unknown, fallback: string) {
  if (error instanceof ActionError || error instanceof UploadError || error instanceof TimelineError) {
    return { status: error.status, message: error.message };
  }
  if (error instanceof ProjectNotFoundError) return { status: 404, message: error.message };
  if (error instanceof OpenRouterConfigurationError) return { status: 503, message: error.message };
  if (error instanceof FrameGrabError) return { status: 422, message: error.message };
  let status = 502;
  if (error instanceof FrameEditError || error instanceof SegmentError || error instanceof ClipProjectError) status = 422;
  else if ((error instanceof BflError || error instanceof OpenRouterError) && error.status && error.status >= 400 && error.status < 500) status = error.status;
  return { status, message: describeError(error, fallback) };
}

/**
 * Drops storyboard-only guidance (e.g. the storyboard house-style prefix) for clip projects: the small model tends to
 * paste it into the clip's prompt and change its style. retrieveContext formats one "[n] Title: body" line per source.
 */
export function relevantGuidance<S extends { title: string }>(rag: { text: string; sources: S[] }, kind: "clip" | "storyboard") {
  if (kind === "storyboard" || !rag.text) return rag;
  const keep = rag.sources.map((source) => !/storyboard/i.test(source.title));
  if (keep.every(Boolean)) return rag;
  const [header, ...lines] = rag.text.split("\n");
  const kept = lines.filter((line) => {
    const position = Number(line.match(/^\[(\d+)\]/)?.[1]);
    return !Number.isInteger(position) || keep[position - 1] !== false;
  });
  const sources = rag.sources.filter((_, position) => keep[position]);
  return { text: sources.length ? [header, ...kept].join("\n") : "", sources };
}

/** Appends a user + assistant entry to a frame's chat thread (under the project lock). */
export async function appendChat(projectId: string, index: number, user: Omit<ChatMessage, "role" | "at">, assistant: Omit<ChatMessage, "role" | "at">) {
  return withProjectLock(projectId, async () => {
    const project = await loadProject(projectId);
    const now = new Date().toISOString();
    const key = String(index);
    const thread: ChatMessage[] = [
      ...(project.chats[key] ?? []),
      { role: "user", at: now, ...user },
      { role: "assistant", at: now, ...assistant },
    ];
    const updated = { ...project, chats: { ...project.chats, [key]: thread }, updatedAt: now };
    await saveProject(updated);
    return updated;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Ask (answer about a frame, or edit it: range / ±window / whole frame)
// ---------------------------------------------------------------------------------------------------------------

export type AskInput = {
  projectId: string;
  index: number;
  message: string;
  atSec?: number;
  /** Half-width for ±window moment edits (already clamped). */
  windowSec: number;
  range?: TimeRange;
  /** "auto" lets the chat model decide; "edit" forces an image edit; "answer" never edits. */
  mode?: "auto" | "edit" | "answer";
  /** Extra fields for the assistant chat entry (e.g. /command's action + summary). */
  chatExtra?: Pick<ChatMessage, "action" | "summary">;
};

export type AskResult = {
  reply: string;
  edited: boolean;
  project: Project;
  ragSources: string[];
  /** Where the memory used for this turn came from (knowledge, past videos, your prompts, research). */
  memorySources: MemorySource[];
  grabbedFrameUrl?: string;
  enhancedPrompt?: string;
  window?: TimeRange;
};

/** Validates a range/atSec against the project (throws ActionError 400 with a descriptive message). */
function validateAskTiming(project: Project, index: number, atSec: number | undefined, range: TimeRange | undefined) {
  if (range) {
    if (project.kind !== "clip") throw new ActionError("Range edits are only supported for clip projects; storyboard frames are edited per scene.", 400);
    const frameForRange = project.frames.find((item) => item.index === index)!;
    const problem = validateMomentRange(frameForRange, range.startSec, range.endSec);
    if (problem) {
      const owner = frameAt(project, (range.startSec + range.endSec) / 2);
      throw new ActionError(owner && owner.index !== index && !validateMomentRange(owner, range.startSec, range.endSec)
        ? `The range ${range.startSec}–${range.endSec}s is in frame ${owner.index}, not frame ${index}; post to /api/projects/${project.id}/frames/${owner.index}/ask instead.`
        : problem, 400);
    }
  }
  if (atSec !== undefined) {
    if (atSec < 0 || atSec >= project.durationSeconds) {
      throw new ActionError(`atSec ${atSec} is outside the video; it must be ≥ 0 and < ${project.durationSeconds} (the project's duration in seconds).`, 400);
    }
    const owner = frameAt(project, atSec);
    if (!owner || owner.index !== index) {
      throw new ActionError(owner
        ? `atSec ${atSec} falls in frame ${owner.index} (${owner.startSec}s–${owner.startSec + owner.durationSec}s), not frame ${index}; post to /api/projects/${project.id}/frames/${owner.index}/ask instead.`
        : `No frame covers atSec ${atSec} in project "${project.id}".`, 400);
    }
  }
}

export async function askFrame(input: AskInput): Promise<AskResult> {
  const { projectId: id, index, message, atSec, range, windowSec } = input;
  const mode = input.mode ?? "auto";
  const project = await loadProject(id);
  if (!project.frames.some((frame) => frame.index === index)) {
    throw new ActionError(`Frame ${index} does not exist in project "${id}" (it has ${project.frames.length} frame(s)).`, 404);
  }
  validateAskTiming(project, index, atSec, range);

  let grabbedFrameUrl: string | undefined;
  let referenceImagePath: string | undefined;
  if (atSec !== undefined) {
    const filename = await grabVideoFrame(project, atSec);
    grabbedFrameUrl = frameImageUrl(filename);
    referenceImagePath = path.join(process.cwd(), "output", "frames", filename);
  }

  logInfo("frame_ask_started", { projectId: id, frame: index, messageLength: message.length, atSec, mode });
  const frame = project.frames.find((item) => item.index === index)!;
  emitStage("guidance", "Looking up editing guidance…");
  const rag = relevantGuidance(await retrieveMemory(
    [message, frame.prompt, frame.headline, frame.narration].filter(Boolean).join("\n"),
    { k: 4, maxChars: GUIDANCE_MAX_CHARS, tags: ["editing", "flux", project.kind === "storyboard" ? "storyboard" : "motion"], projectId: id, researchSessionId: project.researchSessionId },
  ), project.kind);
  const ragSources = [...new Set(rag.sources.map((source) => source.title))];
  const memorySources = mergeMemorySources(rag.sources);
  emitStage("prompt", mode === "answer" ? "Thinking about your question…" : "Reading your request…");
  const streaming = isStreaming();
  const decision = await decideFrameChat(project, index, message, {
    referenceImagePath,
    atSec,
    guidance: rag.text,
    onToken: streaming && mode !== "edit" ? (text) => emitEvent({ type: "token", field: "reply", text }) : undefined,
  });
  if (mode === "answer") decision.edit = undefined;
  if (mode === "edit" && !decision.edit?.image_prompt) {
    // Intent detection already decided this is an edit: let the enhancer expand the user's instruction.
    decision.edit = { ...decision.edit, image_prompt: message };
    if (!decision.reply || /didn't|not change|would not/i.test(decision.reply)) decision.reply = "Editing the selected moment.";
  }

  // Image edits get a focused second call that expands the user's instruction into a detailed prompt.
  let enhancedPrompt: string | undefined;
  if (decision.edit?.image_prompt) {
    emitStage("prompt", "Writing a detailed image prompt…");
    const enhanced = await enhanceImagePrompt({
      project, index, instruction: message, draftPrompt: decision.edit.image_prompt, referenceImagePath, guidance: rag.text,
      onToken: streaming ? (text) => emitEvent({ type: "token", field: "enhancedPrompt", text }) : undefined,
    });
    enhancedPrompt = enhanced.prompt;
    emitEvent({ type: "prompt", enhancedPrompt });
    decision.edit = { ...decision.edit, image_prompt: enhanced.prompt };
    logInfo("frame_ask_prompt_enhanced", { projectId: id, frame: index, source: enhanced.source, length: enhanced.prompt.length });
  }

  let window: TimeRange | undefined;
  const result = await withProjectLock(id, async () => {
    // Reload inside the lock so a concurrent edit isn't overwritten.
    let current = await loadProject(id);
    const edited = Boolean(decision.edit);
    // Clip projects + a grabbed moment: only the range / ±windowSec around it is regenerated ("Edit moment").
    const moment = current.kind === "clip" && atSec !== undefined && decision.edit?.image_prompt
      ? (range ? { atSec, range } : { atSec, windowSec })
      : undefined;
    if (moment) {
      const owner = current.frames.find((item) => item.index === index);
      if (range) window = range;
      else if (owner) window = momentWindow(owner, atSec as number, windowSec);
    }
    if (decision.edit) current = await applyFrameEdit(current, index, decision.edit, { referenceImagePath, moment });
    const now = new Date().toISOString();
    const key = String(index);
    // The window actually used (edit) or the range the user selected (question), for "0.7s–1.3s · shot 1" in the UI.
    const shown = window ?? range;
    const rangeFields = shown ? { rangeStartSec: shown.startSec, rangeEndSec: shown.endSec } : {};
    const thread: ChatMessage[] = [
      ...(current.chats[key] ?? []),
      { role: "user", text: message, at: now, ...(atSec === undefined ? {} : { atSec }), ...rangeFields, ...(grabbedFrameUrl ? { grabbedFrameUrl } : {}) },
      {
        role: "assistant",
        ...rangeFields,
        text: decision.reply,
        at: now,
        ...(edited ? { edited: true } : {}),
        ...(enhancedPrompt ? { enhancedPrompt } : {}),
        ...(ragSources.length ? { ragSources, memorySources } : {}),
        ...(input.chatExtra ?? {}),
      },
    ];
    current = { ...current, chats: { ...current.chats, [key]: thread }, updatedAt: now };
    emitStage("save", "Saving the project…");
    await saveProject(current);
    return { reply: decision.reply, edited, project: current };
  });

  if (result.edited && result.project.videoUrl !== project.videoUrl) schedulePublish(result.project, "edited");
  logInfo("frame_ask_completed", { projectId: id, frame: index, edited: result.edited, ragSources: ragSources.length });
  if (result.edited && enhancedPrompt) {
    // Learning example for future retrievals; never blocks or fails the response.
    void recordEditExample({
      projectId: id,
      kind: project.kind,
      instruction: message,
      previousPrompt: frame.prompt,
      enhancedPrompt,
      reply: result.reply,
    }).catch(() => undefined);
  }
  return {
    ...result,
    ragSources,
    memorySources,
    ...(grabbedFrameUrl ? { grabbedFrameUrl } : {}),
    ...(enhancedPrompt ? { enhancedPrompt } : {}),
    ...(window && result.edited ? { window } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Append (upload / another project's video / generated shots)
// ---------------------------------------------------------------------------------------------------------------

export type AppendInput = {
  projectId: string;
  uploadId?: string;
  sourceProjectId?: string;
  prompt?: string;
  /** Generated appends only: total extra time in seconds (1–15). Several shots are chained when > CLIP_SECONDS. */
  seconds?: number;
};

export type AppendResult = {
  project: Project;
  appendedFrameIndex: number;
  appendedFrameIndexes: number[];
  addedSeconds: number;
  enhancedPrompt?: string;
  ragSources?: string[];
  memorySources?: MemorySource[];
  /** Generated appends: "v2v" (continued from the video's last ~2s) or "i2v" (from its last frame), per shot. */
  continuationModes?: string[];
};

export async function appendToProject(input: AppendInput): Promise<AppendResult> {
  const { projectId: id, uploadId, sourceProjectId } = input;
  const prompt = input.prompt?.trim() ?? "";
  if (!uploadId && !prompt && !sourceProjectId) {
    throw new ActionError("Send \"uploadId\" (an uploaded video), \"sourceProjectId\" (another project's video), or \"prompt\" (a new shot to generate).", 400);
  }
  if (uploadId && sourceProjectId) throw new ActionError("Send either \"uploadId\" or \"sourceProjectId\", not both.", 400);
  if (input.seconds !== undefined && (!Number.isFinite(input.seconds) || input.seconds < 1 || input.seconds > MAX_APPEND_SECONDS)) {
    throw new ActionError(`"seconds" must be between 1 and ${MAX_APPEND_SECONDS}.`, 400);
  }

  const initial = await loadProject(id);
  if (initial.kind === "storyboard") {
    throw new ActionError("Appending isn't supported for storyboard projects yet. Start a clip project (generate a clip or upload a video) to extend it.", 422);
  }
  const upload = uploadId ? await loadUpload(uploadId) : undefined;
  let source: Project | undefined;
  if (sourceProjectId) {
    try {
      source = await loadProject(sourceProjectId);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) throw new ActionError(`Source project "${sourceProjectId}" was not found.`, 404);
      throw error;
    }
  }
  const shotCount = upload || source ? 1 : Math.max(1, Math.ceil((input.seconds ?? CLIP_SECONDS) / CLIP_SECONDS));
  if (initial.frames.length + shotCount > MAX_FRAMES) {
    throw new ActionError(`Project "${id}" has ${initial.frames.length} shots; adding ${shotCount} would exceed the ${MAX_FRAMES}-shot limit.`, 422);
  }

  logInfo("project_append_started", { projectId: id, mode: upload ? "upload" : source ? "project" : "generate", shots: shotCount, seconds: input.seconds });
  const result = await withProjectLock(id, async () => {
    const project = await loadProject(id);
    const before = project.durationSeconds;
    if (source) {
      // The source's current rendered video (clip or storyboard) becomes one new segment.
      emitStage("render", "Adding the video to the end…");
      const appended = await appendVideoFile(project, videoFilePath(source.videoUrl), { prompt: `From: ${source.title}`, source: "project" });
      await saveProject(appended);
      return { project: appended, appendedFrameIndexes: [appended.frames.length - 1], addedSeconds: appended.durationSeconds - before };
    }
    if (upload) {
      emitStage("render", "Adding the uploaded video to the end…");
      const frame = await segmentFrameFromUpload(upload.filePath, prompt || `Uploaded video: ${upload.upload.filename}`);
      const assembled = await assembleClipProject(project, [...project.frames, { ...frame, index: project.frames.length }]);
      await saveProject(assembled);
      return { project: assembled, appendedFrameIndexes: [assembled.frames.length - 1], addedSeconds: assembled.durationSeconds - before };
    }

    // Generated: continuity — each new shot starts from the last frame of what comes before it.
    const previous = project.frames.at(-1);
    const previousPrompt = previous?.prompt ?? project.title;
    const keyframe = await extractLastFrame(videoFilePath(project.videoUrl));
    let contextVideo = videoFilePath(project.videoUrl);
    const continuationModes: string[] = [];
    emitStage("guidance", "Looking up motion guidance…");
    const rag = relevantGuidance(await retrieveMemory(`${prompt}\n${previousPrompt}`, {
      k: 4, maxChars: GUIDANCE_MAX_CHARS, tags: ["motion", "flux"], projectId: id, researchSessionId: project.researchSessionId,
    }), "clip");
    const ragSources = [...new Set(rag.sources.map((item) => item.title))];
    const memorySources = mergeMemorySources(rag.sources);
    emitStage("prompt", "Writing the next shot's prompt…");
    const enhanced = await enhanceShotPrompt({
      projectId: id,
      previousPrompt,
      instruction: prompt,
      referenceImagePath: frameFilePath(frameImageUrl(keyframe)),
      guidance: rag.text,
      onToken: isStreaming() ? (text) => emitEvent({ type: "token", field: "enhancedPrompt", text }) : undefined,
    });
    emitEvent({ type: "prompt", enhancedPrompt: enhanced.prompt });
    logInfo("project_append_prompt_enhanced", { projectId: id, source: enhanced.source, length: enhanced.prompt.length });

    const target = input.seconds;
    const newFrames: ProjectFrame[] = [];
    for (let shot = 0; shot < shotCount; shot += 1) {
      const shotPrompt = shot === 0 ? enhanced.prompt : `${enhanced.prompt} The action continues naturally from the previous moment.`;
      // Continue the motion: FLUX 3 v2v from the last ~2s of what comes before (falls back to i2v from its last frame).
      emitStage("video", shotCount > 1 ? `Generating shot ${shot + 1} of ${shotCount}…` : "Generating the new shot…");
      const clip = await renderContinuationShot(contextVideo, shotPrompt);
      continuationModes.push(clip.mode);
      let segmentFile = clip.videoFilename;
      let length = clip.durationSeconds;
      // The last shot is trimmed so the total added time is exactly `seconds`.
      if (target !== undefined && shot === shotCount - 1) {
        const wanted = Math.round((target - CLIP_SECONDS * (shotCount - 1)) * 1000) / 1000;
        if (wanted < length - 0.001) {
          segmentFile = await trimSegmentTo(videoFilePath(videoUrl(clip.videoFilename)), wanted);
          length = wanted;
        }
      }
      const firstFrame = await extractFirstFrame(videoFilePath(videoUrl(segmentFile)));
      newFrames.push({
        index: project.frames.length + shot,
        imageUrl: frameImageUrl(firstFrame),
        prompt: shotPrompt,
        startSec: 0,
        durationSec: length,
        segmentUrl: videoUrl(segmentFile),
        source: "generated",
      });
      if (shot < shotCount - 1) contextVideo = videoFilePath(videoUrl(segmentFile));
    }
    emitStage("render", "Assembling the video…");
    const assembled = await assembleClipProject(project, [...project.frames, ...newFrames]);
    emitStage("save", "Saving the project…");
    await saveProject(assembled);
    return {
      project: assembled,
      appendedFrameIndexes: newFrames.map((frame) => frame.index),
      addedSeconds: assembled.durationSeconds - before,
      enhancedPrompt: enhanced.prompt,
      ragSources,
      memorySources,
      continuationModes,
    };
  });
  schedulePublish(result.project, "appended");
  logInfo("project_append_completed", { projectId: id, frames: result.project.frames.length, durationSeconds: result.project.durationSeconds, addedSeconds: result.addedSeconds });
  return {
    ...result,
    addedSeconds: Math.round(result.addedSeconds * 1000) / 1000,
    appendedFrameIndex: result.appendedFrameIndexes.at(-1) as number,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Cut
// ---------------------------------------------------------------------------------------------------------------

export async function cutProjectRange(projectId: string, startSec: number, endSec: number) {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) throw new ActionError("The cut range must be finite numbers of seconds.", 400);
  if (!(startSec < endSec)) throw new ActionError(`rangeStartSec (${startSec}) must be less than rangeEndSec (${endSec}).`, 400);
  const result = await withProjectLock(projectId, async () => {
    const project = await loadProject(projectId);
    const removed = { startSec: Math.max(0, Math.round(startSec * 1000) / 1000), endSec: Math.min(project.durationSeconds, Math.round(endSec * 1000) / 1000) };
    emitStage("render", "Cutting and reassembling the video…");
    const updated = await cutRange(project, startSec, endSec);
    emitStage("save", "Saving the project…");
    await saveProject(updated);
    return { project: updated, removed };
  });
  schedulePublish(result.project, "cut");
  logInfo("project_cut_completed", { projectId, startSec: result.removed.startSec, endSec: result.removed.endSec, durationSeconds: result.project.durationSeconds });
  return result;
}
