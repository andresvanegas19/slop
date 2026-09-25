import { loadEnvConfig } from "@next/env";
import { createHash } from "node:crypto";
import path from "node:path";
import { ClientAbortedError, abortableDelay, emitEvent, takeJobMemo, throwIfClientAborted } from "@/lib/progress";
import { logInfo } from "@/lib/runtime-log";

const MAX_ATTEMPTS = 3;
const MAX_POLL_MS = 120_000;
const MAX_VIDEO_POLL_MS = 300_000;
const MAX_DETAIL_LENGTH = 300;

export class BflError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

type Submission = { polling_url?: string };
type PollResponse = {
  status?: string;
  error?: string;
  message?: string;
  details?: unknown;
  /** Some BFL endpoints report 0–1 (or 0–100) progress while processing. */
  progress?: number;
  result?: { sample?: string };
};

const STATUS_HINTS: Record<number, string> = {
  400: "The request payload was invalid; check the prompt, dimensions, and input image.",
  401: "The BFL_API_KEY was rejected; confirm the key is correct and active.",
  402: "The BFL account is out of credits; top up at https://dashboard.bfl.ai.",
  403: "The BFL_API_KEY is not allowed to use this endpoint or model.",
  404: "The BFL endpoint was not found; check BFL_IMAGE_ENDPOINT.",
  422: "BFL could not validate the request parameters.",
  429: "BFL is rate limiting this key (too many concurrent or recent requests); wait and try again.",
  500: "BFL had an internal error; try again shortly.",
  502: "BFL is temporarily unavailable; try again shortly.",
  503: "BFL is temporarily unavailable; try again shortly.",
};

// Turns any thrown value into a readable, specific sentence, including nested `cause` chains
// (Node's fetch reports DNS/TLS/connection failures only as `TypeError: fetch failed` with a cause).
export function describeError(error: unknown, fallback: string) {
  if (error instanceof BflError) return error.message;
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      parts.push(typeof code === "string" && !current.message.includes(code) ? `${current.message} (${code})` : current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  const detail = parts.filter(Boolean).join(": ");
  return detail ? `${fallback.replace(/\.$/, "")}: ${detail}` : fallback;
}

function truncate(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_DETAIL_LENGTH ? `${clean.slice(0, MAX_DETAIL_LENGTH)}…` : clean;
}

// BFL error bodies are usually `{"detail": ...}`; fall back to the raw text.
async function responseDetail(response: Response) {
  const text = await response.text().catch(() => "");
  if (!text) return "";
  try {
    const body = JSON.parse(text) as { detail?: unknown; message?: unknown; error?: unknown };
    const detail = body.detail ?? body.message ?? body.error;
    if (typeof detail === "string") return truncate(detail);
    if (detail !== undefined) return truncate(JSON.stringify(detail));
  } catch {
    // Not JSON; use the raw body.
  }
  return truncate(text);
}

async function httpError(action: string, response: Response) {
  const detail = await responseDetail(response);
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  const hint = STATUS_HINTS[response.status];
  return new BflError(
    [`${action} (HTTP ${response.status}${statusText}).`, detail && `BFL said: "${detail}".`, hint]
      .filter(Boolean)
      .join(" "),
    response.status,
  );
}

async function readJson<T>(response: Response, action: string) {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BflError(`${action} returned a response that is not JSON: "${truncate(text) || "(empty body)"}".`);
  }
}

function loadServerEnvironment() {
  const development = process.env.NODE_ENV !== "production";
  loadEnvConfig(process.cwd(), development, undefined, true);
  loadEnvConfig(path.resolve(process.cwd(), ".."), development, undefined, true);
}

function endpoint() {
  const configured = process.env.BFL_IMAGE_ENDPOINT?.trim() || "https://api.bfl.ai/v1/flux-2-pro";
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new BflError(`BFL_IMAGE_ENDPOINT is not a valid URL: "${configured}".`);
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".bfl.ai") || !url.pathname.startsWith("/v1/")) {
    throw new BflError(`BFL_IMAGE_ENDPOINT must be an HTTPS BFL /v1/ endpoint (for example https://api.bfl.ai/v1/flux-2-pro), but it is "${configured}".`);
  }
  return url.toString();
}

function videoEndpoint() {
  loadServerEnvironment();
  const configured = process.env.BFL_VIDEO_ENDPOINT?.trim() || "https://api.bfl.ai/v1/flux-3-video";
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new BflError(`BFL_VIDEO_ENDPOINT is not a valid URL: "${configured}".`);
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".bfl.ai") || !url.pathname.startsWith("/v1/")) {
    throw new BflError(`BFL_VIDEO_ENDPOINT must be an HTTPS BFL /v1/ endpoint (for example https://api.bfl.ai/v1/flux-3-video), but it is "${configured}".`);
  }
  return url.toString();
}

function headers() {
  loadServerEnvironment();
  const key = process.env.BFL_API_KEY;
  if (!key) {
    throw new BflError("BFL_API_KEY is not configured on the server. Add BFL_API_KEY=... to .env.local (in generation-video/ or the project root) and restart the dev server.");
  }
  return { "Content-Type": "application/json", "x-key": key };
}

function retryable(status: number) {
  return status === 429 || status === 500 || status === 502 || status === 503;
}

async function request(url: string, init: RequestInit, action: string) {
  const host = new URL(url).host;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      throw new BflError(`${describeError(error, `${action} could not reach ${host} after ${MAX_ATTEMPTS} attempts`)}. Check the server's network connection, DNS, and any proxy/firewall.`);
    }
    if (response.ok || !retryable(response.status) || attempt === MAX_ATTEMPTS - 1) return response;
    const retryAfter = Number(response.headers.get("Retry-After"));
    const delay = response.headers.has("Retry-After") && Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new BflError(`${action} failed: retries were exhausted.`);
}

function validatedPollingUrl(submission: Submission) {
  if (!submission.polling_url) {
    throw new BflError(`BFL accepted the request but did not return a polling URL. Response: ${truncate(JSON.stringify(submission))}`);
  }
  const pollingUrl = new URL(submission.polling_url);
  if (pollingUrl.protocol !== "https:" || !pollingUrl.hostname.endsWith(".bfl.ai")) {
    throw new BflError(`BFL returned an unexpected polling URL host: "${pollingUrl.host}".`);
  }
  return pollingUrl;
}

async function pollForSample(pollingUrl: URL, maxPollMs: number, resultLabel: string) {
  const deadline = Date.now() + maxPollMs;
  let interval = 500;
  let lastStatus = "unknown";
  const startedAt = Date.now();
  while (Date.now() < deadline) {
    // Streaming clients that disconnected stop the wait (the remote job may keep running).
    throwIfClientAborted();
    const pollResponse = await request(pollingUrl.toString(), { headers: { "x-key": headers()["x-key"] } }, "Polling the BFL job");
    if (!pollResponse.ok) throw await httpError("Could not poll the BFL job", pollResponse);
    const job = await readJson<PollResponse>(pollResponse, "Polling the BFL job");
    lastStatus = job.status ?? "unknown";
    const progress = typeof job.progress === "number" && Number.isFinite(job.progress)
      ? Math.min(1, Math.max(0, job.progress > 1 ? job.progress / 100 : job.progress))
      : undefined;
    emitEvent({
      type: "progress",
      stage: resultLabel === "video" ? "video" : "image",
      status: lastStatus,
      ...(progress === undefined ? {} : { progress }),
      elapsedMs: Date.now() - startedAt,
    });
    if (job.status === "Ready" && job.result?.sample) return job.result.sample;
    if (job.status === "Ready") throw new BflError(`BFL reported the job as Ready but returned no ${resultLabel} URL.`);
    if (job.status === "Error" || job.status === "Failed") {
      const detail = job.message ?? job.error ?? (job.details === undefined ? "" : truncate(JSON.stringify(job.details)));
      throw new BflError(`BFL generation failed${detail ? `: ${detail}` : " without a reason"}.`);
    }
    if (job.status === "Content Moderated" || job.status === "Request Moderated") {
      throw new BflError(`BFL blocked this generation (${job.status}). Rephrase the prompt or use a different input image.`);
    }
    if (job.status === "Task not found") {
      throw new BflError("BFL no longer knows about this job (Task not found). The job may have expired; try again.");
    }
    await abortableDelay(interval);
    interval = Math.min(interval * 2, 5000);
  }

  throw new BflError(`BFL generation timed out after ${maxPollMs / 1000}s (last status: ${lastStatus}). BFL may be under heavy load; try again.`);
}

/** Identifies one BFL submission (endpoint + exact payload) so a resumed job can find the request it already paid for. */
function stepKey(kind: "image" | "video", url: string, payload: string) {
  return `${kind}:${createHash("sha256").update(url).update("\n").update(payload).digest("hex").slice(0, 24)}`;
}

/**
 * Submits `payload` to BFL and polls it. When the current background job is a resume of an interrupted attempt that
 * already submitted this exact request (< 1h ago), polls that request instead of paying for a new one; if the old
 * request can't be polled any more, falls back to a fresh submission. New submissions are reported as `bfl_pending`.
 */
async function submitAndPoll(kind: "image" | "video", url: string, payload: string, maxPollMs: number, action: string, rejected: string) {
  const step = stepKey(kind, url, payload);
  const previous = takeJobMemo(step);
  if (previous) {
    try {
      const pollingUrl = validatedPollingUrl({ polling_url: previous });
      logInfo("bfl_resume_polling", { kind, step });
      emitEvent({ type: "stage", stage: kind, label: kind === "video" ? "Picking up the video BFL was already generating…" : "Picking up the image BFL was already generating…" });
      const sample = await pollForSample(pollingUrl, maxPollMs, kind);
      // Delivery URLs are short-lived: only reuse a result that can still be downloaded.
      const probe = await fetch(sample, { headers: { Range: "bytes=0-0" } });
      await probe.body?.cancel().catch(() => undefined);
      if (probe.ok) return sample;
      throw new BflError(`the earlier result can no longer be downloaded (HTTP ${probe.status})`);
    } catch (error) {
      if (error instanceof ClientAbortedError) throw error;
      logInfo("bfl_resume_polling_failed", { kind, step, reason: error instanceof Error ? error.message.slice(0, 200) : String(error) });
    }
  }
  const submissionResponse = await request(url, { method: "POST", headers: headers(), body: payload }, action);
  if (!submissionResponse.ok) throw await httpError(rejected, submissionResponse);
  const submission = await readJson<Submission>(submissionResponse, action);
  const pollingUrl = validatedPollingUrl(submission);
  emitEvent({ type: "bfl_pending", step, pollingUrl: pollingUrl.toString() });
  return pollForSample(pollingUrl, maxPollMs, kind);
}

export async function generateBflImage(
  prompt: string,
  width = 1024,
  height = 576,
  inputImage?: string,
  seed?: number,
) {
  const payload = JSON.stringify({
    prompt,
    width,
    height,
    output_format: "png",
    ...(inputImage ? { input_image: inputImage } : {}),
    ...(seed === undefined ? {} : { seed }),
  });
  return submitAndPoll("image", endpoint(), payload, MAX_POLL_MS, "BFL image request", "BFL rejected the image request");
}

/** FLUX 3 accepts whole-second durations from 5 to 20; shorter clips must be trimmed after download. */
export const FLUX3_MIN_DURATION_SEC = 5;
export const FLUX3_MAX_DURATION_SEC = 20;
const MAX_FINAL_VIDEO_POLL_MS = 900_000;

/**
 * FLUX 3 keyframes: one image (start), two images (start + end, interpolated), or up to 10 `[seconds, image]` pins.
 * Images are URLs or base64. Passed through as-is.
 */
export type Flux3Keyframe = string | [number, string];

/** "draft" = fast HD preview (`draft: true`, `hd`); "final" = full-quality generation delivered at `fhd` (1920x1088). */
export type VideoQuality = "draft" | "final";
/** Where a video is generated: storyboards/presets, the first quick clip, or edits/appends/continuations. */
export type VideoQualityContext = "storyboard" | "clip" | "edit";

const QUALITY_DEFAULTS: Record<VideoQualityContext, VideoQuality> = { storyboard: "final", clip: "final", edit: "draft" };

export function isVideoQuality(value: unknown): value is VideoQuality {
  return value === "draft" || value === "final";
}

/**
 * Resolves the video quality: explicit request option → BFL_VIDEO_QUALITY_<CONTEXT> (STORYBOARD | CLIP | EDIT) →
 * BFL_VIDEO_QUALITY (all contexts) → defaults (storyboard/clip = final, edit = draft).
 */
export function videoQuality(context: VideoQualityContext, requested?: unknown): VideoQuality {
  if (isVideoQuality(requested)) return requested;
  loadServerEnvironment();
  const specific = process.env[`BFL_VIDEO_QUALITY_${context.toUpperCase()}`]?.trim().toLowerCase();
  if (isVideoQuality(specific)) return specific;
  const global = process.env.BFL_VIDEO_QUALITY?.trim().toLowerCase();
  if (isVideoQuality(global)) return global;
  return QUALITY_DEFAULTS[context];
}

type QualitySettings = { draft: boolean; resolution: "hd" | "fhd" };
const QUALITY_LADDER: Record<VideoQuality, QualitySettings[]> = {
  final: [{ draft: false, resolution: "fhd" }, { draft: false, resolution: "hd" }, { draft: true, resolution: "hd" }],
  draft: [{ draft: true, resolution: "hd" }],
};
// Index into the "final" ladder of the first settings BFL accepted in this process (skip known rejections).
let acceptedFinalStep = 0;

function qualityRejected(error: unknown) {
  return error instanceof BflError && (error.status === 400 || error.status === 422)
    && /resolution|draft|fhd|quality|mode/i.test(error.message);
}

export type BflVideoResult = { url: string; draft: boolean; resolution: "hd" | "fhd"; quality: VideoQuality };

/**
 * Submits a FLUX 3 video job (`t2v`, `i2v` with `keyframes`, or `v2v` with `startVideo`) and returns the short-lived
 * signed MP4 URL plus the quality settings BFL accepted. `quality: "final"` asks for `draft: false` + `fhd`; if BFL
 * rejects that, it falls back to `hd` and then to a draft (logged via the progress stream).
 */
export async function generateBflVideoDetailed(input: {
  prompt: string;
  keyframes?: Flux3Keyframe[];
  generateAudio?: boolean;
  /** Whole seconds, 5–20 (default FLUX3_MIN_DURATION_SEC). */
  durationSec?: number;
  /** Base64 MP4 (or URL) to continue from its final frames → `mode: "v2v"` with `start_video`. */
  startVideo?: string;
  /** Default: videoQuality("edit") (draft unless configured). */
  quality?: VideoQuality;
  /** Default "16:9". */
  aspectRatio?: "16:9" | "9:16" | "1:1";
}): Promise<BflVideoResult> {
  const quality = input.quality ?? videoQuality("edit");
  const ladder = QUALITY_LADDER[quality];
  const first = quality === "final" ? acceptedFinalStep : 0;
  const duration = Math.min(FLUX3_MAX_DURATION_SEC, Math.max(FLUX3_MIN_DURATION_SEC, Math.round(input.durationSec ?? FLUX3_MIN_DURATION_SEC)));
  for (let step = first; step < ladder.length; step += 1) {
    const settings = ladder[step];
    try {
      const payload = JSON.stringify({
        mode: input.startVideo ? "v2v" : input.keyframes?.length ? "i2v" : "t2v",
        prompt: input.prompt,
        ...(input.startVideo ? { start_video: input.startVideo } : input.keyframes?.length ? { keyframes: input.keyframes } : {}),
        duration,
        aspect_ratio: input.aspectRatio ?? "16:9",
        resolution: settings.resolution,
        draft: settings.draft,
        generate_audio: input.generateAudio ?? true,
      });
      const url = await submitAndPoll("video", videoEndpoint(), payload, settings.draft ? MAX_VIDEO_POLL_MS : MAX_FINAL_VIDEO_POLL_MS, "BFL video request", "BFL rejected the video request");
      if (quality === "final") acceptedFinalStep = step;
      return { url, draft: settings.draft, resolution: settings.resolution, quality: settings.draft ? "draft" : "final" };
    } catch (error) {
      if (step === ladder.length - 1 || !qualityRejected(error)) throw error;
      const next = ladder[step + 1];
      logInfo("bfl_video_quality_fallback", { rejected: `${settings.resolution}/draft=${settings.draft}`, next: `${next.resolution}/draft=${next.draft}`, reason: (error as Error).message.slice(0, 200) });
      emitEvent({ type: "stage", stage: "video", label: `BFL rejected ${settings.resolution}${settings.draft ? " draft" : ""}; retrying at ${next.resolution}${next.draft ? " draft" : ""}…` });
    }
  }
  throw new BflError("BFL video request failed: no quality setting was accepted.");
}

/** Same as generateBflVideoDetailed, returning only the signed MP4 URL. */
export async function generateBflVideo(input: Parameters<typeof generateBflVideoDetailed>[0]) {
  return (await generateBflVideoDetailed(input)).url;
}
