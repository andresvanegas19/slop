import { readFile } from "node:fs/promises";
import { userContextBlock } from "@/lib/user-context";
import { createChatCompletion, modelSupportsImages, openRouterModel, type ChatContentPart } from "@/lib/openrouter";
import { guidanceBlock } from "@/lib/frame-chat";
import type { Project } from "@/lib/projects";
import { logException, logInfo } from "@/lib/runtime-log";

const MIN_LENGTH = 15;
const MAX_LENGTH = 1_500;

export type EnhancedPrompt = { prompt: string; source: "llm" | "fallback" };

const SYSTEM = [
  "You write prompts for a text-to-image model that edits an existing video frame.",
  "Rewrite the frame's current prompt so it includes the user's requested change.",
  "Describe the full picture in one paragraph of 40 to 120 words: subject, setting, lighting, camera/framing, and visual style.",
  "Keep the original subject, composition, and style unless the user asked to change them.",
  "Do not name a new art style or medium (illustration, vector, cartoon, painting, etc.) unless the current prompt or the user already uses it; if the current prompt names no style, don't add one.",
  "Never ask for on-screen text, captions, letters, numbers, or logos in the image.",
  "Output ONLY the prompt paragraph. No preamble, no quotes, no labels, no lists, no explanation.",
  "Any guidance below is general advice only: never copy its sentences or style prefixes into the prompt, and never change the frame's existing visual style because of it.",
].join("\n");

/** Cleans up small-model output; returns undefined if it doesn't look like a usable image prompt. */
export function sanitizeEnhancedPrompt(raw: string): string | undefined {
  let text = raw
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<\|[^|]*\|>/g, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
  // Drop a "Sure, here's the prompt:" style first line.
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1 && /:\s*$/.test(lines[0])) lines.shift();
  text = lines.join(" ")
    .replace(/^(?:(?:enhanced|improved|new|updated|final|image)\s+)*prompt\s*[:\-–]\s*/i, "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < MIN_LENGTH) return undefined;
  if (/edit_frame|tool_call|^(?:i\s+(?:can(?:'|no)t|am unable|won't)|sorry\b|as an ai\b)/i.test(text)) return undefined;
  if (text.split(/\s+/).length < 4) return undefined;
  if (text.length > MAX_LENGTH) {
    const cut = text.slice(0, MAX_LENGTH);
    const sentenceEnd = cut.lastIndexOf(". ");
    text = sentenceEnd > MIN_LENGTH ? cut.slice(0, sentenceEnd + 1) : cut;
  }
  if (!/\b(text|letters?|lettering|captions?|typography|words)\b/i.test(text)) {
    text = `${text.replace(/[.\s]*$/, ".")} No on-screen text or lettering.`;
  }
  return text;
}

function shingles(text: string, size = 6) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean);
  const result = new Set<string>();
  for (let index = 0; index + size <= words.length; index += 1) result.add(words.slice(index, index + size).join(" "));
  return result;
}

/**
 * True when `prompt` contains several 6-word runs that appears in the guidance but not in the user's own text/current prompt,
 * i.e. the small model pasted guidance (e.g. a storyboard style prefix) into the image prompt, which changes its style.
 */
export function copiesGuidance(prompt: string, guidance: string | undefined, ownText: string) {
  if (!guidance?.trim()) return false;
  const fromGuidance = shingles(guidance);
  // Only runs that bring in words the user/current prompt never used count as copied.
  const ownWords = new Set(ownText.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean));
  let copied = 0;
  for (const gram of shingles(prompt)) {
    if (fromGuidance.has(gram) && gram.split(" ").some((word) => !ownWords.has(word))) copied += 1;
  }
  // A pasted style prefix produces many copied runs; one or two can just be the user's own words re-joined.
  return copied >= 3;
}

// Art-style words that change the medium/look of a frame. A small model tends to borrow these from guidance examples
// (e.g. "flat vector illustration"), which turned a photoreal clip into a cartoon.
const STYLE_TERMS = [
  "illustration", "illustrated", "vector", "cartoon", "anime", "manga", "isometric", "watercolor", "watercolour",
  "oil painting", "painting", "painted", "sketch", "pencil", "line art", "pixel art", "comic", "cel-shaded", "cel shaded",
  "low poly", "low-poly", "3d render", "claymation", "clay", "flat design", "flat style", "vector shapes", "editorial illustration",
];

export function styleTermsIn(text: string) {
  const lower = text.toLowerCase();
  return STYLE_TERMS.filter((term) => new RegExp(`\\b${term.replace(/[-\s]/g, "[-\\s]")}\\b`).test(lower));
}

/**
 * Drops sentences that introduce an art style neither the user's instruction nor the frame's current prompt mentions,
 * so an edit keeps the frame's existing look. Returns undefined if too little is left to be a usable prompt.
 */
export function dropUnrequestedStyle(prompt: string, ownText: string): string | undefined {
  const allowed = new Set(styleTermsIn(ownText));
  const sentences = prompt.match(/[^.!?]+[.!?]*/g) ?? [prompt];
  const kept = sentences.filter((sentence) => styleTermsIn(sentence).every((term) => allowed.has(term)));
  if (kept.length === sentences.length) return prompt;
  const text = kept.join(" ").replace(/\s+/g, " ").trim();
  // The "No on-screen text" boilerplate alone isn't a prompt: require real descriptive content to survive.
  return contentWords(text) >= MIN_CONTENT_WORDS ? text : undefined;
}

const MIN_CONTENT_WORDS = 8;
const NO_TEXT_SENTENCE = /\bno\s+(?:on-screen\s+)?(?:text|letters?|lettering|captions?|logos?)\b[^.!?]*[.!?]*/gi;

function contentWords(text: string) {
  return text.replace(NO_TEXT_SENTENCE, " ").split(/\s+/).filter((word) => /[a-z0-9]/i.test(word)).length;
}

/** Placeholder prompts ("From: <title>", "Uploaded video: <file>") say nothing about what the frame looks like. */
function isPlaceholderPrompt(prompt: string) {
  const text = prompt.trim();
  // Also: continuation boilerplate from a fallback shot prompt, which describes an action but not what's on screen.
  return /^(?:from|uploaded video):/i.test(text) || /continue seamlessly from the previous shot/i.test(text);
}

function fallbackPrompt(currentPrompt: string, instruction: string, draft?: string, guidance?: string) {
  const usableDraft = draft?.trim() && draft.trim() !== currentPrompt.trim() && !copiesGuidance(draft, guidance, `${currentPrompt}\n${instruction}`);
  const draftWithoutStyle = usableDraft ? dropUnrequestedStyle(draft!.trim(), `${currentPrompt}\n${instruction}`) : undefined;
  if (draftWithoutStyle) return draftWithoutStyle.slice(0, MAX_LENGTH);
  // Deterministic edit instruction: the BFL edit uses the frame as its reference image, so say what to keep.
  const keep = "Keep the same subject, composition, camera angle, lighting and visual style as the reference image.";
  const base = isPlaceholderPrompt(currentPrompt) ? "" : `${currentPrompt.replace(/[.\s]*$/, ".")} `;
  return `${base}${instruction.replace(/[.\s]*$/, ".")} ${keep}`.slice(0, MAX_LENGTH);
}

/**
 * Turns the user's short instruction + the frame's current prompt (+ the reference image when the model can see
 * images) into a detailed image prompt. Never throws: any model failure falls back to a deterministic prompt.
 */
export async function enhanceImagePrompt(input: {
  project: Project;
  index: number;
  instruction: string;
  draftPrompt?: string;
  referenceImagePath?: string;
  /** RAG guidance text (from retrieveContext) added to the system prompt. */
  guidance?: string;
  /** Streams the raw model output as it is generated (sanitization happens after). */
  onToken?: (text: string) => void;
}): Promise<EnhancedPrompt> {
  const frame = input.project.frames[input.index];
  const fallback = fallbackPrompt(frame.prompt, input.instruction, input.draftPrompt, input.guidance);
  try {
    const model = openRouterModel();
    let imageUrl: string | undefined;
    if (input.referenceImagePath && await modelSupportsImages(model)) {
      imageUrl = `data:image/png;base64,${(await readFile(input.referenceImagePath)).toString("base64")}`;
    }
    if (!imageUrl && isPlaceholderPrompt(frame.prompt)) {
      // The frame's content is unknown to a text-only model ("From: <title>" / uploads): any description it writes is
      // invented and would replace the picture. Send only the change, anchored to the reference image.
      logInfo("prompt_enhance_skipped_placeholder", { model });
      return { prompt: fallbackPrompt(frame.prompt, input.instruction), source: "fallback" };
    }
    const text = [
      `Current prompt: ${frame.prompt}`,
      frame.headline ? `(The headline "${frame.headline}" is overlaid separately; do not put it in the image.)` : undefined,
      // The decision model's draft is only used as a fallback: showing it here makes the small model echo it verbatim.
      imageUrl ? "The attached image is the exact frame the user selected." : undefined,
      `User's requested change: ${input.instruction}`,
      "Write the new prompt now.",
    ].filter(Boolean).join("\n");
    const content: string | ChatContentPart[] = imageUrl
      ? [{ type: "text", text }, { type: "image_url", image_url: { url: imageUrl } }]
      : text;
    const userContext = await userContextBlock();
    const result = await createChatCompletion({
      model,
      onToken: input.onToken,
      messages: [{ role: "system", content: SYSTEM + guidanceBlock(input.guidance) + userContext }, { role: "user", content }],
      // The free LFM model sometimes spends tokens before answering; a low cap truncates mid-sentence.
      maxTokens: 1_500,
      temperature: 0.4,
    });
    let output = result.content;
    if (result.finishReason === "length") {
      // Truncated: keep only complete sentences.
      const end = output.lastIndexOf(".");
      output = end > MIN_LENGTH ? output.slice(0, end + 1) : output;
    }
    let prompt = sanitizeEnhancedPrompt(output);
    // Past prompts in the user context must not be pasted in either (same guard as guidance).
    if (prompt && copiesGuidance(prompt, `${input.guidance ?? ""}\n${userContext}`, `${frame.prompt} ${input.instruction}`)) {
      logInfo("prompt_enhance_copied_guidance", { model });
      prompt = undefined;
    }
    if (prompt) {
      const ownText = `${frame.prompt} ${input.instruction}`;
      const withoutStyle = dropUnrequestedStyle(prompt, ownText);
      if (withoutStyle !== prompt) logInfo("prompt_enhance_dropped_style", { model, dropped: styleTermsIn(prompt).filter((term) => !styleTermsIn(ownText).includes(term)).join(",") });
      prompt = withoutStyle;
    }
    if (!prompt) {
      logInfo("prompt_enhance_rejected", { model, length: result.content.length, finishReason: result.finishReason });
      return { prompt: fallback, source: "fallback" };
    }
    logInfo("prompt_enhance_completed", { model, length: prompt.length });
    return { prompt, source: "llm" };
  } catch (error) {
    logException("prompt_enhance_failed", error, { projectId: input.project.id, index: input.index });
    return { prompt: fallback, source: "fallback" };
  }
}

const SHOT_SYSTEM = [
  "You write prompts for an image-to-video model that generates the NEXT shot of a short video.",
  "The new shot starts from the last frame of the previous shot (attached when available), so it must continue the same subject, setting, and visual style.",
  "Turn the user's short request into one paragraph of 40 to 120 words describing what happens in the next few seconds: subject and action, setting, lighting, camera movement, and visual style.",
  "Do not name a new art style or medium (illustration, vector, cartoon, painting, etc.) unless the previous shot or the user already uses it.",
  "Never ask for on-screen text, captions, letters, numbers, or logos.",
  "Output ONLY the prompt paragraph. No preamble, no quotes, no labels, no lists, no explanation.",
  "Any guidance below is general advice only: never copy its sentences or style prefixes into the prompt.",
].join("\n");

/**
 * Enhances a request for a new appended shot, continuing from the previous shot's prompt (+ its last frame when the
 * model can see images). Same validation and style-drift guard as enhanceImagePrompt; never throws.
 */
export async function enhanceShotPrompt(input: {
  projectId: string;
  previousPrompt: string;
  instruction: string;
  referenceImagePath?: string;
  guidance?: string;
  /** Streams the raw model output as it is generated (sanitization happens after). */
  onToken?: (text: string) => void;
}): Promise<EnhancedPrompt> {
  const ownText = `${input.previousPrompt}\n${input.instruction}`;
  const fallback = (dropUnrequestedStyle(
    `${input.instruction.replace(/[.\s]*$/, ".")} Continue seamlessly from the previous shot with the same subject, setting, and visual style.`,
    ownText,
  ) ?? input.instruction).slice(0, MAX_LENGTH);
  try {
    const model = openRouterModel();
    let imageUrl: string | undefined;
    if (input.referenceImagePath && await modelSupportsImages(model)) {
      imageUrl = `data:image/png;base64,${(await readFile(input.referenceImagePath)).toString("base64")}`;
    }
    if (!imageUrl && isPlaceholderPrompt(input.previousPrompt)) {
      // A text-only model knows nothing about a placeholder-described shot and invents a subject (e.g. a hen from a
      // guidance example). The continuation clip already carries the visuals, so send only the requested action.
      logInfo("shot_enhance_skipped_placeholder", { model });
      return { prompt: fallback, source: "fallback" };
    }
    const text = [
      `Previous shot prompt: ${input.previousPrompt}`,
      imageUrl ? "The attached image is the last frame of the previous shot; the new shot starts from it." : undefined,
      `User's request for the next shot: ${input.instruction}`,
      "Write the new shot prompt now.",
    ].filter(Boolean).join("\n");
    const content: string | ChatContentPart[] = imageUrl
      ? [{ type: "text", text }, { type: "image_url", image_url: { url: imageUrl } }]
      : text;
    const userContext = await userContextBlock();
    const result = await createChatCompletion({
      model,
      onToken: input.onToken,
      messages: [{ role: "system", content: SHOT_SYSTEM + guidanceBlock(input.guidance) + userContext }, { role: "user", content }],
      maxTokens: 1_500,
      temperature: 0.5,
    });
    let output = result.content;
    if (result.finishReason === "length") {
      const end = output.lastIndexOf(".");
      output = end > MIN_LENGTH ? output.slice(0, end + 1) : output;
    }
    let prompt = sanitizeEnhancedPrompt(output);
    if (prompt && copiesGuidance(prompt, `${input.guidance ?? ""}\n${userContext}`, ownText)) {
      logInfo("shot_prompt_copied_guidance", { model });
      prompt = undefined;
    }
    if (prompt) prompt = dropUnrequestedStyle(prompt, ownText);
    if (!prompt) {
      logInfo("shot_prompt_rejected", { model, length: result.content.length, finishReason: result.finishReason });
      return { prompt: fallback, source: "fallback" };
    }
    logInfo("shot_prompt_completed", { model, length: prompt.length });
    return { prompt, source: "llm" };
  } catch (error) {
    logException("shot_prompt_failed", error, { projectId: input.projectId });
    return { prompt: fallback, source: "fallback" };
  }
}
