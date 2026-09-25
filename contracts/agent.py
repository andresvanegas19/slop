"""Agent contracts: what the LangChain company agent (agent/) produces and records.

CompanyContext is the only thing the video app receives from the agent: a distilled brief
plus claims that point at beliefs and evidence. Raw RawTree rows never leave the agent.
"""
import hashlib
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

from .common import SCHEMA_VERSION

MAX_BRIEF_CHARS = 1200


class ContextClaim(BaseModel):
    """A fact the brief relies on. belief_key/evidence_ids are empty when the fact came from config only."""
    text: str = Field(max_length=280)
    belief_key: Optional[str] = None
    evidence_ids: list[str] = []


class CompanyContext(BaseModel):
    context_id: str
    generated_at: datetime
    trigger: str                        # "loop" | "prompt"
    kind: Optional[str] = None          # image | video | multishot | storyboard | preset (prompt triggers only)
    entities: list[str] = []
    brief: str = Field(max_length=MAX_BRIEF_CHARS)
    claims: list[ContextClaim] = []
    state_version: Optional[int] = None
    tools_used: list[str] = []
    model: str
    schema_version: str = SCHEMA_VERSION

    @staticmethod
    def make_id(trigger: str, generated_at: datetime, brief: str) -> str:
        raw = "|".join([trigger, generated_at.isoformat(), brief])
        return hashlib.sha256(raw.encode()).hexdigest()[:24]


class AgentToolCall(BaseModel):
    step: int
    tool: str
    ok: bool
    input_chars: int = 0
    output_chars: int = 0
    error: Optional[str] = None


class AgentRunRecord(BaseModel):
    """One agent invocation (loop tick or prompt trigger)."""
    agent_run_id: str
    trigger: str
    started_at: datetime
    finished_at: Optional[datetime] = None
    steps: int = 0
    llm_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    tool_calls: list[AgentToolCall] = []
    context_id: Optional[str] = None
    ok: bool = True
    error: Optional[str] = None
    is_test: bool = False
    schema_version: str = SCHEMA_VERSION
