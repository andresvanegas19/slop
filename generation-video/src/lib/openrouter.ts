import { loadEnvConfig } from "@next/env";
import path from "node:path";

const API_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "liquid/lfm-2.5-2.6b:free";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_DETAIL_LENGTH = 300;
const MAX_ATTEMPTS = 3;

export class OpenRouterError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export class OpenRouterConfigurationError extends OpenRouterError {}

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatCompletionMessage =
  | { role: "system" | "user"; content: string | ChatContentPart[] }
  | { role: "assistant"; content: string };

export type ChatTool = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ChatToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: string } };

export type ChatCompletionResult = {
  content: string;
  toolCalls: ChatToolCall[];
  finishReason?: string;
  model: string;
};

function loadServerEnvironment() {
  const development = process.env.NODE_ENV !== "production";
  loadEnvConfig(process.cwd(), development, undefined, true);
  loadEnvConfig(path.resolve(process.cwd(), ".."), development, undefined, true);
}

export function openRouterModel() {
  loadServerEnvironment();
  return process.env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;
}

function apiKey() {
  loadServerEnvironment();
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    throw new OpenRouterConfigurationError(
      "OPENROUTER_API_KEY is not configured on the server. Add OPENROUTER_API_KEY=... to ../.env (project root) and restart the dev server.",
      503,
    );
  }
  return key;
}

function headers(key: string) {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "http://localhost:3000",
    "X-Title": "Longform",
  };
}

function truncate(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_DETAIL_LENGTH ? `${clean.slice(0, MAX_DETAIL_LENGTH)}…` : clean;
}

async function fetchWithTimeout(url: string, init: RequestInit, action: string) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new OpenRouterError(`${action} timed out after ${REQUEST_TIMEOUT_MS / 1000}s; OpenRouter or the model may be overloaded, try again.`, 504);
    }
    const cause = error instanceof Error ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}` : String(error);
    throw new OpenRouterError(`${action} could not reach openrouter.ai (${cause}). Check the server's network connection.`, 502);
  }
}

async function httpError(action: string, response: Response) {
  const text = await response.text().catch(() => "");
  let detail = truncate(text);
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown; metadata?: { raw?: unknown } } | string };
    if (typeof body.error === "string") detail = truncate(body.error);
    else if (body.error && typeof body.error.message === "string") {
      const raw = body.error.metadata?.raw;
      detail = truncate(`${body.error.message}${typeof raw === "string" ? ` (${raw})` : ""}`);
    }
  } catch {
    // Not JSON; keep the raw text.
  }
  const hints: Record<number, string> = {
    401: "The OPENROUTER_API_KEY was rejected; confirm the key is correct.",
    402: "The OpenRouter account has insufficient credits for this model.",
    404: "The model was not found or does not support this request (e.g. tools); check OPENROUTER_MODEL.",
    429: "OpenRouter is rate limiting this key/model (free models have tight limits); wait and try again.",
  };
  return new OpenRouterError(
    [`${action} failed (HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}).`, detail && `OpenRouter said: "${detail}".`, hints[response.status]]
      .filter(Boolean)
      .join(" "),
    response.status,
  );
}

const imageSupportCache = new Map<string, boolean>();

/** Whether `model` accepts image input, per OpenRouter's model list (cached; false if the lookup fails). */
export async function modelSupportsImages(model: string) {
  const cached = imageSupportCache.get(model);
  if (cached !== undefined) return cached;
  try {
    const response = await fetchWithTimeout(`${API_BASE}/models`, { headers: { "Content-Type": "application/json" } }, "Listing OpenRouter models");
    if (!response.ok) return false;
    const body = await response.json() as { data?: { id?: string; architecture?: { input_modalities?: string[] } }[] };
    const entry = body.data?.find((item) => item.id === model);
    const supports = Boolean(entry?.architecture?.input_modalities?.includes("image"));
    imageSupportCache.set(model, supports);
    return supports;
  } catch {
    return false;
  }
}

export async function createChatCompletion(request: {
  model: string;
  messages: ChatCompletionMessage[];
  tools?: ChatTool[];
  maxTokens?: number;
  temperature?: number;
}): Promise<ChatCompletionResult> {
  const key = apiKey();
  const payload = JSON.stringify({
    model: request.model,
    messages: request.messages,
    ...(request.tools ? { tools: request.tools, tool_choice: "auto" } : {}),
    max_tokens: request.maxTokens ?? 1_024,
    temperature: request.temperature ?? 0.3,
  });
  // Free models are often rate-limited upstream for a few seconds; retry 429/502/503 briefly.
  let response: Response | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    response = await fetchWithTimeout(`${API_BASE}/chat/completions`, { method: "POST", headers: headers(key), body: payload }, "OpenRouter chat request");
    if (response.ok || ![429, 502, 503].includes(response.status) || attempt === MAX_ATTEMPTS - 1) break;
    const retryAfter = Number(response.headers.get("Retry-After"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 8_000) : 1_500 * 2 ** attempt;
    await response.body?.cancel().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  if (!response) throw new OpenRouterError("OpenRouter chat request was not sent.", 502);
  if (!response.ok) throw await httpError("OpenRouter chat request", response);

  const text = await response.text();
  let body: {
    model?: string;
    error?: { message?: string; code?: number };
    choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: ChatToolCall[] } }[];
  };
  try {
    body = JSON.parse(text);
  } catch {
    throw new OpenRouterError(`OpenRouter returned a response that is not JSON: "${truncate(text) || "(empty body)"}".`, 502);
  }
  // OpenRouter can return HTTP 200 with an error object when the upstream provider fails.
  if (body.error) {
    throw new OpenRouterError(`OpenRouter chat request failed: ${body.error.message ?? "unknown upstream error"}${body.error.code ? ` (code ${body.error.code})` : ""}.`, 502);
  }
  const choice = body.choices?.[0];
  if (!choice?.message) throw new OpenRouterError(`OpenRouter returned no choices: "${truncate(text)}".`, 502);
  return {
    content: typeof choice.message.content === "string" ? choice.message.content : "",
    toolCalls: Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [],
    finishReason: choice.finish_reason,
    model: body.model ?? request.model,
  };
}
