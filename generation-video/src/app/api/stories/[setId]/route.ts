import { withRouteLog } from "@/lib/route-log";
import { NextResponse } from "next/server";
import { StoryError, loadStorySet, publicStory } from "@/lib/stories";

export const runtime = "nodejs";

/** GET → the saved story set `{ storySetId, prompt, durationSec, stories, renders }`. */
async function routeGET(_request: Request, { params }: { params: Promise<{ setId: string }> }) {
  const { setId } = await params;
  try {
    const set = await loadStorySet(setId);
    return NextResponse.json({ storySetId: set.id, prompt: set.prompt, durationSec: set.durationSec, stories: set.stories.map(publicStory), renders: set.renders });
  } catch (error) {
    const status = error instanceof StoryError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}

export const GET = withRouteLog(routeGET);
