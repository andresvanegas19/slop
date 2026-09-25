import { readFile } from "node:fs/promises";
import {
  createChatCompletion,
  modelSupportsImages,
  openRouterModel,
  type ChatCompletionMessage,
  type ChatContentPart,
  type ChatTool,
} from "@/lib/openrouter";
import { normalizeFrameEdit, type FrameEdit } from "@/lib/project-edit";
import { frameFilePath, type Project } from "@/lib/projects";

const MAX_HISTORY_MESSAGES = 12;
const MAX_REPLY_LENGTH = 2_000;

export type FrameChatDecision = { reply: string; edit?: FrameEdit };

function editTool(kind: Project["kind"]): ChatTool {
  const properties: Record<string, unknown> = {
    image_prompt: {
      type: "string",
      description: "Full new text-to-image prompt for this frame (describe the whole desired picture, not just the change). The current frame image is used as a reference so composition stays consistent.",
    },
  };
  if (kind === "storyboard") {
    properties.narration = { type: "string", description: "New voice-over line spoken during this frame (short, one sentence)." };
    properties.headline = { type: "string", description: "New headline text overlaid at the top of the frame. Empty string removes it." };
    properties.sub = { type: "string", description: "New subtitle text overlaid at the bottom of the frame. Empty string removes it." };
  }
  properties.reply = { type: "string", description: "One short sentence telling the user what you changed." };
  return {
    type: "function",
    function: {
      name: "edit_frame",
      description: "Edit this frame of the video. Only call this when the user explicitly asks to change the frame. Include only the fields that should change. The frame image is regenerated and the video re-rendered.",
      parameters: { type: "object", properties, required: ["reply"] },
    },
  };
}

function frameContext(project: Project, index: number, imageAttached: boolean) {
  const frame = project.frames[index];
  const previous = project.frames[index - 1];
  const next = project.frames[index + 1];
  const lines = [
    `Project: "${project.title}" (${project.kind === "clip" ? "3 second FLUX 3 clip animated from a single key frame" : "storyboard video"}, ${project.durationSeconds}s, ${project.frames.length} frame(s)).`,
    `Frame ${index + 1} of ${project.frames.length}: ${frame.startSec}s to ${(frame.startSec + frame.durationSec).toFixed(2).replace(/\.?0+$/, "")}s (${frame.durationSec}s long).`,
    `Image prompt: ${frame.prompt}`,
    frame.narration ? `Narration: ${frame.narration}` : undefined,
    frame.headline ? `Headline overlay (top): ${frame.headline}` : undefined,
    frame.sub ? `Subtitle overlay (bottom): ${frame.sub}` : undefined,
    previous ? `Previous frame: ${previous.headline ?? previous.prompt.slice(-160)}` : undefined,
    next ? `Next frame: ${next.headline ?? next.prompt.slice(-160)}` : undefined,
    imageAttached ? "The current frame image is attached." : "You cannot see the image; rely on the image prompt above as its description.",
  ];
  return lines.filter(Boolean).join("\n");
}

/** Wraps RAG guidance in a clearly delimited block for the system prompt ("" when there is none). */
export function guidanceBlock(guidance?: string) {
  const text = guidance?.trim();
  return text ? `\n\n=== Guidance (general reference notes; never copy them into image_prompt or change the frame's style because of them) ===\n${text}\n=== End guidance ===` : "";
}

function systemPrompt(project: Project, guidance?: string) {
  const editable = project.kind === "clip"
    ? "the image (via image_prompt)"
    : "the image (image_prompt), the narration, the headline, and the subtitle";
  return [
    "You are a video editing assistant helping a user refine one frame of a short video.",
    "If the user asks a question about the frame, answer it briefly in plain text and do NOT call any tool.",
    `If the user asks you to change the frame, call the edit_frame tool. You can change ${editable}.`,
    "When rewriting image_prompt, keep the parts of the current prompt that the user did not ask to change (style, palette, subject) and apply the requested change.",
    "Keep replies to one to three sentences.",
  ].join("\n") + guidanceBlock(guidance);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Some small models emit tool calls as text, e.g. `[edit_frame(image_prompt="...", reply="...")]`
// (Liquid LFM pythonic format) or as a JSON object. Recover the arguments when that happens.
function toolCallFromText(content: string): Record<string, unknown> | undefined {
  if (!/edit_frame/.test(content)) return undefined;
  const call = content.match(/edit_frame\s*\(([\s\S]*?)\)\s*\]?/);
  if (call) {
    const args: Record<string, unknown> = {};
    for (const match of call[1].matchAll(/(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g)) {
      args[match[1]] = (match[2] ?? match[3] ?? "").replace(/\\(["'\\])/g, "$1").replace(/\\n/g, "\n");
    }
    if (Object.keys(args).length > 0) return args;
  }
  const json = content.match(/\{[\s\S]*\}/);
  if (json) {
    const parsed = safeJson(json[0]) as Record<string, unknown> | undefined;
    if (parsed && typeof parsed === "object") {
      const inner = (parsed.arguments ?? parsed.parameters ?? parsed) as unknown;
      const args = typeof inner === "string" ? safeJson(inner) : inner;
      if (args && typeof args === "object" && !Array.isArray(args)) return args as Record<string, unknown>;
    }
  }
  return undefined;
}

function stripToolMarkup(content: string) {
  return content
    .replace(/<\|tool_call_start\|>[\s\S]*?(<\|tool_call_end\|>|$)/g, "")
    .replace(/\[?edit_frame\s*\([\s\S]*?\)\s*\]?/g, "")
    .replace(/<\/?think>[\s\S]*?<\/think>/g, "")
    .trim();
}

function describeEdit(edit: FrameEdit) {
  const parts = [
    edit.image_prompt !== undefined ? "regenerated the image" : undefined,
    edit.narration !== undefined ? "updated the narration" : undefined,
    edit.headline !== undefined ? (edit.headline ? "updated the headline" : "removed the headline") : undefined,
    edit.sub !== undefined ? (edit.sub ? "updated the subtitle" : "removed the subtitle") : undefined,
  ].filter(Boolean);
  const sentence = parts.join(", ").replace(/, ([^,]*)$/, " and $1");
  return `I ${sentence} and re-rendered the video.`;
}

/** Drops fields that don't actually change the frame. */
function effectiveEdit(project: Project, index: number, edit: FrameEdit | undefined) {
  if (!edit) return undefined;
  const frame = project.frames[index];
  const result: FrameEdit = {};
  if (edit.image_prompt !== undefined && edit.image_prompt !== frame.prompt) result.image_prompt = edit.image_prompt;
  if (edit.narration !== undefined && edit.narration !== (frame.narration ?? "")) result.narration = edit.narration;
  if (edit.headline !== undefined && edit.headline !== (frame.headline ?? "")) result.headline = edit.headline;
  if (edit.sub !== undefined && edit.sub !== (frame.sub ?? "")) result.sub = edit.sub;
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Asks the configured OpenRouter model about a frame; returns a reply and, if requested, a validated edit. */
export async function decideFrameChat(
  project: Project,
  index: number,
  message: string,
  options: { referenceImagePath?: string; atSec?: number; guidance?: string; onToken?: (text: string) => void } = {},
): Promise<FrameChatDecision> {
  const model = openRouterModel();
  const frame = project.frames[index];
  const withImage = await modelSupportsImages(model);
  let imageUrl: string | undefined;
  if (withImage) {
    try {
      imageUrl = `data:image/png;base64,${(await readFile(options.referenceImagePath ?? frameFilePath(frame.imageUrl))).toString("base64")}`;
    } catch {
      imageUrl = undefined; // Missing frame file: fall back to the text description.
    }
  }

  const history = (project.chats[String(index)] ?? []).slice(-MAX_HISTORY_MESSAGES);
  const userContent: ChatContentPart[] = [
    {
      type: "text",
      text: `${frameContext(project, index, Boolean(imageUrl))}${options.atSec === undefined ? "" : `\nThe user paused the video at ${options.atSec.toFixed(2)}s and is looking at that moment.`}\n\nUser request: ${message}`,
    },
    ...(imageUrl ? [{ type: "image_url" as const, image_url: { url: imageUrl } }] : []),
  ];
  const messages: ChatCompletionMessage[] = [
    { role: "system", content: systemPrompt(project, options.guidance) },
    ...history.map((item): ChatCompletionMessage => item.role === "user"
      ? { role: "user", content: item.text }
      : { role: "assistant", content: item.text }),
    { role: "user", content: imageUrl ? userContent : (userContent[0] as { text: string }).text },
  ];

  const result = await createChatCompletion({ model, messages, tools: [editTool(project.kind)], maxTokens: 2_048, onToken: options.onToken });

  let args: Record<string, unknown> | undefined;
  const call = result.toolCalls.find((item) => item.function?.name === "edit_frame");
  if (call) {
    const parsed = typeof call.function?.arguments === "string" ? safeJson(call.function.arguments) : call.function?.arguments;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } else {
    args = toolCallFromText(result.content);
  }

  const edit = effectiveEdit(project, index, normalizeFrameEdit(args, project.kind));
  const text = stripToolMarkup(result.content);
  const toolReply = typeof args?.reply === "string" ? args.reply.trim() : "";
  let reply = (edit ? toolReply || text : text || toolReply).slice(0, MAX_REPLY_LENGTH);
  if (edit && !reply) reply = describeEdit(edit);
  if (!reply) {
    reply = args
      ? "That would not change anything in this frame. Tell me what you'd like to change."
      : "Sorry, I didn't get a response from the model. Please try again.";
  }
  return { reply, ...(edit ? { edit } : {}) };
}
