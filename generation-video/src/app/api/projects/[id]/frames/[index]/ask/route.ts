import path from "node:path";
import { NextResponse } from "next/server";
import { BflError, describeError } from "@/lib/bfl";
import { decideFrameChat } from "@/lib/frame-chat";
import { frameAt, FrameGrabError, grabVideoFrame } from "@/lib/frame-grab";
import { OpenRouterConfigurationError, OpenRouterError } from "@/lib/openrouter";
import { ClipProjectError } from "@/lib/clip-project";
import { SegmentError } from "@/lib/segments";
import { applyFrameEdit, clampWindowSec, FrameEditError, momentWindow, validateMomentRange } from "@/lib/project-edit";
import { frameImageUrl, loadProject, ProjectNotFoundError, saveProject, withProjectLock, type ChatMessage } from "@/lib/projects";
import { enhanceImagePrompt } from "@/lib/prompt-enhance";
import { recordEditExample, retrieveContext, type RagContext } from "@/lib/rag";
import { logException, logInfo } from "@/lib/runtime-log";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_MESSAGE_LENGTH = 4_000;
/** Keeps the system prompt small enough for the 2.6B default model. */
const GUIDANCE_MAX_CHARS = 1_600;

function statusFor(error: unknown) {
  if (error instanceof ProjectNotFoundError) return 404;
  if (error instanceof OpenRouterConfigurationError) return 503;
  if (error instanceof FrameEditError || error instanceof SegmentError || error instanceof ClipProjectError) return 422;
  if ((error instanceof BflError || error instanceof OpenRouterError) && error.status && error.status >= 400 && error.status < 500) {
    return error.status;
  }
  return 502;
}

/**
 * Drops storyboard-only guidance (e.g. the storyboard house-style prefix) for clip projects: the small model tends to
 * paste it into the clip's prompt and change its style. retrieveContext formats one "[n] Title: body" line per source.
 */
function relevantGuidance(rag: RagContext, kind: "clip" | "storyboard") {
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
export async function POST(request: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
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

    const project = await loadProject(id);
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || !project.frames.some((frame) => frame.index === index)) {
      return NextResponse.json({ error: `Frame ${rawIndex} does not exist in project "${id}" (it has ${project.frames.length} frame(s)).` }, { status: 404 });
    }

    if (range) {
      if (project.kind !== "clip") return badRequest("Range edits are only supported for clip projects; storyboard frames are edited per scene.");
      const frameForRange = project.frames.find((item) => item.index === index)!;
      const problem = validateMomentRange(frameForRange, range.startSec, range.endSec);
      if (problem) {
        const owner = frameAt(project, (range.startSec + range.endSec) / 2);
        return badRequest(owner && owner.index !== index && !validateMomentRange(owner, range.startSec, range.endSec)
          ? `The range ${range.startSec}–${range.endSec}s is in frame ${owner.index}, not frame ${index}; post to /api/projects/${id}/frames/${owner.index}/ask instead.`
          : problem);
      }
    }

    let grabbedFrameUrl: string | undefined;
    let referenceImagePath: string | undefined;
    if (atSec !== undefined) {
      if (atSec < 0 || atSec >= project.durationSeconds) {
        return badRequest(`atSec ${atSec} is outside the video; it must be ≥ 0 and < ${project.durationSeconds} (the project's duration in seconds).`);
      }
      const owner = frameAt(project, atSec);
      if (!owner || owner.index !== index) {
        return badRequest(owner
          ? `atSec ${atSec} falls in frame ${owner.index} (${owner.startSec}s–${owner.startSec + owner.durationSec}s), not frame ${index}; post to /api/projects/${id}/frames/${owner.index}/ask instead.`
          : `No frame covers atSec ${atSec} in project "${id}".`);
      }
      const filename = await grabVideoFrame(project, atSec);
      grabbedFrameUrl = frameImageUrl(filename);
      referenceImagePath = path.join(process.cwd(), "output", "frames", filename);
    }

    logInfo("frame_ask_started", { projectId: id, frame: index, messageLength: message.length, atSec });
    const frame = project.frames.find((item) => item.index === index)!;
    const rag = relevantGuidance(await retrieveContext(
      [message, frame.prompt, frame.headline, frame.narration].filter(Boolean).join("\n"),
      { k: 3, maxChars: GUIDANCE_MAX_CHARS, tags: ["editing", "flux", project.kind === "storyboard" ? "storyboard" : "motion"] },
    ), project.kind);
    const ragSources = [...new Set(rag.sources.map((source) => source.title))];
    const decision = await decideFrameChat(project, index, message, { referenceImagePath, atSec, guidance: rag.text });

    // Image edits get a focused second call that expands the user's instruction into a detailed prompt.
    let enhancedPrompt: string | undefined;
    if (decision.edit?.image_prompt) {
      const enhanced = await enhanceImagePrompt({ project, index, instruction: message, draftPrompt: decision.edit.image_prompt, referenceImagePath, guidance: rag.text });
      enhancedPrompt = enhanced.prompt;
      decision.edit = { ...decision.edit, image_prompt: enhanced.prompt };
      logInfo("frame_ask_prompt_enhanced", { projectId: id, frame: index, source: enhanced.source, length: enhanced.prompt.length });
    }

    let window: { startSec: number; endSec: number } | undefined;
    const result = await withProjectLock(id, async () => {
      // Reload inside the lock so a concurrent edit isn't overwritten.
      let current = await loadProject(id);
      const edited = Boolean(decision.edit);
      // Clip projects + a grabbed moment: only ±windowSec around it is regenerated ("Edit moment").
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
      const thread: ChatMessage[] = [
        ...(current.chats[key] ?? []),
        { role: "user", text: message, at: now, ...(atSec === undefined ? {} : { atSec }), ...(grabbedFrameUrl ? { grabbedFrameUrl } : {}) },
        {
          role: "assistant",
          text: decision.reply,
          at: now,
          ...(edited ? { edited: true } : {}),
          ...(enhancedPrompt ? { enhancedPrompt } : {}),
          ...(ragSources.length ? { ragSources } : {}),
        },
      ];
      current = { ...current, chats: { ...current.chats, [key]: thread }, updatedAt: now };
      await saveProject(current);
      return { reply: decision.reply, edited, project: current };
    });

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
    return NextResponse.json({
      ...result,
      ragSources,
      ...(grabbedFrameUrl ? { grabbedFrameUrl } : {}),
      ...(enhancedPrompt ? { enhancedPrompt } : {}),
      ...(window && result.edited ? { window } : {}),
    });
  } catch (error) {
    const status = error instanceof FrameGrabError ? 422 : statusFor(error);
    const message = error instanceof ProjectNotFoundError || error instanceof OpenRouterConfigurationError || error instanceof FrameGrabError
      ? error.message
      : describeError(error, "The frame assistant could not handle this message.");
    logException("frame_ask_failed", error, { projectId: id, frame: rawIndex, status, reason: message });
    return NextResponse.json({ error: message }, { status });
  }
}
