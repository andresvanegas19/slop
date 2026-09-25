import { createChatCompletion, openRouterModel } from "@/lib/openrouter";
import { sanitizeEnhancedPrompt } from "@/lib/prompt-enhance";
import { logException, logInfo } from "@/lib/runtime-log";

/** Prompt writing must never make a short clip slow; past this the user's own prompt is used. */
const ENHANCE_TIMEOUT_MS = 20_000;

export type VideoPrompt = { prompt: string; source: "llm" | "fallback" | "raw"; model?: string };

/** Budget for the cinematic shot writer on a quick clip; past this the user's own prompt is used. */
const CINEMATIC_TIMEOUT_MS = 30_000;

function system(clipSeconds: number) {
  return [
    `You write prompts for FLUX 3, a text-to-video model with synchronized audio. The clip is ${clipSeconds} seconds long.`,
    "Expand the user's idea into ONE paragraph of 50 to 130 words, in this order:",
    "1. Visual style or medium (for example: handheld documentary footage, 35mm film, 1990s cel animation).",
    "2. The subject and the action, already in motion on the first frame: a scroll-stopping first second (sudden motion, an extreme close detail or a strong contrast) that raises a question, with the key moment landing within the clip.",
    "3. One clear camera move (push in, orbit, tracking shot, whip pan, locked-off) and the lighting.",
    "4. A sentence starting with \"Audio:\" naming the ambience, sound effects, and music or dialogue that fit the scene.",
    "5. End with: No on-screen text.",
    "Keep everything the user asked for. Do not add extra scenes, cuts, logos, or captions.",
    "Output ONLY the prompt paragraph. No preamble, no quotes, no labels, no lists, no explanation.",
  ].join("\n");
}

function withAudio(prompt: string) {
  return /\baudio\s*:/i.test(prompt)
    ? prompt
    : `${prompt.replace(/[.\s]*$/, ".")} Audio: natural ambient sound and effects that match the action.`;
}

function withTimeout<T>(promise: Promise<T>, ms: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

/**
 * Quick-clip prompt: the cinematic (phone-footage) single-shot writer — subject/action/emotion, place + light, framing,
 * ONE camera move, look, ambient audio — streamed as `enhancedPrompt` tokens. `rawPrompt: true` sends the user's
 * prompt unchanged; placeholder or already-directed prompts bypass the writer. Env VIDEO_PROMPT_WRITER=basic uses the
 * older generic writer (writeVideoPrompt). Never throws.
 */
export async function writeClipPrompt(idea: string, clipSeconds: number, options: { companyContext?: string; rawPrompt?: boolean } = {}): Promise<VideoPrompt> {
  if (options.rawPrompt) return { prompt: idea, source: "raw" };
  if (process.env.VIDEO_PROMPT_WRITER?.trim() === "basic") return writeVideoPrompt(idea, clipSeconds, options.companyContext);
  try {
    const { writeCinematicClipPrompt } = await import("@/lib/cinematic-prompts");
    const result = await withTimeout(writeCinematicClipPrompt(idea, clipSeconds, { companyContext: options.companyContext }), CINEMATIC_TIMEOUT_MS);
    return { prompt: result.source === "raw" ? idea : withAudio(result.prompt), source: result.source === "fallback" ? "fallback" : result.source };
  } catch (error) {
    logException("clip_prompt_failed", error);
    return { prompt: idea, source: "fallback" };
  }
}

/**
 * Asks the configured OpenRouter model to turn a short idea into a FLUX 3 video prompt
 * (style → action → camera/light → Audio: → no text). `companyContext` is the optional company agent brief.
 * Never throws: failures return the user's prompt.
 */
export async function writeVideoPrompt(idea: string, clipSeconds: number, companyContext?: string): Promise<VideoPrompt> {
  const model = openRouterModel();
  const startedAt = Date.now();
  try {
    const result = await withTimeout(createChatCompletion({
      model,
      messages: [
        { role: "system", content: system(clipSeconds) },
        {
          role: "user",
          content: companyContext
            ? `Company context (use it only where it fits the idea; never as on-screen text):\n${companyContext}\n\nIdea: ${idea}\nWrite the video prompt now.`
            : `Idea: ${idea}\nWrite the video prompt now.`,
        },
      ],
      maxTokens: 1_200,
      temperature: 0.6,
    }), ENHANCE_TIMEOUT_MS);
    let output = result.content;
    if (result.finishReason === "length") {
      const end = output.lastIndexOf(".");
      output = end > 0 ? output.slice(0, end + 1) : output;
    }
    const prompt = sanitizeEnhancedPrompt(output);
    if (!prompt) {
      logInfo("video_prompt_rejected", { model, length: result.content.length, finishReason: result.finishReason });
      return { prompt: idea, source: "fallback" };
    }
    logInfo("video_prompt_written", { model: result.model, length: prompt.length, elapsedMs: Date.now() - startedAt });
    return { prompt: withAudio(prompt), source: "llm", model: result.model };
  } catch (error) {
    logException("video_prompt_failed", error, { model, elapsedMs: Date.now() - startedAt });
    return { prompt: idea, source: "fallback" };
  }
}
