const MAX_ATTEMPTS = 3;
const MAX_POLL_MS = 120_000;

export class BflError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

type Submission = { polling_url?: string };
type PollResponse = {
  status?: "Pending" | "Ready" | "Error";
  error?: string;
  message?: string;
  result?: { sample?: string };
};

function endpoint() {
  const configured = process.env.BFL_IMAGE_ENDPOINT ?? "https://api.bfl.ai/v1/flux-2-pro";
  const url = new URL(configured);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".bfl.ai") || !url.pathname.startsWith("/v1/")) {
    throw new BflError("BFL_IMAGE_ENDPOINT must be an HTTPS BFL /v1/ endpoint.");
  }
  return url.toString();
}

function headers() {
  const key = process.env.BFL_API_KEY;
  if (!key) throw new BflError("BFL_API_KEY is not configured on the server.");
  return { "Content-Type": "application/json", "x-key": key };
}

function retryable(status: number) {
  return status === 429 || status === 500 || status === 502 || status === 503;
}

async function request(url: string, init: RequestInit) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(url, init);
    if (response.ok || !retryable(response.status) || attempt === MAX_ATTEMPTS - 1) return response;
    const retryAfter = Number(response.headers.get("Retry-After"));
    const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new BflError("BFL request retries were exhausted.");
}

export async function generateBflImage(prompt: string, width = 1024, height = 576) {
  const submissionResponse = await request(endpoint(), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ prompt, width, height, output_format: "png" }),
  });
  if (!submissionResponse.ok) {
    throw new BflError("BFL rejected the image request.", submissionResponse.status);
  }

  const submission = await submissionResponse.json() as Submission;
  if (!submission.polling_url) throw new BflError("BFL did not return a polling URL.");
  const pollingUrl = new URL(submission.polling_url);
  if (pollingUrl.protocol !== "https:" || !pollingUrl.hostname.endsWith(".bfl.ai")) {
    throw new BflError("BFL returned an invalid polling URL.");
  }

  const deadline = Date.now() + MAX_POLL_MS;
  let interval = 500;
  while (Date.now() < deadline) {
    const pollResponse = await request(pollingUrl.toString(), { headers: { "x-key": headers()["x-key"] } });
    if (!pollResponse.ok) throw new BflError("Could not poll the BFL job.", pollResponse.status);
    const job = await pollResponse.json() as PollResponse;
    if (job.status === "Ready" && job.result?.sample) return job.result.sample;
    if (job.status === "Error") throw new BflError(job.message ?? job.error ?? "BFL generation failed.");
    await new Promise((resolve) => setTimeout(resolve, interval));
    interval = Math.min(interval * 2, 5000);
  }

  throw new BflError("BFL generation timed out.");
}
