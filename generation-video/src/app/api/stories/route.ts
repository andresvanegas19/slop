import { withRouteLog } from "@/lib/route-log";
import { NextResponse } from "next/server";
import { describeError } from "@/lib/bfl";
import { streamable } from "@/lib/ndjson";
import { emitStage } from "@/lib/progress";
import { logException, logInfo } from "@/lib/runtime-log";
import { STORY_COUNTS, STORY_DURATIONS, createStorySet, publicStory, type StoryCount, type StoryDuration } from "@/lib/stories";
import { jobable } from "@/lib/job-route";

export const runtime = "nodejs";

const MAX_PROMPT_LENGTH = 2_000;

function responseError(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

/**
 * POST `{ prompt, count?: 3 | 4, durationSec?: 5 | 10, aspect?: "16:9" }` → `{ storySetId, stories, callCounts, elapsedMs }`.
 * Writes `count` different 3-beat stories and one realistic still per beat. With `Accept: application/x-ndjson`
 * (or ?stream=1) it streams `story` events as each story is written and `preview` events (storyId + beat) per still.
 */
async function handlePost(request: Request) {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await request.text());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return responseError("Request body must be a JSON object.", 400);
    body = parsed as Record<string, unknown>;
  } catch {
    return responseError('Malformed JSON: send a body like {"prompt":"..."}.', 400);
  }
  if (typeof body.prompt !== "string" || !body.prompt.trim()) return responseError('"prompt" is required.', 400);
  const prompt = body.prompt.trim();
  if (prompt.length > MAX_PROMPT_LENGTH) return responseError(`"prompt" is too long (limit ${MAX_PROMPT_LENGTH} characters).`, 400);
  const count = body.count === undefined ? 3 : body.count;
  if (!(STORY_COUNTS as readonly unknown[]).includes(count)) return responseError('"count" must be 3 or 4.', 400);
  const durationSec = body.durationSec === undefined ? 5 : body.durationSec;
  if (!(STORY_DURATIONS as readonly unknown[]).includes(durationSec)) return responseError('"durationSec" must be 5 or 10.', 400);
  if (body.aspect !== undefined && body.aspect !== "16:9") {
    return responseError('"aspect" must be "16:9": story videos become editable clip projects, whose segments are 1280x720.', 400);
  }

  try {
    emitStage("prompt", `Writing ${count} different stories…`);
    const { set, callCounts, elapsedMs } = await createStorySet({ prompt, count: count as StoryCount, durationSec: durationSec as StoryDuration });
    logInfo("stories_created", { setId: set.id, stories: set.stories.length, images: callCounts.images, elapsedMs });
    return NextResponse.json({
      storySetId: set.id,
      durationSec: set.durationSec,
      stories: set.stories.map(publicStory),
      memorySources: set.memorySources,
      callCounts,
      elapsedMs,
    });
  } catch (error) {
    const message = describeError(error, "Unable to write the stories.");
    logException("stories_failed", error, { message });
    return responseError(message, 502);
  }
}

export const POST = withRouteLog(jobable("stories", streamable(handlePost)));
