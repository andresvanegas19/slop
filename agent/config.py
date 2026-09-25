"""Agent settings from the repository-root .env. Budgets are generous by default but always capped."""
import os
from dataclasses import dataclass
from pathlib import Path

from core.http import load_env

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = "liquid/lfm-2.5-2.6b:free"


def _int(name, default, low, high):
    raw = os.environ.get(name, "").strip()
    try:
        value = int(raw) if raw else default
    except ValueError:
        value = default
    return max(low, min(high, value))


@dataclass(frozen=True)
class AgentSettings:
    openrouter_key: str
    rawtree_key: str
    model: str
    max_tokens: int          # per LLM call; LFM always reasons first, so this must cover reasoning + answer
    max_steps: int           # ReAct tool steps per run
    observation_chars: int   # cap for one tool result shown to Liquid
    context_chars: int       # cap for all tool results in one run (LFM 2.5 has a ~32k-token window)
    prompt_timeout_s: int    # how long a prompt trigger may wait before the cached context is returned
    interval_s: int          # loop tick
    refresh_s: int           # max age of the cached loop context before it is rebuilt anyway
    host: str
    port: int
    state_db: str
    agent_db: str
    watch_file: str
    # Research sessions (agent/research.py). LFM 2.5 on OpenRouter: 65k-token window, at most 8192 output tokens.
    research_max_pages: int = 12           # pages fetched per round
    research_max_steps: int = 20           # ReAct steps per round
    research_max_rounds: int = 6           # rounds per session while looping
    research_interval_s: int = 60          # pause between rounds while looping
    research_max_tokens: int = 8192        # per LLM call (reasoning + answer)
    research_observation_chars: int = 16000  # one tool result shown to Liquid
    research_context_chars: int = 120000   # all observations kept in one round's conversation (older ones elided)
    research_reasoning: str = "medium"     # OpenRouter reasoning effort: low | medium | high

    @property
    def llm_enabled(self):
        return bool(self.openrouter_key)


def load_settings(**overrides) -> AgentSettings:
    if os.environ.get("AGENT_SKIP_ENV_FILE", "").strip().lower() not in ("1", "true", "yes"):
        load_env(str(ROOT / ".env"))
    values = dict(
        openrouter_key=os.environ.get("OPENROUTER_API_KEY", "").strip(),
        rawtree_key=os.environ.get("RAWTREE_API_KEY", "").strip(),
        model=os.environ.get("AGENT_MODEL", "").strip() or os.environ.get("OPENROUTER_MODEL", "").strip()
        or DEFAULT_MODEL,
        max_tokens=_int("AGENT_MAX_TOKENS", 8000, 256, 32000),
        max_steps=_int("AGENT_MAX_STEPS", 8, 1, 20),
        observation_chars=_int("AGENT_OBSERVATION_CHARS", 12000, 500, 60000),
        context_chars=_int("AGENT_CONTEXT_CHARS", 48000, 2000, 100000),
        prompt_timeout_s=_int("AGENT_PROMPT_TIMEOUT_S", 12, 1, 120),
        interval_s=_int("AGENT_INTERVAL_S", 300, 5, 86400),
        refresh_s=_int("AGENT_REFRESH_S", 1800, 30, 7 * 86400),
        host="127.0.0.1",
        port=_int("AGENT_PORT", 8765, 1024, 65535),
        state_db=os.environ.get("AGENT_STATE_DB", "").strip() or str(ROOT / "state.db"),
        agent_db=os.environ.get("AGENT_DB", "").strip() or str(ROOT / "agent.db"),
        watch_file=str(ROOT / "config" / "watch.yaml"),
        research_max_pages=_int("RESEARCH_MAX_PAGES", 12, 1, 60),
        research_max_steps=_int("RESEARCH_MAX_STEPS", 20, 1, 60),
        research_max_rounds=_int("RESEARCH_MAX_ROUNDS", 6, 1, 50),
        research_interval_s=_int("RESEARCH_INTERVAL_S", 60, 1, 86400),
        research_max_tokens=_int("RESEARCH_MAX_TOKENS", 8192, 256, 8192),
        research_observation_chars=_int("RESEARCH_OBSERVATION_CHARS", 16000, 1000, 60000),
        research_context_chars=_int("RESEARCH_CONTEXT_CHARS", 120000, 4000, 180000),
        research_reasoning=os.environ.get("RESEARCH_REASONING", "").strip().lower() if os.environ.get(
            "RESEARCH_REASONING", "").strip().lower() in ("low", "medium", "high") else "medium",
    )
    values.update({k: v for k, v in overrides.items() if v is not None})
    return AgentSettings(**values)
