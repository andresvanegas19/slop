import { createChatCompletion, openRouterModel, type ChatTool } from "@/lib/openrouter";
import { userContextBlock } from "@/lib/user-context";
import type { Project } from "@/lib/projects";
import { logInfo } from "@/lib/runtime-log";

export type IntentAction = "edit_range" | "answer" | "append_shot" | "cut_range" | "append_attachment";

export type IntentParams = {
  /** edit_range: what to change. */
  instruction?: string;
  /** answer: the model's reply (may be empty; the answer flow writes its own). */
  reply?: string;
  /** append_shot: what happens next. */
  prompt?: string;
  /** append_shot: extra time requested (1–15s). */
  seconds?: number;
};

export type Intent = { action: IntentAction; params: IntentParams; source: "llm" | "rules"; atEnd: boolean };

export type IntentContext = {
  message: string;
  project: Pick<Project, "title" | "durationSeconds" | "kind" | "frames">;
  atSec?: number;
  range?: { startSec: number; endSec: number };
  hasAttachment: boolean;
  /** Frame prompt for context (the frame at atSec / range). */
  framePrompt?: string;
  /** Small RAG guidance text. */
  guidance?: string;
  /** Skip the LLM (tests / fallback). */
  useLlm?: boolean;
};

const MAX_SECONDS = 15;

/** The user's moment is at the end of the video (so new content should be appended, not edited in). */
export function isAtEnd(context: Pick<IntentContext, "atSec" | "range" | "project">) {
  const duration = context.project.durationSeconds;
  if (context.range) return context.range.endSec >= duration - 0.1 && context.range.startSec >= duration - 0.5;
  if (context.atSec !== undefined) return context.atSec >= duration - 0.25;
  return false;
}

// ---------- rules ----------

const EDIT_VERBS = /\b(make|change|turn|replace|remove|recolou?r|colou?r|paint|swap|edit|fix|brighten|darken|add|put|give|set|convert|transform|modify|adjust)\b/i;
const QUESTION_START = /^(what|who|where|when|why|how|which|is|are|does|do|did|can you (tell|describe|explain)|could you (tell|describe|explain)|tell me|describe|explain)\b/i;

function secondsRequested(text: string): number | undefined {
  const lower = text.toLowerCase();
  const patterns = [
    /(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)\s*(?:longer|more|extra)/,
    /(?:extend|lengthen|add|continue|keep going)\b[^.?!]*?\bby\s+(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)\b/,
    /(?:add|another|extra|append)\s+(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)\b/,
    /(\d+(?:\.\d+)?)\s*(?:more|extra)\s*(?:s|sec|secs|seconds?)\b/,
  ];
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const normalized = lower.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (word) => String(words[word]));
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return clampSeconds(Number(match[1]));
  }
  return undefined;
}

function clampSeconds(value: number) {
  if (!Number.isFinite(value)) return undefined;
  return Math.min(MAX_SECONDS, Math.max(1, Math.round(value * 10) / 10));
}

const EXTEND = /\b(extend|longer|lengthen|add (?:more )?time|continue|keep going|carry on|what happens next|and then|then\b|next\b|afterwards|after that|append|new shot|another shot)/i;
// "cut this", "delete that part", "remove the selected bit" — but not "remove this bird" (that's an edit).
const CUT = /\b(?:remove|cut|delete|trim|drop)\s+(?:out\s+)?(?:(?:this|that|the)\s+(?:selected\s+)?(?:part|bit|section|segment|moment|range|clip|piece|selection|one)|this|that|it|the selection)\s*(?:out|away|from the video)?\s*(?:please)?\s*[.!]?\s*$/i;

const CONTINUE_PROMPT = "Continue the current action naturally with the same subject, setting, camera, and visual style.";

/**
 * Turns an append request into shot content: strips duration/extension wording ("make it 2 seconds longer",
 * "continue", "then") and falls back to a plain continuation when nothing descriptive is left.
 */
export function shotPromptFrom(message: string) {
  const stripped = message
    .replace(/\b(?:please|can you|could you|just)\b/gi, " ")
    .replace(/\b(?:make|let)\s+(?:it|the video|this)\b/gi, " ")
    .replace(/\b(?:by\s+|another\s+|extra\s+)?\d+(?:\.\d+)?\s*(?:s|sec|secs|seconds?)\b(?:\s*(?:longer|more|extra))?/gi, " ")
    .replace(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:more\s+)?seconds?\b(?:\s*(?:longer|more))?/gi, " ")
    .replace(/\b(?:extend(?:\s+it)?|lengthen|longer|add (?:more )?time|continue|keep going|carry on|and then|then|next|afterwards|after that|append)\b/gi, " ")
    .replace(/[,.;:!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:and|so|with)\s+/i, "");
  const words = stripped.split(" ").filter((word) => word.length > 1);
  return words.length >= 2 ? stripped : CONTINUE_PROMPT;
}

/** Pure keyword rules. `strong` means the rule should override the LLM. */
export function ruleIntent(context: IntentContext): { action: IntentAction; params: IntentParams; strong: boolean } {
  const text = context.message.trim();
  const hasRange = Boolean(context.range);
  const atEnd = isAtEnd(context);
  const editVerb = EDIT_VERBS.test(text);
  const seconds = secondsRequested(text);

  if (context.hasAttachment) {
    const clearlyEdit = hasRange && /\b(edit|change|make|replace|turn|recolou?r)\b/i.test(text) && !/\b(append|add (it|this|the video|the clip)|attach|put (it|this) (at|on) the end)\b/i.test(text);
    if (!clearlyEdit) return { action: "append_attachment", params: {}, strong: true };
  }
  if (seconds !== undefined) return { action: "append_shot", params: { prompt: shotPromptFrom(text), seconds }, strong: true };
  // Without a range this still resolves to cut_range so /command can ask the user to select one (422).
  if (CUT.test(text)) return { action: "cut_range", params: {}, strong: true };
  if (/\?\s*$/.test(text) && !editVerb) return { action: "answer", params: {}, strong: true };
  if (QUESTION_START.test(text) && !editVerb) return { action: "answer", params: {}, strong: true };
  if (EXTEND.test(text)) {
    return { action: "append_shot", params: { prompt: shotPromptFrom(text) }, strong: true };
  }
  // At the end of the video, new content/action is appended unless the text modifies what's already visible.
  if (atEnd && !editVerb) return { action: "append_shot", params: { prompt: text }, strong: true };
  return { action: "edit_range", params: { instruction: text }, strong: false };
}

// ---------- LLM ----------

function tools(context: IntentContext): ChatTool[] {
  const list: ChatTool[] = [
    {
      type: "function",
      function: {
        name: "edit_range",
        description: "Change what is visible in the selected moment/range of the video (e.g. 'make the sky red', 'give her a hat', 'make it snow').",
        parameters: { type: "object", properties: { instruction: { type: "string", description: "The change to make, in the user's words." } }, required: ["instruction"] },
      },
    },
    {
      type: "function",
      function: {
        name: "answer",
        description: "The user asked a question or chatted; nothing in the video should change (e.g. 'what is in this shot?', 'why is it blurry?').",
        parameters: { type: "object", properties: { reply: { type: "string", description: "A short answer." } }, required: ["reply"] },
      },
    },
    {
      type: "function",
      function: {
        name: "append_shot",
        description: "Add new time at the end of the video: continue the action or show what happens next (e.g. 'make it 3 seconds longer', 'then she waves', 'continue', 'a dog runs in').",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "What happens in the new time." },
            seconds: { type: "number", description: "Extra seconds requested (1–15), only if the user gave a number." },
          },
          required: ["prompt"],
        },
      },
    },
  ];
  if (context.range) {
    list.push({
      type: "function",
      function: {
        name: "cut_range",
        description: "Remove the selected range from the video (e.g. 'cut this', 'delete that part').",
        parameters: { type: "object", properties: {} },
      },
    });
  }
  if (context.hasAttachment) {
    list.push({
      type: "function",
      function: {
        name: "append_attachment",
        description: "Add the attached video to the end of this video.",
        parameters: { type: "object", properties: {} },
      },
    });
  }
  return list;
}

function systemPrompt(context: IntentContext, atEnd: boolean) {
  const selection = context.range
    ? `The user selected ${context.range.startSec}s–${context.range.endSec}s.`
    : context.atSec !== undefined ? `The playhead is at ${context.atSec}s.` : "Nothing is selected.";
  return [
    "You route a video editor's chat message to exactly ONE tool. Always call a tool; never answer in plain text.",
    "- edit_range: change what is visible in the selected moment.",
    "- answer: questions or chat; the video does not change.",
    "- append_shot: add new time at the end (extend, continue, 'then…', 'N seconds longer', new action or content).",
    context.range ? "- cut_range: remove the selected range." : undefined,
    context.hasAttachment ? "- append_attachment: the user attached a video; add it to the end." : undefined,
    `Video: "${context.project.title}", ${context.project.durationSeconds}s long, ${context.project.frames.length} shot(s). ${selection}`,
    context.framePrompt ? `Selected shot description: ${context.framePrompt.slice(0, 400)}` : undefined,
    atEnd
      ? "atEnd: true — the user is at the END of the video. If the message describes new content or action (e.g. 'she waves', 'a dog runs in', 'zoom out to the city'), call append_shot. Only call edit_range if it clearly modifies what is already visible (e.g. 'make the sky red', 'change her shirt'). Questions → answer."
      : "atEnd: false",
    context.guidance ? `Guidance (reference only):\n${context.guidance.slice(0, 800)}` : undefined,
  ].filter(Boolean).join("\n");
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const ACTIONS: IntentAction[] = ["edit_range", "answer", "append_shot", "cut_range", "append_attachment"];

/** Parses tool calls from structured tool_calls, pythonic `name(k="v")` text, or JSON text. */
function parseCall(toolCalls: { function?: { name?: string; arguments?: string } }[], content: string) {
  const structured = toolCalls.find((call) => ACTIONS.includes(call.function?.name as IntentAction));
  if (structured) {
    const args = typeof structured.function?.arguments === "string" ? safeJson(structured.function.arguments) : undefined;
    return { name: structured.function?.name as IntentAction, args: (args && typeof args === "object" ? args : {}) as Record<string, unknown> };
  }
  const pythonic = content.match(/\b(edit_range|answer|append_shot|cut_range|append_attachment)\s*\(([\s\S]*?)\)/);
  if (pythonic) {
    const args: Record<string, unknown> = {};
    for (const match of pythonic[2].matchAll(/(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(-?\d+(?:\.\d+)?))/g)) {
      args[match[1]] = match[4] !== undefined ? Number(match[4]) : (match[2] ?? match[3] ?? "");
    }
    return { name: pythonic[1] as IntentAction, args };
  }
  const json = content.match(/\{[\s\S]*\}/);
  if (json) {
    const parsed = safeJson(json[0]) as Record<string, unknown> | undefined;
    const name = (parsed?.name ?? parsed?.tool ?? parsed?.action) as string | undefined;
    if (name && ACTIONS.includes(name as IntentAction)) {
      const inner = parsed?.arguments ?? parsed?.parameters ?? parsed?.params ?? {};
      const args = typeof inner === "string" ? safeJson(inner) : inner;
      return { name: name as IntentAction, args: (args && typeof args === "object" ? args : {}) as Record<string, unknown> };
    }
  }
  return undefined;
}

function text(value: unknown, max = 1_000) {
  return typeof value === "string" ? value.trim().slice(0, max) : undefined;
}

/**
 * Detects what a /command message wants. One OpenRouter call with tools, then keyword rules: strong rules (numbers
 * of seconds, cut with a range, questions, attachments, "then/continue…", at-end new content) override the LLM, and
 * the rules are the fallback when the LLM fails or picks an impossible action.
 */
export async function detectIntent(context: IntentContext): Promise<Intent> {
  const atEnd = isAtEnd(context);
  const rules = ruleIntent(context);
  const fromRules = (): Intent => ({ action: rules.action, params: { ...rules.params }, source: "rules", atEnd });
  if (rules.strong || context.useLlm === false) return fromRules();

  try {
    const userContext = await userContextBlock({ maxChars: 600 });
    const result = await createChatCompletion({
      model: openRouterModel(),
      messages: [{ role: "system", content: systemPrompt(context, atEnd) + userContext }, { role: "user", content: context.message }],
      tools: tools(context),
      maxTokens: 1_024,
      temperature: 0,
    });
    const call = parseCall(result.toolCalls, result.content);
    if (!call) {
      logInfo("intent_llm_no_call", { length: result.content.length });
      return fromRules();
    }
    const impossible = (call.name === "cut_range" && !context.range) || (call.name === "append_attachment" && !context.hasAttachment);
    if (impossible) {
      logInfo("intent_llm_impossible", { action: call.name });
      return fromRules();
    }
    const params: IntentParams = {};
    if (call.name === "edit_range") params.instruction = text(call.args.instruction) || context.message;
    if (call.name === "answer") params.reply = text(call.args.reply, 2_000);
    if (call.name === "append_shot") {
      params.prompt = shotPromptFrom(text(call.args.prompt) || context.message);
      const seconds = typeof call.args.seconds === "number" ? call.args.seconds : Number(call.args.seconds);
      if (Number.isFinite(seconds) && seconds > 0) params.seconds = clampSeconds(seconds);
    }
    logInfo("intent_detected", { action: call.name, source: "llm", atEnd });
    return { action: call.name, params, source: "llm", atEnd };
  } catch (error) {
    logInfo("intent_llm_failed", { reason: error instanceof Error ? error.message.slice(0, 200) : String(error) });
    return fromRules();
  }
}
