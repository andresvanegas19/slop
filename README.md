# Longform

**Prompt-to-video studio you edit by chatting.**

![Longform editor: timeline with shots on the left, chat with automatic edit detection and memory sources on the right](docs/images/editor.png)

Longform turns a single prompt into a real-looking, emotional short video. Ask for "a company video for Coca-Cola" and an AI agent researches the brand, asks a few follow-up questions, writes the story, and renders it with FLUX 3. Then edit it like a conversation: grab any moment on the timeline and say what to change ("make it snow", "make it 3 seconds longer"). Only that part is regenerated.

Every video, prompt and research finding is stored in **RawTree**, so the agent (powered by **Liquid**) gets better with each video you make.

**Built with:** Liquid LFM (via OpenRouter) · RawTree · Black Forest Labs FLUX 3 · Nimble (optional) · Next.js · LangChain

### Technical overview

A Next.js 16 app (React 19, Tailwind v4, Motion) talks to a local Python agent (LangChain ReAct) over loopback HTTP.
- **Brain:** Liquid LFM 2.5 on OpenRouter. It detects intent (edit, answer, extend, cut, new video), rewrites prompts, and writes stories through a draft → critique → revise loop.
- **Memory:** BM25 search over markdown knowledge files, plus RawTree (past videos, your prompts, research findings). It's injected into every model call with visible sources.
- **Video:** BFL FLUX 2 makes keyframes. FLUX 3 turns them into video (i2v), continues clips (v2v), and interpolates between pinned start, middle and end frames. ffmpeg splices ranges frame-accurately, joins shots and mixes narration.
- **Resilience:** generations run as persisted background jobs that stream NDJSON progress, survive page reloads and can resume after a restart.
- **Observability:** every request carries a trace ID that flows through structured NDJSON logs.

---

## Quick start

```bash
# 1. Keys: copy the template and fill in at least BFL, OpenRouter and RawTree
cp .env.example .env

# 2. Python env for the agent (once)
python3.12 -m venv .venv && .venv/bin/pip install -e .

# 3. Run the web app (:3000) and the agent worker (:8765) together
./run                 # publishes to RawTree (rows are permanent)
./run --no-publish    # same, but nothing is written to RawTree
```

Open http://localhost:3000. `./run web` or `./run agent` starts only one side. If the dev server serves stale code after big changes, stop it and run `rm -rf generation-video/.next/dev/cache` before starting again.

**Requirements:** Node 20+, Python 3.12+, `ffmpeg`/`ffprobe` on your PATH. Narration uses macOS `say` and is skipped elsewhere.

## What you can do

| From the composer | What happens |
|---|---|
| Type a prompt | A short cinematic clip (FLUX 3, phone-footage look, with sound) |
| **+ → New ad / Company short** | Liquid writes a multi-scene story (draft → critique → revise), then every scene renders as real video (5/10/15/30s) |
| **+ → Company short** with a company name | A **research agent** reads the company's website, records grounded findings, and asks you follow-up questions in the chat before it creates the video |
| **+ → Market update** | Finds your competitors (Nimble), summarizes what changed, and renders it as a video |
| **+ → Stories** | 3–4 short stories with 3 realistic stills each; pick one and it becomes one continuous video |
| **+ → Storyboard file** | Render your own JSON storyboard |
| 📎 attach / drop a video | Start a project from your own footage |

**Editing an open video** (Auto mode decides what you meant):

- **Grab a moment** or drag a range on the timeline, then say what to change. Only that range is regenerated, and its start and end frames are pinned so it blends back in.
- **"Make it 3 seconds longer"** or a prompt at the end of the video continues the motion (FLUX 3 video-to-video).
- **"Remove this part"** cuts the selected range. You can also delete whole shots or append a video from history.
- **Ask a question** about the frame and get an answer without changing anything.
- Progress streams live (steps, rewritten prompt, preview frame). Jobs keep running in the background if you reload the page.

## How it works

```
Browser (Next.js UI) ──► Next.js API routes ──► background jobs
                              │                      │
                              │                      ├─► OpenRouter · Liquid LFM   (intent, prompts, stories, critique)
                              │                      ├─► BFL FLUX 2/3             (keyframes, i2v / v2v / pinned clips)
                              │                      └─► ffmpeg                   (splice, concat, overlays, narration mix)
                              │
                              ├─► memory: knowledge/*.md + RawTree (past videos, your prompts, research findings)
                              └─► Python agent worker (127.0.0.1:8765)
                                      ├─ company research sessions (website fetch / Nimble, grounded findings, questions)
                                      ├─ market updates and the core change-to-video cycle
                                      └─ Liquid as the brain (LangChain ReAct), RawTree as the database
```

**RawTree tables** (shared DB, so only `slop_human*` tables are ever written, and rows are permanent):

| Table | Contents |
|---|---|
| `slop_human` | Competitor observations (scraper) |
| `slop_human_video_events` / `slop_human_video_chunks` | Every finished video: metadata + the MP4 in base64 chunks |
| `slop_human_user_prompts` | Every prompt you send, used as your personal context |
| `slop_human_research_events` | Research findings, questions, answers and company profiles |
| `slop_human_agent_*` | Agent context, runs and model calls |

## Repository layout

| Path | What's there |
|---|---|
| `generation-video/` | Next.js app: UI (`src/components/studio`), API routes (`src/app/api`), pipeline libs (`src/lib`), RAG knowledge (`knowledge/`) |
| `agent/` | Python company agent: research sessions, market updates, stories, HTTP worker |
| `core/` | Long-horizon change detection: evidence → beliefs → storyboard |
| `acquisition/` | Nimble search/extract and RawTree client |
| `contracts/` | Shared Pydantic models (the agent's tools and events) |
| `config/watch.yaml` | What the core cycle watches |
| `tests/` | Offline Python tests: `.venv/bin/python -m pytest tests -q` |
| `docs/` | Architecture, decisions, logging, RawTree schemas |

## Configuration

All settings live in the root `.env` (see `.env.example` for the full, commented list).

| Required | Purpose |
|---|---|
| `BFL_API_KEY` | Image and video generation |
| `OPENROUTER_API_KEY` | Liquid LFM (default model `liquid/lfm-2.5-2.6b:free`) |
| `RAWTREE_API_KEY` | Memory and storage |

| Optional (common) | Purpose |
|---|---|
| `NIMBLE_API_KEY` | Market updates and better research search; without it research fetches websites directly |
| `BFL_VIDEO_QUALITY` | `final` (full quality, 1080p) or `draft` (fast previews) |
| `RAWTREE_PUBLISH_VIDEOS`, `RAWTREE_PUBLISH_PROMPTS` | Set to `0` to stop writing videos or prompts to RawTree |
| `STORY_ITERATIONS` | Draft → critique → revise passes for stories (1–3) |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` |

## Logs and debugging

- **In the app:** press **Ctrl+`** (or the **Logs** button) for a live timeline. "View log" on a result filters to that request.
- **Files:** `generation-video/output/logs/<date>.ndjson` (web and agent, one JSON line per event).
- **API:** `/api/logs?traceId=…` follows one request from prompt to MP4. Every response carries an `X-Trace-Id` header.
- **Memory:** `/api/memory?q=…` shows what the model would retrieve.

See [`docs/LOGGING.md`](docs/LOGGING.md) for the event catalogue.

## More docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): system design
- [`docs/DECISIONS.md`](docs/DECISIONS.md): design decisions
- [`docs/RAWTREE_VIDEOS.md`](docs/RAWTREE_VIDEOS.md) and [`docs/RAWTREE_USER_CONTEXT.md`](docs/RAWTREE_USER_CONTEXT.md): RawTree schemas
- [`agent/README.md`](agent/README.md): the Python agent and its HTTP API
- [`generation-video/knowledge/README.md`](generation-video/knowledge/README.md): adding knowledge for the RAG
- [`PRD.md`](PRD.md): product requirements
