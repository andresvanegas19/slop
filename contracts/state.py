"""B internal: current beliefs (SQLite) and the patches that change them (PRD 12)."""
import hashlib
import json
from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field, model_validator

from .common import SCHEMA_VERSION


class BeliefStatus(str, Enum):
    active = "active"
    disputed = "disputed"
    retracted = "retracted"
    expired = "expired"


def belief_key(entity_id: str, attribute: str) -> str:
    return "{}:{}".format(entity_id, attribute)       # "notion:pricing.plus.monthly_usd"


class Belief(BaseModel):
    """One fact the agent currently holds. Only the Reducer writes these."""
    belief_key: str
    entity_id: str
    attribute: str                      # typed path: pricing.<plan>.monthly_usd, jobs.<function>.count, ...
    value: Any
    unit: Optional[str] = None
    status: BeliefStatus = BeliefStatus.active
    confidence: float = Field(ge=0, le=1)
    first_seen_at: datetime
    last_confirmed_at: datetime
    valid_from: datetime
    expires_at: Optional[datetime] = None
    evidence_ids: list[str]             # obs_ids, most recent last (capped)
    source_ids: list[str] = []
    version: int = 1
    schema_version: str = SCHEMA_VERSION


class OpType(str, Enum):
    add = "add"
    replace = "replace"
    confirm = "confirm"
    dispute = "dispute"
    retract = "retract"
    expire = "expire"


class PatchOrigin(str, Enum):
    diff = "diff"        # Liquid extracted facts, code computed the op (numeric sources; DECISIONS D2)
    liquid = "liquid"    # Liquid proposed the op directly (narrative sources)
    expiry = "expiry"    # expiry worker


class PatchOp(BaseModel):
    op: OpType
    belief_key: str
    entity_id: str
    attribute: str
    before: Any = None
    after: Any = None
    unit: Optional[str] = None          # carried onto the Belief by add/replace
    confidence: float = Field(ge=0, le=1)
    significance: float = Field(ge=0, le=1)
    evidence_ids: list[str] = []
    reason: str = Field(max_length=280)

    @model_validator(mode="after")
    def _shape(self):
        if self.op == OpType.add and self.before is not None:
            raise ValueError("add must have before=None")
        if self.op in (OpType.add, OpType.replace, OpType.confirm, OpType.dispute) and not self.evidence_ids:
            raise ValueError("{} requires evidence_ids".format(self.op.value))
        if self.op == OpType.replace and self.before == self.after:
            raise ValueError("replace with before == after is a confirm")
        return self


class Patch(BaseModel):
    """A proposed state change. PatchValidator accepts or rejects it; only accepted patches reach the Reducer."""
    patch_id: str
    run_id: str
    base_state_version: int
    origin: PatchOrigin
    ops: list[PatchOp] = Field(min_length=1)
    observed_at: datetime
    schema_version: str = SCHEMA_VERSION

    @staticmethod
    def make_id(base_state_version: int, obs_ids: list[str], ops: list[PatchOp]) -> str:
        """PRD 20: hash of base version, ordered observations and operations."""
        raw = json.dumps([base_state_version, obs_ids, [o.model_dump(mode="json") for o in ops]], sort_keys=True)
        return hashlib.sha256(raw.encode()).hexdigest()[:24]


class PatchDecision(BaseModel):
    patch_id: str
    accepted: bool
    rejected_reasons: list[str] = []    # e.g. "unknown evidence id", "before != current value"
    new_state_version: Optional[int] = None


class StateSlice(BaseModel):
    """What Liquid sees for one entity: only relevant beliefs, never history (PRD 13)."""
    entity_id: str
    state_version: int
    beliefs: list[Belief]
