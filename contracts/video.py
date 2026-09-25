"""The storyboard the video app renders, and how it is stored in RawTree.

`VideoStoryboard` mirrors the web app's contract (generation-video/src/lib/storyboard.ts, schemaVersion "1.0")
field for field, in camelCase, so `model_dump(mode="json")` passes the TypeScript `validateStoryboard()` unchanged.
It is stricter than the TypeScript validator in three ways the renderer depends on:
  - scenes are contiguous from 0 ms (no gaps: the narration and crossfades assume it);
  - every scene lasts 5-20 s (FLUX 3 image-to-video limits, generation-video/src/lib/bfl.ts);
  - every non-title/outro scene cites evidence (PRD 16: every factual claim traces to evidence).

B writes one `VideoStoryboardRecord` per storyboard to RawTree `slop_human_video_storyboards` (and keeps it in its
local SQLite). C selects it by `storyboard_id` (or the latest for a `watch_id`) and renders `storyboard()`.
"""
import json
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator

from .common import SCHEMA_VERSION

STORYBOARD_SCHEMA_VERSION = "1.0"
MIN_SCENE_MS = 5_000
MAX_SCENE_MS = 20_000
WORDS_PER_SECOND = 2.5                               # narration budget: at most duration_s * 2.5 words

Camera = Literal["static", "pan-left", "pan-right", "push-in", "pull-out", "tilt-up", "tilt-down"]
TransitionType = Literal["cut", "cross-dissolve", "fade-to-black", "match-cut"]
TextPosition = Literal["top", "center", "bottom"]
WarningCode = Literal["unsupported-claim", "ambiguous-timing", "legal-review", "sensitive-content"]
NON_EVIDENCE_SCENES = ("title", "outro")             # scene id prefixes allowed to cite no evidence


class NonEmpty(BaseModel):
    @model_validator(mode="after")
    def _strings_not_blank(self):
        for name, value in self:
            if isinstance(value, str) and not value.strip():
                raise ValueError("{} must not be empty".format(name))
        return self


class VideoStyle(NonEmpty):
    id: str
    visualPrompt: str
    aspectRatio: Literal["16:9", "9:16", "1:1"] = "16:9"
    seed: int = Field(42, ge=0)                       # never null: the TS validator rejects `seed: null`
    referenceImageIds: list[str] = []


class VideoTiming(BaseModel):
    startMs: int = Field(ge=0)
    durationMs: int = Field(ge=1)


class VideoMotion(NonEmpty):
    camera: Camera
    description: str


class VideoTransition(BaseModel):
    type: TransitionType = "cross-dissolve"
    durationMs: int = Field(300, ge=0)


class VideoOnScreenText(NonEmpty):
    text: str = Field(max_length=120)
    position: TextPosition = "bottom"


class VideoNarrationWarning(NonEmpty):
    code: WarningCode
    message: str


class VideoScene(NonEmpty):
    id: str                                           # "title", "dev-1", "dev-2", "implications", "outro"
    timing: VideoTiming
    visualPrompt: str                                 # no text, logos or numbers in frame (overlays carry facts)
    motion: VideoMotion
    transition: VideoTransition = VideoTransition()
    onScreenText: list[VideoOnScreenText] = []
    narration: str
    narrationWarnings: list[VideoNarrationWarning] = []
    evidenceIds: list[str] = []                       # EvidenceEnvelope.obs_ids behind this scene's claims

    @model_validator(mode="after")
    def _scene_rules(self):
        if not MIN_SCENE_MS <= self.timing.durationMs <= MAX_SCENE_MS:
            raise ValueError("scene {}: duration must be {}-{} ms".format(self.id, MIN_SCENE_MS, MAX_SCENE_MS))
        if self.transition.durationMs > self.timing.durationMs:
            raise ValueError("scene {}: transition longer than the scene".format(self.id))
        budget = int(self.timing.durationMs / 1000 * WORDS_PER_SECOND)
        if len(self.narration.split()) > budget:
            raise ValueError("scene {}: narration has {} words, budget {}".format(
                self.id, len(self.narration.split()), budget))
        if not self.id.startswith(NON_EVIDENCE_SCENES) and not self.evidenceIds:
            raise ValueError("scene {}: must cite evidence".format(self.id))
        if any(not e.strip() for e in self.evidenceIds):
            raise ValueError("scene {}: blank evidence id".format(self.id))
        return self


class VideoStoryboard(NonEmpty):
    schemaVersion: Literal["1.0"] = STORYBOARD_SCHEMA_VERSION
    id: str
    patchIds: list[str] = []                          # B's patches (or development ids) this storyboard reports
    headline: str
    style: VideoStyle
    scenes: list[VideoScene] = Field(min_length=1)

    @model_validator(mode="after")
    def _contiguous(self):
        expected = 0
        for s in self.scenes:
            if s.timing.startMs != expected:
                raise ValueError("scene {} starts at {} ms, expected {} ms (no gaps or overlaps)".format(
                    s.id, s.timing.startMs, expected))
            expected += s.timing.durationMs
        ids = [s.id for s in self.scenes]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate scene ids")
        return self

    @property
    def total_duration_ms(self) -> int:
        return sum(s.timing.durationMs for s in self.scenes)

    def evidence_ids(self) -> list[str]:
        return sorted({e for s in self.scenes for e in s.evidenceIds})


class EvidenceRef(BaseModel):
    """What a viewer needs to check a claim: stored next to the storyboard so C can show sources."""
    obs_id: str
    url: str
    title: str = ""
    source_name: str = ""
    entity_id: str = ""


class VideoStoryboardRecord(BaseModel):
    """One row in RawTree `slop_human_video_storyboards`. Nested data travels as JSON strings because RawTree
    flattens nested objects into dotted columns (SPIKE_FINDINGS)."""
    storyboard_id: str
    watch_id: str
    company_name: str
    run_id: str
    created_at: datetime
    headline: str
    total_duration_ms: int
    scene_count: int
    development_ids: str = ""                         # comma-separated, for SQL filtering
    is_test: bool = False                             # rows can't be deleted: test rows are flagged, C skips them
    storyboard_json: str                              # VideoStoryboard.model_dump_json()
    evidence_json: str = "[]"                         # JSON list of EvidenceRef
    schema_version: str = SCHEMA_VERSION

    @classmethod
    def from_storyboard(cls, sb: VideoStoryboard, watch_id: str, company_name: str, run_id: str,
                        created_at: datetime, evidence: list[EvidenceRef], development_ids: list[str],
                        is_test: bool = False) -> "VideoStoryboardRecord":
        return cls(storyboard_id=sb.id, watch_id=watch_id, company_name=company_name, run_id=run_id,
                   created_at=created_at, headline=sb.headline, total_duration_ms=sb.total_duration_ms,
                   scene_count=len(sb.scenes), development_ids=",".join(development_ids), is_test=is_test,
                   storyboard_json=sb.model_dump_json(),
                   evidence_json=json.dumps([e.model_dump(mode="json") for e in evidence]))

    def storyboard(self) -> VideoStoryboard:
        return VideoStoryboard.model_validate_json(self.storyboard_json)

    def evidence(self) -> list[EvidenceRef]:
        return [EvidenceRef(**e) for e in json.loads(self.evidence_json or "[]")]
