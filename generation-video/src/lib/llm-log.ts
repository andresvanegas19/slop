/*
 * Logging for OpenRouter chat calls (see openrouter.ts): `llm_call_started` (debug), `llm_call_retry` (warn),
 * `llm_call_done` (info: model, purpose, prompt/response chars, tokens, latency, streamed) and `llm_call_failed`.
 * Prompts are never logged in full — only a 200-char preview of the last user message.
 */
import { log, promptPreview, startTimer } from "@/lib/runtime-log";

export type LlmUsage = { promptTokens?: number; completionTokens?: number; totalTokens?: number; cost?: number };

type Message = { role: string; content: string | ({ type: string; text?: string } | { type: string })[] };
type Result = { content: string; toolCalls: { function?: { name?: string } }[]; finishReason?: string; model: string; usage?: LlmUsage };

function textOf(content: Message["content"]) {
  if (typeof content === "string") return content;
  return content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join(" ");
}

const SKIP_FRAMES = /(llm-log|openrouter|createChatCompletion|callerPurpose|logLlmCall|processTicksAndRejections|new Promise|Array\.map|Promise\.all|<anonymous>)/;

/** Best-effort name of the function that called createChatCompletion (e.g. `detectIntent`), for the `purpose` field. */
export function callerPurpose() {
  const stack = new Error().stack?.split("\n").slice(1) ?? [];
  for (const frame of stack) {
    const match = /at (?:async )?([\w$.<>]+) \(/.exec(frame.trim());
    if (!match || SKIP_FRAMES.test(frame)) continue;
    const name = match[1].replace(/^Object\./, "").replace(/^Module\./, "");
    if (name && name !== "eval" && !/^(?:__|_)/.test(name)) return name;
  }
  return "unknown";
}

export function logLlmCall(input: { model: string; purpose: string; messages: Message[]; tools?: number; streamed: boolean; maxTokens?: number }) {
  const elapsed = startTimer();
  const promptChars = input.messages.reduce((sum, message) => sum + textOf(message.content).length, 0);
  const images = input.messages.reduce((sum, message) => sum + (Array.isArray(message.content) ? message.content.filter((part) => part.type === "image_url").length : 0), 0);
  const lastUser = [...input.messages].reverse().find((message) => message.role === "user");
  const base = { model: input.model, purpose: input.purpose, streamed: input.streamed };
  let attempts = 1;
  log("debug", "llm_call_started", { ...base, messages: input.messages.length, promptChars, images: images || undefined, tools: input.tools, maxTokens: input.maxTokens, prompt: promptPreview(lastUser ? textOf(lastUser.content) : "") });
  return {
    attempt(index: number, status: number) {
      attempts = index + 1;
      if (status >= 400) log(index < 2 && [429, 502, 503].includes(status) ? "warn" : "debug", "llm_call_retry", { ...base, attempt: attempts, status, afterMs: elapsed() });
    },
    memoized(result: Result) {
      log("info", "llm_call_done", { ...base, memoized: true, responseChars: result.content.length, durationMs: elapsed() });
    },
    done(result: Result) {
      log("info", "llm_call_done", {
        ...base,
        responseModel: result.model !== input.model ? result.model : undefined,
        promptChars,
        responseChars: result.content.length,
        toolCalls: result.toolCalls.length ? result.toolCalls.map((call) => call.function?.name ?? "?").join(",") : undefined,
        finishReason: result.finishReason,
        promptTokens: result.usage?.promptTokens,
        completionTokens: result.usage?.completionTokens,
        totalTokens: result.usage?.totalTokens,
        cost: result.usage?.cost,
        attempts: attempts > 1 ? attempts : undefined,
        durationMs: elapsed(),
      });
    },
    failed(error: unknown) {
      const aborted = error instanceof Error && error.constructor?.name === "ClientAbortedError";
      log(aborted ? "info" : "warn", aborted ? "llm_call_aborted" : "llm_call_failed", {
        ...base,
        attempts,
        status: (error as { status?: unknown })?.status as number | undefined,
        error: error instanceof Error ? error.message : String(error),
        durationMs: elapsed(),
      });
    },
  };
}
