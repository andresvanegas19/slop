import type { ProgressEvent } from "@/lib/progress";
import { log } from "@/lib/runtime-log";

/**
 * Mirrors the user-visible progress stream (stage labels, detected intent, story status…) into the server log, so the
 * log shows the same flow the UI shows. Called once per event from the outermost withProgress() sink.
 */
export function logProgressEvent(event: ProgressEvent, elapsedMs: number) {
  switch (event.type) {
    case "stage":
      log("info", "progress_stage", { stage: event.stage, label: event.label, atMs: elapsedMs });
      return;
    case "intent":
      log("info", "progress_intent", { action: event.action, detectedBy: event.detectedBy, atEnd: event.atEnd, window: event.window ? `${event.window.startSec}-${event.window.endSec}s` : undefined });
      return;
    case "prompt":
      log("info", "progress_prompt", { enhancedPrompt: event.enhancedPrompt, chars: event.enhancedPrompt.length });
      return;
    case "preview":
      log("debug", "progress_preview", { label: event.label, storyId: event.storyId, beat: event.beat });
      return;
    case "story":
      log("info", "progress_story", { storyId: typeof event.story.id === "string" ? event.story.id : undefined, title: typeof event.story.title === "string" ? event.story.title : undefined });
      return;
    case "story_status":
      log(event.error ? "warn" : "info", "progress_story_status", { storyId: event.storyId, status: event.status, projectId: event.projectId, error: event.error, durationMs: event.elapsedMs });
      return;
    case "progress":
      log("debug", "progress_poll", { stage: event.stage, status: event.status, progress: event.progress, elapsedMs: event.elapsedMs });
      return;
    case "error":
      log("warn", "progress_error", { status: event.status, error: event.error });
      return;
    default:
      // token / memo / bfl_pending / done: too chatty or logged elsewhere.
      return;
  }
}
