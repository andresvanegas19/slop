import { NextResponse } from "next/server";
import { logUserPrompt } from "@/lib/user-prompts";
import { streamable } from "@/lib/ndjson";
import { clampWindowSec } from "@/lib/project-edit";
import { actionErrorResponse, askFrame } from "@/lib/project-actions";
import { logException } from "@/lib/runtime-log";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_MESSAGE_LENGTH = 4_000;

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

/**
 * POST `{ message, atSec?, windowSec? }` → `{ reply, edited, project, ragSources, grabbedFrameUrl?, enhancedPrompt?, window? }`.
 * Clip projects with `atSec`: an image edit only regenerates [atSec − windowSec, atSec + windowSec] (default 1s each
 * side, clamped 0.5–1.5 and to the frame's segment), or exactly [rangeStartSec, rangeEndSec) when a dragged range is sent
 * (0.3–3s, inside this frame's segment; atSec defaults to its midpoint). `window` is the edited range in project time.
 * Answers about the frame, or edits it and re-renders the video. With `atSec`, the exact video frame at that time
 * is grabbed and used as the reference image (for the model and for the BFL edit).
 */
async function handlePost(request: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  const { id, index: rawIndex } = await params;
  try {
    const body = await request.json().catch(() => ({})) as {
      message?: unknown; atSec?: unknown; windowSec?: unknown; rangeStartSec?: unknown; rangeEndSec?: unknown;
    };
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message || message.length > MAX_MESSAGE_LENGTH) {
      return badRequest(`A message between 1 and ${MAX_MESSAGE_LENGTH} characters is required.`);
    }
    if (body.atSec !== undefined && body.atSec !== null && (typeof body.atSec !== "number" || !Number.isFinite(body.atSec))) {
      return badRequest(`"atSec" must be a finite number of seconds (got ${JSON.stringify(body.atSec)}).`);
    }
    const present = (value: unknown) => value !== undefined && value !== null;
    if (present(body.rangeStartSec) !== present(body.rangeEndSec)) {
      return badRequest("Send both \"rangeStartSec\" and \"rangeEndSec\" (project seconds) to edit a dragged range, or neither.");
    }
    let range: { startSec: number; endSec: number } | undefined;
    if (present(body.rangeStartSec)) {
      if (typeof body.rangeStartSec !== "number" || !Number.isFinite(body.rangeStartSec) || typeof body.rangeEndSec !== "number" || !Number.isFinite(body.rangeEndSec)) {
        return badRequest(`"rangeStartSec" and "rangeEndSec" must be finite numbers of seconds (got ${JSON.stringify(body.rangeStartSec)} and ${JSON.stringify(body.rangeEndSec)}).`);
      }
      if (!(body.rangeStartSec < body.rangeEndSec)) {
        return badRequest(`rangeStartSec (${body.rangeStartSec}) must be less than rangeEndSec (${body.rangeEndSec}).`);
      }
      range = { startSec: Math.round(body.rangeStartSec * 1000) / 1000, endSec: Math.round(body.rangeEndSec * 1000) / 1000 };
    }
    // With a range, atSec (the moment shown to the model) defaults to the range midpoint.
    const atSec = typeof body.atSec === "number"
      ? body.atSec
      : range ? Math.round(((range.startSec + range.endSec) / 2) * 1000) / 1000 : undefined;
    if (range && atSec !== undefined && (atSec < range.startSec || atSec >= range.endSec)) {
      return badRequest(`atSec ${atSec} must lie inside the selected range ${range.startSec}–${range.endSec}s.`);
    }
    if (body.windowSec !== undefined && body.windowSec !== null && (typeof body.windowSec !== "number" || !Number.isFinite(body.windowSec) || body.windowSec <= 0)) {
      return badRequest(`"windowSec" must be a positive number of seconds (got ${JSON.stringify(body.windowSec)}).`);
    }
    const windowSec = clampWindowSec(body.windowSec);

    const index = Number(rawIndex);
    if (!/^\d+$/.test(rawIndex) || !Number.isSafeInteger(index)) {
      return NextResponse.json({ error: `Frame index "${rawIndex}" is not a non-negative integer.` }, { status: 404 });
    }
    return NextResponse.json(await askFrame({ projectId: id, index, message, atSec, windowSec, range }));
  } catch (error) {
    const { status, message } = actionErrorResponse(error, "The frame assistant could not handle this message.");
    logException("frame_ask_failed", error, { projectId: id, frame: rawIndex, status, reason: message });
    return NextResponse.json({ error: message }, { status });
  }
}

/** Same as above; `Accept: application/x-ndjson` (or ?stream=1) streams progress events, then {"type":"done", …body}. */
export const POST = logUserPrompt("ask", streamable(handlePost));
