import { loadEnvConfig } from "@next/env";
import path from "node:path";

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
  while (Date.now() < deadline) {
    const pollResponse = await request(pollingUrl.toString(), { headers: { "x-key": headers()["x-key"] } }, "Polling the BFL job");
    if (!pollResponse.ok) throw await httpError("Could not poll the BFL job", pollResponse);
    const job = await readJson<PollResponse>(pollResponse, "Polling the BFL job");
    lastStatus = job.status ?? "unknown";
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
    await new Promise((resolve) => setTimeout(resolve, interval));
    interval = Math.min(interval * 2, 5000);
  }

  throw new BflError(`BFL generation timed out after ${maxPollMs / 1000}s (last status: ${lastStatus}). BFL may be under heavy load; try again.`);
}

export async function generateBflImage(
  prompt: string,
  width = 1024,
  height = 576,
  inputImage?: string,
  seed?: number,
) {
  const submissionResponse = await request(endpoint(), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      prompt,
      width,
      height,
      output_format: "png",
      ...(inputImage ? { input_image: inputImage } : {}),
      ...(seed === undefined ? {} : { seed }),
    }),
  }, "BFL image request");
  if (!submissionResponse.ok) {
    throw await httpError("BFL rejected the image request", submissionResponse);
  }
  const submission = await readJson<Submission>(submissionResponse, "BFL image request");
  return pollForSample(validatedPollingUrl(submission), MAX_POLL_MS, "image");
}

/** FLUX 3 accepts whole-second durations from 5 to 20; shorter clips must be trimmed after download. */
export const FLUX3_MIN_DURATION_SEC = 5;

/**
 * Submits a FLUX 3 video job (`t2v`, or `i2v` with `keyframes`) and returns the short-lived signed MP4 URL.
 * Uses draft mode (fast HD preview) at the minimum duration to keep generation time low.
 */
export async function generateBflVideo(input: {
  prompt: string;
  keyframes?: string[];
  generateAudio?: boolean;
}) {
  const submissionResponse = await request(videoEndpoint(), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      mode: input.keyframes?.length ? "i2v" : "t2v",
      prompt: input.prompt,
      ...(input.keyframes?.length ? { keyframes: input.keyframes } : {}),
      duration: FLUX3_MIN_DURATION_SEC,
      aspect_ratio: "16:9",
      resolution: "hd",
      draft: true,
      generate_audio: input.generateAudio ?? true,
    }),
  }, "BFL video request");
  if (!submissionResponse.ok) {
    throw await httpError("BFL rejected the video request", submissionResponse);
  }
  const submission = await readJson<Submission>(submissionResponse, "BFL video request");
  return pollForSample(validatedPollingUrl(submission), MAX_VIDEO_POLL_MS, "video");
}
