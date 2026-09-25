"""B -> RawTree: the outbox and per-run metrics (PRD 10.3, 22)."""
from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel

from .common import SCHEMA_VERSION


class EventType(str, Enum):
    observation = "observation"
    patch = "patch"
    run = "run"
    model_call = "model_call"
    media = "media"
    evaluation = "evaluation"
    research = "research"


class OutboxEvent(BaseModel):
    """Written to SQLite in the same transaction as the state change, then delivered to RawTree.
    event_id is deterministic, so redelivery never duplicates a logical event."""
    event_id: str
    event_type: EventType
    table: str                          # from common.TABLES
    payload: dict
    created_at: datetime
    delivered_at: Optional[datetime] = None
    attempts: int = 0
    schema_version: str = SCHEMA_VERSION


class ModelCallRecord(BaseModel):
    call_id: str
    run_id: str
    purpose: str                        # "extract_facts" | "propose_patch" | "storyboard"
    model: str                          # "liquid/lfm-2.5-2.6b:free"
    input_tokens: int
    output_tokens: int
    reasoning_tokens: int = 0
    latency_ms: int
    ok: bool
    error: Optional[str] = None


class RunRecord(BaseModel):
    """One monitoring cycle. These numbers feed the stateful-vs-history chart."""
    run_id: str
    watch_id: str
    mode: str = "stateful"              # "stateful" | "baseline"
    started_at: datetime
    finished_at: Optional[datetime] = None
    pages_fetched: int = 0
    pages_invalid: int = 0              # status != ok
    skipped_unchanged: int = 0          # section hash unchanged, no Liquid call
    liquid_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    ops_proposed: int = 0
    ops_accepted: int = 0
    ops_rejected: int = 0
    active_beliefs: int = 0
    state_tokens: int = 0               # size of the state Liquid could be shown; should stay flat
    media_generated: int = 0
