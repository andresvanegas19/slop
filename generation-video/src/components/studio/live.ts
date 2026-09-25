/* Folds streamed progress events into the pending operation's LiveProgress (pure; `now` is passed in). */
import type { StreamEvent } from "./ndjson";
import type { LiveProgress } from "./types";
import { formatWindow, isTimeWindow } from "./utils";

const STAGE_LABELS: Record<string, string> = {
  intent: "Understanding your request",
  guidance: "Reading guidance",
  prompt: "Writing the prompt",
  image: "Editing the frame",
  video: "Generating the video",
  splice: "Splicing it in",
  render: "Re-rendering",
  save: "Saving",
};

export function emptyLive(now: number): LiveProgress {
  return { startedAt: now, steps: [], reply: "", enhancedPrompt: "", typing: null };
}

export function reduceLive(live: LiveProgress, event: StreamEvent, now: number): LiveProgress {
  switch (event.type) {
    case "stage": {
      const label = event.label?.trim() || STAGE_LABELS[event.stage] || event.stage;
      const last = live.steps[live.steps.length - 1];
      if (last && last.stage === event.stage) return { ...live, steps: [...live.steps.slice(0, -1), { ...last, label }] };
      return { ...live, steps: [...live.steps, { stage: event.stage, label, at: now }] };
    }
    case "intent":
      return { ...live, intent: { action: event.action, detectedBy: event.detectedBy === "rules" ? "rules" : "llm", atEnd: event.atEnd, window: isTimeWindow(event.window) ? event.window : undefined } };
    case "token":
      if (event.field !== "reply" && event.field !== "enhancedPrompt") return live;
      return { ...live, [event.field]: live[event.field] + (event.text ?? ""), typing: event.field };
    case "prompt":
      return { ...live, enhancedPrompt: typeof event.enhancedPrompt === "string" ? event.enhancedPrompt : live.enhancedPrompt, typing: live.typing === "enhancedPrompt" ? null : live.typing };
    case "preview":
      return typeof event.imageUrl === "string" ? { ...live, preview: { imageUrl: event.imageUrl, label: event.label } } : live;
    case "progress":
      return { ...live, video: { status: event.status, progress: event.progress, elapsedMs: event.elapsedMs, at: now } };
    default:
      return live;
  }
}

/** The action pill shown as soon as the server has decided what to do (the final pill replaces it when done). */
export function liveActionLabel(intent: NonNullable<LiveProgress["intent"]>) {
  return intent.action === "edit_range" ? `✎ Editing${intent.window ? ` ${formatWindow(intent.window)}` : ""}`
    : intent.action === "append_shot" ? "＋ Extending the video"
    : intent.action === "cut_range" ? "✂ Removing a part"
    : intent.action === "append_attachment" ? "＋ Appending clip"
    : "💬 Answer";
}

/** 0–1 progress for the video stage, if the server reported one (accepts 0–1 or 0–100). */
export function videoFraction(live: LiveProgress): number | null {
  const value = live.video?.progress;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value > 1 ? value / 100 : value));
}

/** Step labels from the server may already end in an ellipsis; strip it so we never render "……". */
export function stepText(label: string) {
  return label.replace(/(?:\.{2,}|…)+\s*$/, "");
}
