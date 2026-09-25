# Logging

Every server-side step of a video — the HTTP request, intent detection, memory lookup, each OpenRouter call, each
BFL image/video job, every ffmpeg run, RawTree reads/writes, background jobs, and the Python agent's LLM/tool calls —
writes one structured log line. All lines of one user action share a **trace id**, so you can follow a video from the
prompt to the MP4.

## Where to look

| Where | What |
| --- | --- |
| Terminal (`./run`) | One colored line per event: `[longform] 15:23:48.141 INFO  trace=ab12cd34 job=5de5992c llm_call_done model=… purpose=decideFrameChat promptTokens=961 in 771ms (+1.0s)`. `(+1.0s)` is the time since the trace started. The agent prints `[agent] … trace=… session=… event … (logger)`. |
| Files | `generation-video/output/logs/<YYYY-MM-DD>.ndjson` (web) and `agent-<YYYY-MM-DD>.ndjson` (Python agent): one JSON object per line, new file each day, deleted after `LOG_RETENTION_DAYS` (14). Git-ignored. |
| Logs drawer | In the app: **Ctrl+`** or the **Logs** button in the side panel footer. Live tail of both files, filter by level, *Current job* / *Current project*, free-text search. Click a trace id to see only that flow; click a row for the full JSON. Chat results and errors have a **View log** link that opens the drawer on their trace. |
| `GET /api/logs` | Query: `traceId`, `jobId`, `projectId`, `since` (ISO, epoch ms, or seconds ago), `level` (min), `source` (`web`/`agent`), `event` (substring), `q` (text), `limit` (default 300, max 5000). Returns `{ entries, total, truncated, files }`, oldest first. `jobId`/`projectId` also pull in every line of the traces they belong to (e.g. the POST that created the job). |
| `GET /api/logs/stream` | NDJSON live tail with the same filters plus `backfill=N` (recent lines first). `{"type":"ping"}` every 15s. |

Settings (env / `.env`): `LOG_LEVEL` console level (`debug`/`info`/`warn`/`error`, default `info`), `LOG_FILE_LEVEL`
(default `debug` — files keep everything), `LOG_COLOR=0|1`, `LOG_DIR`, `LOG_RETENTION_DAYS`.

## Line format (NDJSON)

```json
{"ts":"2026-09-25T22:47:55.979Z","level":"info","event":"llm_call_done","source":"web",
 "traceId":"d4027f30db52","jobId":"5de5992c-…","projectId":"a8f7dced-…","route":"/api/projects/…/command",
 "model":"liquid/lfm-2.5-2.6b:free","purpose":"decideFrameChat","promptTokens":961,"completionTokens":102,"durationMs":771}
```

Envelope: `ts`, `level`, `event`, `source` (`web` | `agent`), `traceId`, and when known `jobId`, `projectId`, `userId`,
`route` (agent: `sessionId`, `logger`). `durationMs` is always the duration field. Errors add `error`, `errorName` and a
capped `stack`.

**Never logged:** API keys (`*key*`, `authorization`, `token`, … fields are `[redacted]`; `sk-or-…`/`Bearer …`
substrings and signed-URL query parameters are masked), data URIs, full prompts (prompts/messages are cut to 200 chars;
other strings to 500).

## Following one video from prompt to MP4

1. Every `/api/*` response has an `X-Trace-Id` header (send your own `X-Trace-Id` to choose it). In the UI, click
   **View log** under the result, or open the drawer and click the trace id of the `route_done` line.
2. `curl 'localhost:3000/api/logs?traceId=<id>&level=debug'` returns the whole flow. For a background job
   (`?job=1` → `202 { jobId }`) use `?jobId=<jobId>` — job lines carry both the job id and the trace of the request
   that created it; resumed jobs keep that trace.
3. Calls to the Python agent forward the trace id (`X-Trace-Id`), so `agent` lines (`http_request_done`, the agent's
   `llm_call_done`, `tool_call_done`, `research_*`) appear in the same query. Research sessions log with
   `sessionId` and the trace of the request that started them.

A typical `/command` answer: `route_started` → `route_done` (headers; `streamed=true`) → `progress_stage guidance` →
`rawtree_query` → `memory_retrieved` → `intent_detected detectedBy=rules` → `frame_ask_started` → `llm_call_started` →
`llm_call_done` → `frame_ask_completed` → `route_stream_closed` (total time) → `rawtree_insert` → `user_prompt_logged`.
A generation adds `bfl_submit_started` → `bfl_submitted pollingId=…` → `bfl_status from=… to=…` (each transition) →
`bfl_ready polls=… durationMs=…` → `proc_done tool=ffmpeg operation=concat|xfade|…` → `…_completed`.

With `jq`: `jq -c 'select(.traceId=="<id>") | [.ts[11:23], .level, .event, .durationMs]' generation-video/output/logs/*.ndjson`.
Slowest steps today: `jq -s 'map(select(.durationMs)) | sort_by(-.durationMs) | .[:10][] | [.event,.durationMs,.traceId]' generation-video/output/logs/$(date +%F).ndjson`.

## Event catalogue

Web (`source: "web"`):

| Event | Level | Fields |
| --- | --- | --- |
| `route_started` / `route_done` / `route_failed` | debug / info (warn 4xx, error 5xx; debug for media & polling routes) | `method`, `status`, `query`, `streamed`, `durationMs` |
| `route_stream_closed` | info | NDJSON stream finished; `durationMs` = whole request |
| `progress_stage` / `progress_intent` / `progress_prompt` / `progress_story` / `progress_story_status` / `progress_error` | info | Mirror of what the UI shows (`stage`, `label`, `atMs`; `action`, `detectedBy`; enhanced prompt preview) |
| `progress_poll` / `progress_preview` | debug | BFL progress %, preview images |
| `job_queued` / `job_started` / `job_finished` / `job_finished_error` / `job_failed` / `job_resumed` / `job_interrupted` | info / warn | `kind`, `attempt`, `waitedMs`, `status`, `httpStatus`, `error`, `events`, `durationMs` (run), `totalMs` (incl. queue) |
| `llm_call_started` / `llm_call_done` / `llm_call_retry` / `llm_call_failed` / `llm_call_aborted` | debug / info / warn | `model`, `purpose` (calling function), `streamed`, `promptChars`, `responseChars`, `toolCalls`, `finishReason`, `promptTokens`, `completionTokens`, `totalTokens`, `cost`, `attempts`, `memoized`, `durationMs` |
| `bfl_submit_started` / `bfl_submitted` / `bfl_status` / `bfl_ready` / `bfl_failed` / `bfl_aborted` | debug / info / warn | `kind` (image/video), `endpoint`, `mode` (t2i/edit/t2v/i2v/v2v), `quality`, `draft`, `resolution`, `durationSec`, `pollingId`, `submitMs`, `from`→`to`, `polls`, `phase`, `durationMs` |
| `bfl_resume_polling` / `bfl_resume_polling_failed` / `bfl_video_quality_fallback` | info / warn | Job resume and quality ladder |
| `proc_done` / `proc_failed` | info (ffprobe: debug) / warn | `tool` (ffmpeg/ffprobe/swift), `operation` (probe, frame_grab, concat, xfade, trim, overlay, still_to_video, psnr, filter, transcode), `exitCode`, `output`, `stderr` tail on failure, `durationMs` |
| `rawtree_query` / `rawtree_insert` / `rawtree_tables` (+ `_failed`) | debug (info when > 3s) / warn | `table`, `sql` (200 chars), `rows`, `op`, `durationMs` |
| `memory_retrieved` | info | `candidates`, `sources`, `byKind` (`knowledge:2,video:1`), `chars`, `query`, `durationMs` |
| `intent_detected` | info | `action`, `detectedBy` (llm/rules), `strong`, `atEnd` |
| `agent_call_done` / `agent_call_failed` | debug / warn | Web → Python agent: `method`, `path`, `status`, `durationMs` |
| Feature events | info / warn | Existing names such as `cinematic_scene_phase`, `video_generation_completed`, `frame_ask_completed`, `project_append_completed`, `storyboard_render_completed`, `user_prompt_logged` … (events ending in `_failed`/`_error`/`_rejected`/`_unavailable` are warnings) |
| `application_started` | info | `logLevel`, `logDir`, `pid` |

Agent (`source: "agent"`, `generation-video/output/logs/agent-<date>.ndjson`):

| Event | Level | Fields |
| --- | --- | --- |
| `http_request_done` / `http_request_failed` | info (debug for /health and session polling) | `method`, `path`, `status`, `durationMs`; trace from the web app's `X-Trace-Id` (echoed back) |
| `llm_call_started` / `llm_call_done` / `llm_call_failed` | debug / info / warn | `model`, `purpose`, `promptChars`, `responseChars`, `inputTokens`, `outputTokens`, `reasoningTokens`, `durationMs` (every LangChain call via `agent/llm_log.py`; core's `LiquidAdapter` adds `runId`, `attempts`, `status`) |
| `tool_call_done` | info / warn | `tool`, `step`, `round`, `ok`, `inputChars`, `outputChars`, `error`, `durationMs` |
| `research_status` / `research_question` / `research_profile` / `research_error` / `research_*` | info / warn / debug | Mirror of the research session's event log (`status`, `message`, `tool`, …) |
| `competitors_*` | info | Competitor research progress |
| `agent_tick` | info / warn | `core`, `refreshed`, `steps`, `llmCalls`, `tokens`, `published`, errors, `durationMs` |
| `core_cycle_done` | info | `runId`, `pages`, `opsProposed`, `opsAccepted`, `opsRejected`, `storyboard`, `durationMs` |
| `prompt_run_failed` | warn | `/context` prompt run failed |
| `<logger>_log` | any | Plain `log.info(...)` lines from older code (`msg` field) |

## Adding logs

TypeScript (`src/lib/runtime-log.ts`):

```ts
import { logInfo, logSpan, withTrace, annotateTrace } from "@/lib/runtime-log";
logInfo("thing_happened", { projectId, frames: 3 });                  // trace fields are added automatically
const clip = await logSpan("clip_render", { frames: 3 }, () => render()); // clip_render_started/_done/_failed + durationMs
annotateTrace({ projectId });                                         // later lines of this trace carry projectId
```

New route handlers: `export const POST = withRouteLog(handler)` (`src/lib/route-log.ts`). Child processes and RawTree
clients are instrumented automatically (`process-log.ts`, `rawtree-log.ts`); OpenRouter calls take an optional
`purpose`.

Python (`core/logs.py`):

```python
from core.logs import event, span, log_context, in_context
event(log, "thing_happened", frames=3)
with span(log, "fetch_page", url=url) as extra:
    extra["bytes"] = len(body)
threading.Thread(target=in_context(fn, sessionId=sid))   # threads don't inherit the trace otherwise
```
