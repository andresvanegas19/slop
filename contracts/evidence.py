"""A -> B contract: what acquisition produces.

WatchBrief and SourceRecipe are A's configuration (PRD 11.1, 11.2).
EvidenceEnvelope is one row in RawTree table `slop_human` (PRD 11.5): one per Nimble fetch.
"""
import hashlib
from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, model_validator

from .common import SCHEMA_VERSION


class SourceType(str, Enum):
    pricing = "pricing"
    changelog = "changelog"
    news = "news"
    jobs = "jobs"


class RetrievalStatus(str, Enum):
    ok = "ok"            # loaded, has what the source type needs
    partial = "partial"  # loaded, key content missing (e.g. pricing page with no prices)
    empty = "empty"      # under ~500 chars
    blocked = "blocked"  # 401 / 403 / 429 / login or captcha page
    error = "error"      # anything else


class WatchBrief(BaseModel):
    watch_id: str
    objective: str
    entities: list[str]                  # entity_ids
    topics: list[SourceType]
    regions: list[str] = ["US"]
    max_pages_per_run: int = 20
    max_searches_per_run: int = 5
    version: int = 1


class SourceRecipe(BaseModel):
    source_id: str                       # e.g. "notion-pricing"
    watch_id: str
    entity_id: str
    entity_name: str
    source_type: SourceType
    seed_url: str
    render: bool = True
    driver: Optional[str] = None         # Nimble: vx6 http, vx8 headless, vx10 stealth
    parser_version: str = "nimble-md-v1"
    cadence_minutes: int = 60
    enabled: bool = True


def make_obs_id(source_id: str, url: str, fetched_at: datetime) -> str:
    """Unique per FETCH (see DECISIONS.md D1). Dedup uses content_hash / section_hashes instead."""
    raw = "|".join([source_id, url, fetched_at.isoformat()])
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


class EvidenceEnvelope(BaseModel):
    """One Nimble fetch. Immutable once written. Failures are written too, with status != ok."""
    obs_id: str                          # make_obs_id(); PRD calls this observation_id
    run_id: str
    source_id: str
    entity_id: str                       # "notion"
    entity_name: str                     # "Notion" (used in narration)
    source_type: SourceType
    url: str                             # canonical URL; PRD calls this canonical_url
    fetched_at: datetime                 # UTC; PRD calls this retrieved_at
    status: RetrievalStatus
    http_status: Optional[int] = None
    parser_version: str
    content_hash: str                    # full page; noisy, debug/dedup only
    section_hashes: dict[str, str] = {}  # NORMALIZED sections, e.g. {"pricing": ...}; gates the Liquid call
    structured: Optional[dict] = None    # Nimble parser output, if a parser is configured
    markdown: Optional[str] = None       # what Liquid reads
    nimble_task_id: Optional[str] = None
    artifact_paths: dict[str, str] = {}  # optional local HTML/screenshot paths on the machine running the agent
    schema_version: str = SCHEMA_VERSION

    @model_validator(mode="after")
    def _ok_needs_content(self):
        if self.status == RetrievalStatus.ok and not (self.markdown or self.structured):
            raise ValueError("status=ok requires markdown or structured content")
        return self

    @property
    def usable(self) -> bool:
        """Only ok evidence may change beliefs. Absence is not retraction (PRD principle 6)."""
        return self.status == RetrievalStatus.ok
