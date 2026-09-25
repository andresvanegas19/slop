import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { assembleClipProject } from "@/lib/clip-project";
import { frameImageUrl, videoUrl, type FrameMomentEdit, type Project, type ProjectFrame } from "@/lib/projects";
import {
  extractFirstFrame,
  normalizeSegment,
  probeMedia,
  SEGMENT_FORMAT,
  SegmentError,
  videoDurationSeconds,
  videoFilePath,
  videosDirectory,
} from "@/lib/segments";

export const MIN_PROJECT_SECONDS = 0.3;

export class TimelineError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const round = (value: number) => Math.round(value * 1000) / 1000;

function runFfmpeg(args: string[], action: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => reject(new SegmentError(`ffmpeg is unavailable (${error.message}).`)));
    child.on("close", (code) => code === 0 ? resolve() : reject(new SegmentError(`ffmpeg could not ${action}: ${stderr.trim().slice(-500) || `exit code ${code}`}`)));
  });
}

/**
 * Keeps only the given local [start, end) pieces of a segment (frame-accurate re-encode of picture AND audio, so they
 * stay in sync) and joins them into one new normalized segment in output/videos.
 */
async function keepPieces(segmentPath: string, pieces: { start: number; end: number }[]) {
  const info = await probeMedia(segmentPath);
  const { width, height, fps, sampleRate } = SEGMENT_FORMAT;
  const normalize = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p`;
  const total = await videoDurationSeconds(segmentPath);
  const filters: string[] = [`[0:v]${normalize},split=${pieces.length}${pieces.map((_, index) => `[vs${index}]`).join("")}`];
  filters.push(info.hasAudio
    ? `[0:a]aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${total.toFixed(3)},asplit=${pieces.length}${pieces.map((_, index) => `[as${index}]`).join("")}`
    : `anullsrc=r=${sampleRate}:cl=stereo,atrim=duration=${total.toFixed(3)},asplit=${pieces.length}${pieces.map((_, index) => `[as${index}]`).join("")}`);
  const labels: string[] = [];
  pieces.forEach((piece, index) => {
    const end = piece.end >= total - 0.5 / fps ? "" : `:end=${piece.end.toFixed(3)}`;
    filters.push(`[vs${index}]trim=start=${piece.start.toFixed(3)}${end},setpts=PTS-STARTPTS[v${index}]`);
    filters.push(`[as${index}]atrim=start=${piece.start.toFixed(3)}${end},asetpts=PTS-STARTPTS[a${index}]`);
    labels.push(`[v${index}][a${index}]`);
  });
  filters.push(`${labels.join("")}concat=n=${pieces.length}:v=1:a=1[v][a]`);

  await mkdir(videosDirectory(), { recursive: true });
  const id = randomUUID();
  const temporary = path.join(videosDirectory(), `${id}.tmp.mp4`);
  try {
    await runFfmpeg([
      "-y", "-i", segmentPath, "-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(fps),
      "-c:a", "aac", "-b:a", "128k", "-ar", String(sampleRate), "-ac", "2", "-movflags", "+faststart", temporary,
    ], "trim the segment");
    await rename(temporary, path.join(videosDirectory(), `${id}.mp4`));
  } finally {
    await rm(temporary, { force: true });
  }
  return `${id}.mp4`;
}

type LocalEdit = Omit<FrameMomentEdit, "atSec" | "startSec" | "endSec"> & { atLocal: number; startLocal: number; endLocal: number };

function toLocal(frame: ProjectFrame): LocalEdit[] {
  return (frame.edits ?? []).map(({ atSec, startSec, endSec, ...rest }) => ({
    ...rest,
    atLocal: atSec - frame.startSec,
    startLocal: startSec - frame.startSec,
    endLocal: endSec - frame.startSec,
  }));
}

function toProject(edits: LocalEdit[], frame: ProjectFrame): FrameMomentEdit[] {
  return edits.map(({ atLocal, startLocal, endLocal, ...rest }) => ({
    ...rest,
    atSec: round(frame.startSec + atLocal),
    startSec: round(frame.startSec + startLocal),
    endSec: round(frame.startSec + endLocal),
  }));
}

/** Reassembles after an operation and re-expresses each frame's `edits[]` in the new project time. */
async function reassemble(project: Project, frames: (ProjectFrame & { localEdits: LocalEdit[] })[]) {
  const assembled = await assembleClipProject(project, frames.map((frame) => {
    const { localEdits, ...rest } = frame;
    void localEdits;
    return rest;
  }));
  return {
    ...assembled,
    frames: assembled.frames.map((frame, index) => {
      const edits = toProject(frames[index].localEdits, frame);
      const { edits: previous, ...rest } = frame;
      void previous;
      return edits.length ? { ...rest, edits } : rest;
    }),
  };
}

/** Re-keys chats (keyed by frame index) after frames were removed; `keptOldIndexes[newIndex] = oldIndex`. */
function remapChats(chats: Project["chats"], keptOldIndexes: number[]) {
  const result: Project["chats"] = {};
  keptOldIndexes.forEach((oldIndex, newIndex) => {
    const thread = chats[String(oldIndex)];
    if (thread) result[String(newIndex)] = thread;
  });
  return result;
}

function requireClip(project: Project, action: string) {
  if (project.kind !== "clip") throw new TimelineError(`${action} isn't supported for storyboard projects.`, 422);
  const missing = project.frames.find((frame) => !frame.segmentUrl);
  if (missing) throw new TimelineError(`Frame ${missing.index} of project "${project.id}" has no video segment.`, 422);
}

/** Removes project-time [startSec, endSec) (may span segments); returns the reassembled project. */
export async function cutRange(project: Project, startSec: number, endSec: number): Promise<Project> {
  requireClip(project, "Cutting");
  const start = Math.max(0, round(startSec));
  const end = Math.min(project.durationSeconds, round(endSec));
  if (!(start < end)) throw new TimelineError(`The range ${startSec}–${endSec}s doesn't overlap the ${project.durationSeconds}s video.`, 400);
  const remaining = project.durationSeconds - (end - start);
  if (remaining < MIN_PROJECT_SECONDS) {
    throw new TimelineError(`Cutting ${start}–${end}s would leave ${round(remaining)}s; at least ${MIN_PROJECT_SECONDS}s must remain.`, 400);
  }

  const frames: (ProjectFrame & { localEdits: LocalEdit[] })[] = [];
  for (const frame of project.frames) {
    const frameEnd = frame.startSec + frame.durationSec;
    const localStart = Math.max(0, start - frame.startSec);
    const localEnd = Math.min(frame.durationSec, end - frame.startSec);
    const edits = toLocal(frame);
    if (localEnd <= localStart || end <= frame.startSec || start >= frameEnd) {
      frames.push({ ...frame, localEdits: edits }); // untouched
      continue;
    }
    const pieces = [
      ...(localStart > 0.5 / SEGMENT_FORMAT.fps ? [{ start: 0, end: localStart }] : []),
      ...(localEnd < frame.durationSec - 0.5 / SEGMENT_FORMAT.fps ? [{ start: localEnd, end: frame.durationSec }] : []),
    ];
    if (pieces.length === 0) continue; // segment fully inside the cut

    const removed = localEnd - localStart;
    const shift = (time: number) => time <= localStart ? time : time >= localEnd ? time - removed : localStart;
    const localEdits = edits
      .map((edit) => ({ ...edit, atLocal: shift(edit.atLocal), startLocal: shift(edit.startLocal), endLocal: shift(edit.endLocal) }))
      .filter((edit) => edit.endLocal - edit.startLocal > 0.001);
    const filename = await keepPieces(videoFilePath(frame.segmentUrl as string), pieces);
    // If the segment's opening was cut, its key image must be the new first frame.
    const imageUrl = pieces[0].start > 0 ? frameImageUrl(await extractFirstFrame(videoFilePath(videoUrl(filename)))) : frame.imageUrl;
    frames.push({ ...frame, imageUrl, segmentUrl: videoUrl(filename), localEdits });
  }
  const assembled = await reassemble(project, frames);
  return { ...assembled, chats: remapChats(project.chats, frames.map((frame) => frame.index)) };
}

/** Removes one frame's segment and reassembles. */
export async function removeFrame(project: Project, index: number): Promise<Project> {
  requireClip(project, "Removing shots");
  if (!project.frames.some((frame) => frame.index === index)) {
    throw new TimelineError(`Frame ${index} does not exist in project "${project.id}" (it has ${project.frames.length} frame(s)).`, 404);
  }
  if (project.frames.length <= 1) throw new TimelineError("A project needs at least one shot; this is the only one.", 400);
  const frames = project.frames
    .filter((frame) => frame.index !== index)
    .map((frame) => ({ ...frame, localEdits: toLocal(frame) }));
  const assembled = await reassemble(project, frames);
  return { ...assembled, chats: remapChats(project.chats, frames.map((frame) => frame.index)) };
}

/** Appends a video file (e.g. another project's rendered video) as a new normalized segment. */
export async function appendVideoFile(project: Project, filePath: string, frame: Pick<ProjectFrame, "prompt" | "source">): Promise<Project> {
  requireClip(project, "Appending");
  const segment = await normalizeSegment(filePath);
  const thumb = await extractFirstFrame(videoFilePath(videoUrl(segment.filename)));
  const frames = [
    ...project.frames.map((item) => ({ ...item, localEdits: toLocal(item) })),
    {
      index: project.frames.length,
      imageUrl: frameImageUrl(thumb),
      prompt: frame.prompt,
      startSec: project.durationSeconds,
      durationSec: segment.durationSeconds,
      segmentUrl: videoUrl(segment.filename),
      source: frame.source,
      localEdits: [],
    },
  ];
  return reassemble(project, frames);
}
