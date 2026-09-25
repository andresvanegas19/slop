import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Storyboard } from "@/lib/storyboard";

export type ProjectFrame = {
  index: number;
  imageUrl: string;
  prompt: string;
  startSec: number;
  durationSec: number;
  narration?: string;
  headline?: string;
  sub?: string;
  /** BFL seed used for this frame, when known (reused for edits). */
  seed?: number;
  /** Clip projects: this frame's own video segment (/api/videos/…); the project video is the concat of all segments. */
  segmentUrl?: string;
  /** Clip projects: whether the segment was generated (FLUX), uploaded by the user, or copied from another project's video. */
  source?: "generated" | "upload" | "project";
  /** Clip projects: "Edit moment" edits spliced into this segment (project-time window), for timeline markers. */
  edits?: FrameMomentEdit[];
};

export type FrameMomentEdit = {
  /** Project time the user grabbed. */
  atSec: number;
  /** Requested half-width ([atSec − windowSec, atSec + windowSec] clamped to the segment); absent for dragged ranges. */
  windowSec?: number;
  /** Actual replaced window, in project time. */
  startSec: number;
  endSec: number;
  prompt: string;
  at: string;
};

export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  at: string;
  edited?: boolean;
  /** Video time the user grabbed the frame at (user messages). */
  atSec?: number;
  /** Project-time window actually edited/selected for this turn (range or ±windowSec), on user and assistant entries. */
  rangeStartSec?: number;
  rangeEndSec?: number;
  /** Frame grabbed from the video at `atSec`, used as the reference image for this turn. */
  grabbedFrameUrl?: string;
  /** Enhanced image prompt used for the edit (assistant messages). */
  enhancedPrompt?: string;
  /** Titles of the RAG guidance documents used for this turn (assistant messages). */
  ragSources?: string[];
  /** /command turns: the action that was run (assistant messages). */
  action?: string;
  /** /command turns: one-line description of what happened (assistant messages). */
  summary?: string;
};

export type Project = {
  id: string;
  kind: "clip" | "storyboard";
  title: string;
  createdAt: string;
  updatedAt: string;
  videoUrl: string;
  durationSeconds: number;
  frames: ProjectFrame[];
  /** key = frame index (as a string) */
  chats: Record<string, ChatMessage[]>;
  /** Normalized (validated) storyboard used to re-render storyboard projects. */
  storyboard?: unknown;
  /** Company-research session this video was generated from (generate-preset `researchSessionId`). */
  researchSessionId?: string;
  /** Last RawTree publish of the project video (src/lib/video-store.ts). */
  published?: {
    sha256: string;
    at: string;
    status: "ok" | "failed";
    videoUrl: string;
    chunksWritten?: number;
    chunkCount?: number;
    note?: string;
    error?: string;
  };
};

export class ProjectNotFoundError extends Error {}

const PROJECT_ID = /^[a-zA-Z0-9_-]+$/;

export function isValidProjectId(id: string) {
  return PROJECT_ID.test(id) && id.length <= 128;
}

function projectsDirectory() {
  return path.join(process.cwd(), "output", "projects");
}

function projectPath(id: string) {
  if (!isValidProjectId(id)) throw new ProjectNotFoundError(`Project id "${id}" is invalid; ids may only contain letters, digits, "_" and "-".`);
  return path.join(projectsDirectory(), `${id}.json`);
}

export function frameImageUrl(filename: string) {
  return `/api/assets/${filename}`;
}

export function videoUrl(filename: string) {
  return `/api/videos/${filename}`;
}

/** Resolves an `/api/assets/<file>.png` URL to the file on disk (output/frames). */
export function frameFilePath(imageUrl: string) {
  const filename = imageUrl.split("/").pop() ?? "";
  if (!/^[a-zA-Z0-9_-]+\.png$/.test(filename)) throw new Error(`Frame image URL "${imageUrl}" does not point to a served frame.`);
  return path.join(process.cwd(), "output", "frames", filename);
}

export function titleFromPrompt(prompt: string, words = 6) {
  const parts = prompt.trim().split(/\s+/);
  const title = parts.slice(0, words).join(" ");
  return parts.length > words ? `${title}…` : title;
}

export async function saveProject(project: Project) {
  await mkdir(projectsDirectory(), { recursive: true });
  const target = projectPath(project.id);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(project, null, 2), { mode: 0o600 });
  await rename(temporary, target);
  return project;
}

export async function loadProject(id: string): Promise<Project> {
  const file = projectPath(id);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      throw new ProjectNotFoundError(`Project "${id}" was not found (no output/projects/${id}.json on the server).`);
    }
    throw error;
  }
  try {
    return migrateProject(JSON.parse(raw) as Project);
  } catch (error) {
    throw new Error(`Project file output/projects/${id}.json is corrupt and could not be parsed.`, { cause: error });
  }
}

/**
 * Lazy migration: single-frame clip projects created before segments existed use the project video as frame 0's
 * segment.
 */
export function migrateProject(project: Project): Project {
  if (project.kind !== "clip" || project.frames.every((frame) => frame.segmentUrl)) return project;
  if (project.frames.length === 1) {
    const [frame] = project.frames;
    return {
      ...project,
      frames: [{ ...frame, segmentUrl: project.videoUrl, source: frame.source ?? "generated", startSec: 0, durationSec: project.durationSeconds }],
    };
  }
  return project;
}

export async function createProject(input: Omit<Project, "id" | "createdAt" | "updatedAt" | "chats"> & { id?: string }) {
  const now = new Date().toISOString();
  const project: Project = {
    ...input,
    id: input.id ?? randomUUID(),
    createdAt: now,
    updatedAt: now,
    chats: {},
  };
  return saveProject(project);
}

/** Frames for a storyboard project: one per scene, using the rendered image filenames. */
export function framesFromStoryboard(storyboard: Storyboard, imageFilenames: string[]): ProjectFrame[] {
  return storyboard.scenes.map((scene, index) => {
    const headline = scene.onScreenText.find((text) => text.position === "top")?.text
      ?? scene.onScreenText.find((text) => text.position === "center")?.text;
    const sub = scene.onScreenText.find((text) => text.position === "bottom")?.text;
    return {
      index,
      imageUrl: frameImageUrl(imageFilenames[index]),
      prompt: scene.visualPrompt,
      startSec: scene.timing.startMs / 1000,
      durationSec: scene.timing.durationMs / 1000,
      narration: scene.narration,
      ...(headline ? { headline } : {}),
      ...(sub ? { sub } : {}),
      ...(storyboard.style.seed === undefined ? {} : { seed: storyboard.style.seed }),
    };
  });
}

// Serializes edits per project so two concurrent edits don't overwrite each other.
const locks = new Map<string, Promise<unknown>>();

export async function withProjectLock<T>(id: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  locks.set(id, next);
  try {
    return await next;
  } finally {
    if (locks.get(id) === next) locks.delete(id);
  }
}
