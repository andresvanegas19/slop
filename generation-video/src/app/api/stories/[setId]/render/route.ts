import { NextResponse } from "next/server";
import { describeError, isVideoQuality, videoQuality } from "@/lib/bfl";
import { streamable } from "@/lib/ndjson";
import { emitStage } from "@/lib/progress";
import { logException, logInfo } from "@/lib/runtime-log";
import { STORY_DURATIONS, StoryError, isStorySetId, renderStories, type StoryDuration } from "@/lib/stories";

export const runtime = "nodejs";

function responseError(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

/**
 * POST `{ storyIds: string[], durationSec?: 5 | 10, quality?: "final" | "draft" }` → `{ projects, results }`.
 * Each chosen story becomes ONE continuous FLUX 3 image-to-video shot with its three stills pinned at 0, d/2 and d,
 * saved as a `kind: "clip"` project (one segment per beat). Streams `story_status` events per story.
 */
async function handlePost(request: Request, { params }: { params: Promise<{ setId: string }> }) {
  const { setId } = await params;
  if (!isStorySetId(setId)) return responseError(`Story set id "${setId}" is invalid.`, 400);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await request.text());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return responseError("Request body must be a JSON object.", 400);
    body = parsed as Record<string, unknown>;
  } catch {
    return responseError('Malformed JSON: send a body like {"storyIds":["story_…"]}.', 400);
  }
  const storyIds = body.storyIds;
  if (!Array.isArray(storyIds) || storyIds.length === 0 || storyIds.length > 4 || !storyIds.every((id) => typeof id === "string" && /^story_[A-Za-z0-9-]{1,64}$/.test(id))) {
    return responseError('"storyIds" must be 1 to 4 story ids from POST /api/stories.', 400);
  }
  if (body.durationSec !== undefined && !(STORY_DURATIONS as readonly unknown[]).includes(body.durationSec)) return responseError('"durationSec" must be 5 or 10.', 400);
  if (body.quality !== undefined && !isVideoQuality(body.quality)) return responseError('"quality" must be "final" or "draft".', 400);

  try {
    emitStage("video", `Rendering ${storyIds.length} ${storyIds.length === 1 ? "story" : "stories"}…`);
    const { results, elapsedMs } = await renderStories({
      setId,
      storyIds: [...new Set(storyIds as string[])],
      durationSec: body.durationSec as StoryDuration | undefined,
      quality: videoQuality("storyboard", body.quality),
    });
    const projects = results.flatMap((result) => "project" in result && result.project ? [result.project] : []);
    logInfo("stories_rendered", { setId, requested: storyIds.length, rendered: projects.length, elapsedMs });
    if (projects.length === 0) {
      const first = results.find((result) => "error" in result);
      return responseError(first && "error" in first ? String(first.error) : "No story could be rendered.", 502);
    }
    return NextResponse.json({
      projects,
      results: results.map((result) => ({
        storyId: result.storyId,
        elapsedMs: result.elapsedMs,
        ...("project" in result && result.project ? { projectId: result.project.id, videoUrl: result.project.videoUrl, hiResVideoUrl: result.render?.hiResVideoUrl, pins: result.render?.pins, bfl: result.render?.bfl, delivered: result.delivered } : {}),
        ...("error" in result ? { error: result.error } : {}),
      })),
      elapsedMs,
    });
  } catch (error) {
    const status = error instanceof StoryError ? error.status : 502;
    const message = describeError(error, "Unable to render the stories.");
    logException("stories_render_failed", error, { setId, status, message });
    return responseError(message, status);
  }
}

export const POST = streamable(handlePost);
