import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getClient, isRawTreeConfigured } from "@/lib/rawtree";
import { logException, logInfo } from "@/lib/runtime-log";
import { videoFilePath } from "@/lib/segments";
import { ANONYMOUS_USER, invalidateUserContext, parseUserId, runWithUser, USER_PROMPTS_TABLE } from "@/lib/user-context";
import { withRetry } from "@/lib/video-store";

/**
 * Logs every user prompt sent to a prompt-taking route into RawTree `slop_human_user_prompts` (permanent rows), after
 * the request finishes (ok / error / cancelled). Also binds the request's user id for userContextBlock().
 * Schema: docs/RAWTREE_USER_CONTEXT.md.
 */

export type PromptSurface = "new_clip" | "preset_ad" | "preset_company" | "storyboard" | "command" | "ask" | "append" | "cut" | "research";

const PROMPT_CAP = 2_000;
const ENHANCED_CAP = 2_000;
const ERROR_CAP = 500;
const SUMMARY_CAP = 300;

function enabled() {
  if (!isRawTreeConfigured()) return false; // also loads .env
  return (process.env.RAWTREE_PUBLISH_PROMPTS ?? "1").trim() !== "0";
}

type Json = Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const cap = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);
const asObject = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : {});

/** The user's text for this request (storyboards: headline + scene visuals; cuts: the range). */
function promptOf(surface: PromptSurface, body: Json) {
  const direct = str(body.prompt) || str(body.message);
  if (direct) return direct.trim();
  if (surface === "storyboard") {
    const scenes = Array.isArray(body.scenes) ? body.scenes.map((scene) => str(asObject(scene).visualPrompt)).filter(Boolean) : [];
    return [str(body.headline), ...scenes].filter(Boolean).join(" | ");
  }
  if (surface === "cut" && num(body.rangeStartSec) !== null) return `Cut ${body.rangeStartSec}s–${body.rangeEndSec}s`;
  return "";
}

type Observed = { status: number; body: Json; intent?: Json; enhancedPrompt?: string; cancelled: boolean };

/** Reads the (cloned) response: plain JSON, or an NDJSON stream ending in {"type":"done"|"error"}. */
async function observe(response: Response, signal: AbortSignal): Promise<Observed> {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/x-ndjson") || !response.body) {
    const body = asObject(await response.json().catch(() => ({})));
    return { status: response.status, body, cancelled: signal.aborted };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const observed: Observed = { status: response.status, body: {}, cancelled: false };
  let buffer = "";
  let finished = false;
  // A disconnected client closes the stream without a final event (and may never close this branch): stop reading.
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  const handle = (line: string) => {
    if (!line.trim()) return;
    let event: Json;
    try {
      event = asObject(JSON.parse(line));
    } catch {
      return;
    }
    if (event.type === "intent") observed.intent = event;
    else if (event.type === "prompt") observed.enhancedPrompt = str(event.enhancedPrompt);
    else if (event.type === "done") {
      observed.body = event;
      finished = true;
    } else if (event.type === "error") {
      observed.status = typeof event.status === "number" ? event.status : 500;
      observed.body = event;
      finished = true;
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(handle);
    }
    handle(buffer + decoder.decode());
  } catch {
    // cancelled
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  observed.cancelled = !finished;
  return observed;
}

async function videoSha(videoUrl: string) {
  try {
    return createHash("sha256").update(await readFile(videoFilePath(videoUrl))).digest("hex");
  } catch {
    return "";
  }
}

type PromptLogInput = {
  userId: string; projectId: string; surface: PromptSurface; body: Json; createdAt: string; observed?: Observed; thrown?: unknown;
};

async function writeRow(input: PromptLogInput) {
  const { body, observed } = input;
  const prompt = cap(promptOf(input.surface, body), PROMPT_CAP);
  const result = observed?.body ?? {};
  const project = asObject(result.project);
  const outcome = input.thrown !== undefined ? "error" : observed?.cancelled ? "cancelled" : (observed?.status ?? 500) >= 400 ? "error" : "ok";
  const error = input.thrown !== undefined
    ? (input.thrown instanceof Error ? input.thrown.message : String(input.thrown))
    : outcome === "error" ? str(result.error) || `HTTP ${observed?.status}` : outcome === "cancelled" ? "The client disconnected before the result." : "";
  const intent = observed?.intent ?? {};
  const window = asObject(result.window ?? intent.window);
  const videoUrl = str(project.videoUrl) || str(result.videoUrl);
  const projectId = str(project.id) || input.projectId;
  const summary = str(result.summary) || (str(result.reply) ? `Reply: ${str(result.reply)}` : "");
  const rangeStart = num(body.rangeStartSec) ?? num(window.startSec);
  const rangeEnd = num(body.rangeEndSec) ?? num(window.endSec);
  const atEnd = typeof result.atEnd === "boolean" ? result.atEnd : typeof intent.atEnd === "boolean" ? intent.atEnd : null;

  const row = {
    event_id: createHash("sha256").update(input.userId + projectId + input.createdAt + prompt).digest("hex"),
    user_id: input.userId,
    project_id: projectId,
    surface: input.surface,
    prompt,
    action: str(result.action) || str(intent.action),
    detected_by: str(result.detectedBy) || str(intent.detectedBy),
    range_start_sec: rangeStart,
    range_end_sec: rangeEnd,
    at_sec: num(body.atSec),
    at_end: atEnd,
    enhanced_prompt: cap(str(result.enhancedPrompt) || observed?.enhancedPrompt || "", ENHANCED_CAP),
    outcome,
    error: cap(error, ERROR_CAP),
    result_summary: cap(summary, SUMMARY_CAP),
    video_sha256: outcome === "ok" && videoUrl ? await videoSha(videoUrl) : "",
    duration_sec: outcome === "ok" ? num(project.durationSeconds) ?? num(result.durationSeconds) : num(body.durationSec),
    created_at: input.createdAt,
    app: "longform",
  };
  await withRetry("insert_user_prompt", () => getClient().insert({ table: USER_PROMPTS_TABLE, values: row }));
  invalidateUserContext(input.userId);
  logInfo("user_prompt_logged", { surface: input.surface, outcome, userId: input.userId === ANONYMOUS_USER ? ANONYMOUS_USER : "uuid", projectId: projectId || undefined });
}

function record(input: PromptLogInput) {
  void writeRow(input).catch((error) => logException("user_prompt_log_failed", error, { surface: input.surface }));
}

/**
 * Wraps a route handler: binds the X-Longform-User id for the request and logs the prompt afterwards (in the
 * background; the response is returned untouched). `surface` may depend on the JSON body (e.g. preset ad/company).
 */
export function logUserPrompt<Args extends unknown[]>(
  surface: PromptSurface | ((body: Json) => PromptSurface),
  handler: (request: Request, ...args: Args) => Promise<Response>,
) {
  return async (request: Request, ...args: Args): Promise<Response> => {
    const createdAt = new Date().toISOString();
    const userId = parseUserId(request.headers.get("x-longform-user"));
    let projectId = "";
    try {
      const params = await (asObject(args[0]).params as Promise<Json> | undefined);
      projectId = str(asObject(params).id);
    } catch {
      // no params
    }
    const body = asObject(await request.clone().json().catch(() => ({})));
    const researchSessionId = /^[A-Za-z0-9_-]{1,128}$/.test(str(body.researchSessionId)) ? str(body.researchSessionId) : undefined;
    const run = () => runWithUser(
      { userId, ...(projectId ? { projectId } : {}), ...(researchSessionId ? { researchSessionId } : {}) },
      () => handler(request, ...args),
    );
    let logging = false;
    try {
      logging = enabled();
    } catch {
      logging = false;
    }
    if (!logging) return run();

    const resolved = typeof surface === "function" ? surface(body) : surface;
    let response: Response;
    try {
      response = await run();
    } catch (thrown) {
      record({ userId, projectId, surface: resolved, body, createdAt, thrown });
      throw thrown;
    }
    try {
      const copy = response.clone();
      void observe(copy, request.signal)
        .then((observed) => record({ userId, projectId, surface: resolved, body, createdAt, observed }))
        .catch((error) => logException("user_prompt_observe_failed", error, { surface: resolved }));
    } catch (error) {
      logException("user_prompt_observe_failed", error, { surface: resolved });
    }
    return response;
  };
}
