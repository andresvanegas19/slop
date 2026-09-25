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
| `worker.py` | `AgentWorker` loop tick + 127.0.0.1 HTTP trigger |

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

## Data boundaries

- Tool results (bounded RawTree rows) go to Liquid on OpenRouter, as core already does. Only the distilled
  `CompanyContext` (brief ≤ 1200 chars + claims) leaves the agent toward Next and BFL.
- Image-model prompts get a digits-free, visual-only hint (`companyVisualHint`); LLM writers get the brief and facts.
- The HTTP trigger listens on 127.0.0.1 only and does not log prompts.
- RawTree rows are permanent: the agent writes only with `--publish` / `publish`, with deterministic event ids.

RawTree tables written: `slop_human_agent_context_events` (CompanyContext), `slop_human_agent_run_events`
(AgentRunRecord), `slop_human_model_call_events` (ModelCallRecord, `purpose = "agent_react"`).
