import { randomUUID } from "node:crypto";
import { generateFrameImage, renderClipFromFrame } from "@/lib/clip";
import { CLIP_SECONDS } from "@/lib/clip";
import { assembleClipProject } from "@/lib/clip-project";
import { frameFilePath, frameImageUrl, framesFromStoryboard, migrateProject, videoUrl, type Project, type ProjectFrame } from "@/lib/projects";
import { renderPinnedClip } from "@/lib/pinned-clip";
import { extractFrameAt, spliceWindow, videoFilePath } from "@/lib/segments";
import { logInfo } from "@/lib/runtime-log";
import { validateStoryboard, type Storyboard, type StoryboardOnScreenText } from "@/lib/storyboard";
import { imageSize, renderStoryboard } from "@/lib/storyboard-renderer";

export type FrameEdit = {
  image_prompt?: string;
  narration?: string;
  headline?: string;
  sub?: string;
};

export class FrameEditError extends Error {}

const LIMITS = { image_prompt: 4_000, narration: 1_000, headline: 200, sub: 200 } as const;

/** Trims and length-checks an edit; drops empty/unchanged-type fields. Returns undefined if nothing is left. */
export function normalizeFrameEdit(value: unknown, kind: Project["kind"]): FrameEdit | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const edit: FrameEdit = {};
  for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    if (kind === "clip" && key !== "image_prompt") continue; // clips have no narration/overlays
    const field = source[key];
    if (typeof field !== "string") continue;
    const trimmed = field.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, LIMITS[key]);
    // headline/sub may be cleared with an empty string; image_prompt/narration may not.
    if (!trimmed && (key === "image_prompt" || key === "narration")) continue;
    edit[key] = trimmed;
  }
  return Object.keys(edit).length > 0 ? edit : undefined;
}

function applySceneText(texts: StoryboardOnScreenText[], position: "top" | "bottom", text: string | undefined) {
  if (text === undefined) return texts;
  const matches = (item: StoryboardOnScreenText) => item.position === position || (position === "top" && item.position === "center");
  const rest = texts.filter((item) => !matches(item));
  if (!text) return rest;
  return position === "top" ? [{ text, position }, ...rest] : [...rest, { text, position }];
}

// Phrase the regeneration as an edit of the reference image (tested with flux-2-pro: this applies the change
// while keeping composition; quoting the previous prompt or re-using the original seed makes FLUX ignore the edit).
function editInstruction(nextPrompt: string, removeOverlayText = false) {
  return [
    `Change the image to match: ${nextPrompt.replace(/\.?\s*$/, ".")}`,
    "Keep the same composition and camera angle.",
    // Frames grabbed from a rendered storyboard video contain the burned-in headline/subtitle overlays.
    removeOverlayText ? "Remove any on-screen text, captions, or text boxes from the image." : undefined,
  ].filter(Boolean).join(" ");
}

export type FrameEditOptions = {
  /** Image to condition the regeneration on (e.g. a frame grabbed from the video); defaults to the frame's key image. */
  referenceImagePath?: string;
  /**
   * Clip projects only: "Edit moment" — replace only [atSec − windowSec, atSec + windowSec] (clamped to the frame's
   * segment) instead of regenerating the whole segment.
   */
  moment?: MomentSpec;
};

/** Either a ±windowSec window around atSec, or an exact dragged project-time range (atSec = context moment). */
export type MomentSpec = { atSec: number; windowSec?: number; range?: { startSec: number; endSec: number } };

export const MOMENT_RANGE = { minSec: 0.3, maxSec: CLIP_SECONDS } as const;

/** Validates a dragged range against the frame's segment; returns an error message or undefined. */
export function validateMomentRange(frame: ProjectFrame, startSec: number, endSec: number) {
  const segmentStart = frame.startSec;
  const segmentEnd = Math.round((frame.startSec + frame.durationSec) * 1000) / 1000;
  if (!(startSec < endSec)) return `rangeStartSec (${startSec}) must be less than rangeEndSec (${endSec}).`;
  if (startSec < segmentStart - 0.001 || endSec > segmentEnd + 0.001) {
    return `The range ${startSec}–${endSec}s must lie inside one shot; frame ${frame.index} spans ${segmentStart}–${segmentEnd}s.`;
  }
  const length = endSec - startSec;
  if (length < MOMENT_RANGE.minSec) return `The range is ${length.toFixed(2)}s; the minimum is ${MOMENT_RANGE.minSec}s.`;
  if (length > MOMENT_RANGE.maxSec + 0.001) return `The range is ${length.toFixed(2)}s; the maximum is ${MOMENT_RANGE.maxSec}s.`;
  return undefined;
}

export const MOMENT_WINDOW = { default: 1, min: 0.5, max: CLIP_SECONDS / 2 } as const;

/** Clamps a requested half-window; the generated clip (CLIP_SECONDS) must cover the whole 2×windowSec window. */
export function clampWindowSec(value: unknown) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : MOMENT_WINDOW.default;
  return Math.min(MOMENT_WINDOW.max, Math.max(MOMENT_WINDOW.min, number));
}

/** Project-time edit window for a moment edit: [atSec − w, atSec + w] clamped to the frame's segment (no re-extension). */
export function momentWindow(frame: ProjectFrame, atSec: number, windowSec: number) {
  const segmentStart = frame.startSec;
  const segmentEnd = frame.startSec + frame.durationSec;
  const startSec = Math.max(segmentStart, atSec - windowSec);
  const endSec = Math.min(segmentEnd, atSec + windowSec);
  return { startSec: Math.round(startSec * 1000) / 1000, endSec: Math.round(endSec * 1000) / 1000 };
}

/**
 * Applies an edit to one frame: regenerates its image (conditioned on the current frame; no fixed seed, see generateFrameImage) when
 * `image_prompt` changes, then re-renders the whole video reusing every other frame's image.
 * Returns the updated project (not yet saved).
 */
export async function applyFrameEdit(project: Project, index: number, edit: FrameEdit, options: FrameEditOptions = {}): Promise<Project> {
  const frame = project.frames[index];
  if (!frame) throw new FrameEditError(`Frame ${index} does not exist in project "${project.id}".`);
  const now = new Date().toISOString();
  logInfo("frame_edit_started", { projectId: project.id, index, fields: Object.keys(edit).join(",") });

  if (project.kind === "clip" && options.moment && edit.image_prompt) {
    return applyMomentEdit(migrateProject(project), index, edit.image_prompt, options.moment, now);
  }

  if (project.kind === "clip") {
    if (!edit.image_prompt) return project;
    const image = await generateFrameImage(editInstruction(edit.image_prompt), {
      inputImagePath: options.referenceImagePath ?? frameFilePath(frame.imageUrl),
    });
    const clip = await renderClipFromFrame(image.filename, edit.image_prompt);
    // Only this frame's segment is replaced; the other segments' files are reused as-is and re-concatenated.
    const migrated = migrateProject(project);
    const frames = migrated.frames.map((item) => item.index === index
      ? {
          ...item,
          imageUrl: frameImageUrl(image.filename),
          prompt: edit.image_prompt as string,
          seed: image.seed,
          segmentUrl: videoUrl(clip.videoFilename),
          source: "generated" as const,
        }
      : item);
    const assembled = await assembleClipProject(migrated, frames);
    logInfo("frame_edit_completed", { projectId: project.id, index, segment: clip.videoFilename, video: assembled.videoUrl });
    return { ...assembled, updatedAt: now };
  }

  const validation = validateStoryboard(project.storyboard);
  if (!validation.success) {
    throw new FrameEditError(`Project "${project.id}" has no valid storyboard to re-render (${validation.errors.map((error) => `${error.path}: ${error.message}`).join("; ") || "missing"}).`);
  }
  const current: Storyboard = validation.data;
  const scene = current.scenes[index];
  if (!scene) throw new FrameEditError(`Storyboard for project "${project.id}" has no scene ${index}.`);

  let onScreenText = applySceneText(scene.onScreenText, "top", edit.headline);
  onScreenText = applySceneText(onScreenText, "bottom", edit.sub);
  const updated: Storyboard = {
    ...current,
    scenes: current.scenes.map((item, sceneIndex) => sceneIndex === index
      ? {
          ...item,
          visualPrompt: edit.image_prompt ?? item.visualPrompt,
          narration: edit.narration ?? item.narration,
          onScreenText,
        }
      : item),
  };

  const sceneImagePaths = project.frames.map((item) => frameFilePath(item.imageUrl));
  if (edit.image_prompt) {
    const size = imageSize(updated);
    const image = await generateFrameImage(editInstruction(edit.image_prompt, Boolean(options.referenceImagePath)), {
      width: size.width,
      height: size.height,
      inputImagePath: options.referenceImagePath ?? sceneImagePaths[index],
    });
    sceneImagePaths[index] = frameFilePath(frameImageUrl(image.filename));
  }

  const runId = randomUUID();
  const rendered = await renderStoryboard(updated, runId, { sceneImagePaths });
  logInfo("frame_edit_completed", { projectId: project.id, index, video: rendered.videoFilename });
  return {
    ...project,
    updatedAt: now,
    videoUrl: videoUrl(rendered.videoFilename),
    durationSeconds: rendered.durationSeconds,
    frames: framesFromStoryboard(updated, rendered.imageFilenames),
    storyboard: updated,
  };
}

/**
 * "Edit moment": key frame at the window start → BFL image edit → FLUX 3 i2v → trimmed to the window and spliced into
 * the frame's segment (original audio kept), then the project video is re-concatenated. Other segments are untouched.
 */
async function applyMomentEdit(project: Project, index: number, prompt: string, moment: MomentSpec, now: string) {
  const frame = project.frames[index];
  if (!frame.segmentUrl) throw new FrameEditError(`Frame ${index} of project "${project.id}" has no video segment to edit.`);
  if (moment.range) {
    const problem = validateMomentRange(frame, moment.range.startSec, moment.range.endSec);
    if (problem) throw new FrameEditError(problem);
  }
  const window = moment.range
    ? { startSec: moment.range.startSec, endSec: Math.min(moment.range.endSec, frame.startSec + frame.durationSec) }
    : momentWindow(frame, moment.atSec, moment.windowSec ?? MOMENT_WINDOW.default);
  const localStart = window.startSec - frame.startSec;
  const localEnd = window.endSec - frame.startSec;
  if (localEnd - localStart < 0.2) {
    throw new FrameEditError(`The edit window ${window.startSec}–${window.endSec}s is too short to regenerate.`);
  }
  const segmentPath = videoFilePath(frame.segmentUrl);
  logInfo("moment_edit_started", { projectId: project.id, index, startSec: window.startSec, endSec: window.endSec });

  // Pin the ORIGINAL frames at both ends so the new piece joins the video seamlessly, and the EDITED moment in between.
  const length = localEnd - localStart;
  const momentLocal = Math.min(Math.max(moment.atSec - frame.startSec, localStart), localEnd - 1 / 30);
  const [startFrame, endFrame, momentFrame] = await Promise.all([
    extractFrameAt(segmentPath, localStart),
    extractFrameAt(segmentPath, Math.max(localStart, localEnd - 1 / 30)),
    extractFrameAt(segmentPath, momentLocal),
  ]);
  const image = await generateFrameImage(editInstruction(prompt), { inputImagePath: frameFilePath(frameImageUrl(momentFrame)) });
  const editedPath = frameFilePath(frameImageUrl(image.filename));
  const pins = length >= 0.6
    ? [
        { atSec: 0, imagePath: frameFilePath(frameImageUrl(startFrame)) },
        { atSec: Math.min(0.8 * length, Math.max(0.2 * length, momentLocal - localStart)), imagePath: editedPath },
        { atSec: length, imagePath: frameFilePath(frameImageUrl(endFrame)) },
      ]
    : [
        { atSec: 0, imagePath: editedPath },
        { atSec: length, imagePath: frameFilePath(frameImageUrl(endFrame)) },
      ];
  const clip = await renderPinnedClip({ prompt, pins, lengthSec: length });
  logInfo("moment_edit_clip_rendered", { projectId: project.id, index, timestamps: clip.timestampFormat, pins: pins.length, lengthSec: Math.round(length * 1000) / 1000 });
  const spliced = await spliceWindow(segmentPath, videoFilePath(videoUrl(clip.videoFilename)), localStart, localEnd);

  // The key image only changes when the edited frame itself opens the segment (short windows at the segment start).
  const startsSegment = localStart < 0.5 / 30 && length < 0.6;
  const frames = project.frames.map((item) => item.index === index
    ? {
        ...item,
        segmentUrl: videoUrl(spliced.filename),
        ...(startsSegment ? { imageUrl: frameImageUrl(image.filename), prompt, seed: image.seed } : {}),
        edits: [...(item.edits ?? []), { atSec: moment.atSec, ...(moment.range ? {} : { windowSec: moment.windowSec ?? MOMENT_WINDOW.default }), ...window, prompt, at: now }],
      }
    : item);
  const assembled = await assembleClipProject(project, frames);
  logInfo("moment_edit_completed", { projectId: project.id, index, segment: spliced.filename, video: assembled.videoUrl, durationSeconds: assembled.durationSeconds });
  return { ...assembled, updatedAt: now };
}
