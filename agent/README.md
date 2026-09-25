# agent: the company agent

A long-running LangChain agent. **RawTree** is its database, **Liquid** (`liquid/lfm-2.5-2.6b:free` through
OpenRouter) is its brain, and the models in `contracts/` are the tools it fires. It keeps a fresh, grounded
`CompanyContext` and hands it to the video app whenever a user asks for an image, clip, multi-shot, preset or
storyboard.

```bash
./run                                            # repo root: web + agent with core cycle AND publish to RawTree (permanent)
./run --no-publish                               # same, nothing written to RawTree (--no-core: no core cycle)
.venv/bin/python -m agent worker                 # loop + trigger on http://127.0.0.1:8765 (Ctrl-C to stop)
.venv/bin/python -m agent worker --run-core      # also run one core cycle per tick (RawTree evidence -> beliefs)
.venv/bin/python -m agent worker --publish       # also deliver the outbox to RawTree (rows are PERMANENT)
.venv/bin/python -m agent once [--no-llm]        # one tick, print the context
.venv/bin/python -m agent ask "launch video for our new plan" --kind video
.venv/bin/python -m agent show                   # latest cached context
.venv/bin/python -m agent publish                # deliver queued agent events (permanent!)
.venv/bin/python -m agent research "Make a company video for Coca-Cola" [--rounds 2]   # one research session
.venv/bin/python -m pytest tests -q              # offline tests, no network
```

Keys are read from the repository-root `.env` (`OPENROUTER_API_KEY`, `RAWTREE_API_KEY`). Without an OpenRouter key
the agent still works with a deterministic brief built from the same tools.

## How it works

```
RawTree slop_human* + core state.db ──tools (contracts/)──► ReAct loop ◄──► Liquid (OpenRouter)
                                                               │
                         agent.db: cached CompanyContext + outbox ──--publish──► slop_human_agent_* tables
                                                               │
     generation-video (src/lib/company-agent.ts) ──POST /context {prompt, kind}──┘
```

| File | Role |
|---|---|
| `config.py` | `AgentSettings` from `.env`; generous but clamped budgets (`AGENT_*`) |
| `llm.py` | `ChatOpenAI` pointed at OpenRouter (Liquid), retries, `max_tokens` covers LFM reasoning |
| `tools.py` | `CompanyTools`: `get_watch_brief`, `get_current_beliefs`, `get_recent_patches`, `get_recent_evidence`, `get_storyboards`, `get_run_metrics`, `get_previous_context`, as LangChain `StructuredTool`s |
| `react.py` | `CompanyAgent`: text ReAct (`Action:` / `Action Input:` / `Final Answer:`), grounding, deterministic fallback |
| `store.py` | `AgentStore` (`agent.db`): context cache, outbox, delivery to RawTree |
| `worker.py` | `AgentWorker` loop tick + 127.0.0.1 HTTP trigger + research session API |
| `research.py` | `ResearchSession` / `ResearchManager`: company website research, follow-up questions, `CompanyProfile` |
| `research_tools.py` | `ResearchTools`: `fetch_page`, `list_links`, `record_finding`, `get_findings`, `ask_user`, `get_user_answers`, `get_recent_videos`, `get_user_context` |
| `research_store.py` | `ResearchStore` (`agent.db`): sessions, append-only event log, fetched page text |
| `web.py` | Direct website fetching: host allowlist, robots.txt, 10 s / 1.5 MB caps, HTML → clean text, links, colors |
| `videos.py` | `get_recent_videos`: past videos from `slop_human_video_events` (read-only) |
| `user_context.py` | `get_user_context`: the user's past prompts from `slop_human_user_prompts` (read-only) |

- **Why text ReAct:** the free LFM model has no reliable native tool calling, so the model writes the action and
  code runs it. Unknown tools, bad arguments and tool errors come back as observations; nothing crashes the loop.
- **Tools never take SQL.** Queries are built in `tools.py` from fixed columns, allowlisted `slop_human*` tables,
  entity ids from `config/watch.yaml`, and a `LIMIT`. Test rows (`test_*`, spike runs) are skipped.
- **Grounding:** claims in the final answer keep a `belief_key`/evidence id only if a tool returned it in that run.
- **Loop:** each tick optionally runs core, then rebuilds the loop context when `state.db`'s version changes or the
  cache is older than `AGENT_REFRESH_S`.
- **Trigger:** `POST /context {"prompt", "kind"}` runs a prompt-focused pass. After `AGENT_PROMPT_TIMEOUT_S` it
  returns the cached context with `"stale": true`; at most two prompt runs execute at once.
- **Budgets:** `AGENT_MAX_TOKENS` per call (default 8000), `AGENT_MAX_STEPS` (8), `AGENT_OBSERVATION_CHARS` (12000)
  per tool result and `AGENT_CONTEXT_CHARS` (48000) per run, sized for LFM 2.5's ~32k-token window.

## Research sessions

"Generate a video for my company Coca-Cola" starts a session: Liquid extracts `{company_name, likely_domain,
video_goal}`, candidate domains (`https://www.<slug>.com`, ...) are verified by fetching (HTTP 200 + the name on the
page), then rounds run while `looping` is on (`RESEARCH_MAX_ROUNDS`, `RESEARCH_INTERVAL_S` apart; a round that finds
nothing new ends it):

1. ReAct loop over `ResearchTools` (Liquid picks tools; up to `RESEARCH_MAX_STEPS`, nudged to use its page budget).
2. Extraction pass: Liquid reads every fetched page (up to 24k chars) and proposes findings; **code keeps a finding only
   if its quote is verbatim on that page** (`record_finding` enforces the same rule).
3. Crawl fill up to `RESEARCH_MAX_PAGES` pages per round: best unvisited same-site links, spread across sections.
4. `CompanyProfile` (Liquid cites finding ids; code maps them to `evidence_url`s and drops uncited items), then 3-5
   follow-up questions with 2-4 options (Liquid; templates as fallback). Topics the user already settled (earlier
   answers for this company, style words / durations in their past prompts) are not asked again.
5. Answers (any time) are merged into `profile.video_brief` immediately.

Fetching: `LongformResearchBot/0.1`, robots.txt `Disallow` respected (with `*`/`$`), only the verified site and hosts
named after the company (e.g. `coca-colacompany.com`), 10 s timeout, 1.5 MB cap. Past videos
(`slop_human_video_events`) and the user's past prompts (`slop_human_user_prompts`) are read with fixed SQL; a table
that does not exist yet reads as empty.

Worker API (127.0.0.1 only; the web app proxies it under `/api/research`, forwarding `X-Longform-User`):

| Call | Result |
|---|---|
| `POST /research {prompt, looping?=true, user_id?}` | 201 `{session_id, status, looping, publish}`; 429 when 2 sessions already run |
| `GET /research/{id}` | `{status, company, domain, home_url, profile, questions:[{id, topic, question, options, answered, answer}], answers, findings, pages, stats:{pages, findings, tokens, llm_calls, rounds}, looping, running, error}` |
| `GET /research/{id}/events?after=<seq>&follow=1` | NDJSON, held open: `{seq, type, at, ...}` with type `status` / `page` / `finding` / `question` / `answer` / `profile` / `published` / `error`, plus `{"type":"heartbeat"}` every 15 s; ends when the session is `done` / `stopped` / `error` (or after 15 min). `follow=0`: backlog only |
| `POST /research/{id}/answer {question_id, answer}` | `{answered: true, video_brief}` |
| `POST /research/{id}/loop {looping}` | `{looping, running}`; `true` on a finished session starts more rounds |
| `POST /research/{id}/stop` | `{status}` (final) |

Status: `starting` → `researching` ⇄ `waiting` → `done` | `stopped` | `error`. Sessions live in `agent.db`; a restarted
worker marks running ones `done` (resume with `loop`). Budgets: `RESEARCH_*` in `.env.example`.

## Data boundaries

- Tool results (bounded RawTree rows) go to Liquid on OpenRouter, as core already does. Only the distilled
  `CompanyContext` (brief ≤ 1200 chars + claims) leaves the agent toward Next and BFL.
- Image-model prompts get a digits-free, visual-only hint (`companyVisualHint`); LLM writers get the brief and facts.
- The HTTP trigger listens on 127.0.0.1 only and does not log prompts.
- RawTree rows are permanent: the agent writes only with `--publish` / `publish`, with deterministic event ids.

RawTree tables written (only with `--publish`): `slop_human_agent_context_events` (CompanyContext),
`slop_human_agent_run_events` (AgentRunRecord), `slop_human_model_call_events` (ModelCallRecord, `purpose =
"agent_react"`), `slop_human_research_events` (ResearchEventRow: one row per page / finding / question / answer /
profile snapshot, deterministic `event_id`). Research sessions queue rows only when the worker publishes.
Read-only: `slop_human*` evidence and storyboards, `slop_human_video_events`, `slop_human_user_prompts`.
