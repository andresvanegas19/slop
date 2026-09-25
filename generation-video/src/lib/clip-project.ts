import { frameImageUrl, videoUrl, type Project, type ProjectFrame } from "@/lib/projects";
import { concatSegments, extractFirstFrame, normalizeSegment, videoDurationSeconds, videoFilePath } from "@/lib/segments";

export class ClipProjectError extends Error {}

/**
 * Rebuilds a clip project's video from its frames' segments (in order) and recomputes cumulative frame timing
 * from the exact segment durations. A single segment is used as-is; several are normalized + concatenated.
 */
export async function assembleClipProject(project: Project, frames: ProjectFrame[]): Promise<Project> {
  const missing = frames.find((frame) => !frame.segmentUrl);
  if (missing) throw new ClipProjectError(`Frame ${missing.index} of project "${project.id}" has no video segment to assemble.`);
  const paths = frames.map((frame) => videoFilePath(frame.segmentUrl as string));

  let projectVideoUrl: string;
  let durations: number[];
  let total: number;
  if (paths.length === 1) {
    total = await videoDurationSeconds(paths[0]);
    durations = [total];
    projectVideoUrl = frames[0].segmentUrl as string;
  } else {
    const result = await concatSegments(paths);
    projectVideoUrl = videoUrl(result.filename);
    durations = result.segmentDurations;
    total = result.durationSeconds;
  }

  let start = 0;
  const timed = frames.map((frame, index) => {
    const next = { ...frame, index, startSec: Math.round(start * 1000) / 1000, durationSec: durations[index] };
    start += durations[index];
    return next;
  });
  return { ...project, videoUrl: projectVideoUrl, durationSeconds: total, frames: timed, updatedAt: new Date().toISOString() };
}

/** Normalizes an uploaded file into a project segment and builds its frame (first frame as the key image). */
export async function segmentFrameFromUpload(uploadPath: string, prompt: string): Promise<ProjectFrame> {
  const segment = await normalizeSegment(uploadPath);
  const thumb = await extractFirstFrame(videoFilePath(videoUrl(segment.filename)));
  return {
    index: 0,
    imageUrl: frameImageUrl(thumb),
    prompt,
    startSec: 0,
    durationSec: segment.durationSeconds,
    segmentUrl: videoUrl(segment.filename),
    source: "upload",
  };
}
