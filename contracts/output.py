"""B -> C contract: storyboard in, media out (PRD 16).

Field names match the storyboard.json C already has (scenes, image_prompt, on_screen_text),
plus `claims`: every spoken fact points at a belief and its evidence.
"""
from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, model_validator

from .common import SCHEMA_VERSION


class Claim(BaseModel):
    claim_id: str
    text: str                           # the fact as stated, e.g. "Notion Plus is now $8"
    belief_key: str
    patch_id: str
    evidence_ids: list[str] = Field(min_length=1)


class SceneType(str, Enum):
    title = "title"
    change = "change"
    quiet = "quiet"
    outro = "outro"


class Scene(BaseModel):
    scene: int
    start_sec: float
    duration_sec: float = Field(gt=0)
    type: SceneType
    narration: str                      # ~2.5 words per second of duration
    on_screen_text: dict = {}           # {"headline": ..., "sub": ...}; overlaid in editing, never drawn by the image model
    image_prompt: str                   # style prefix already included; no text/numbers in the image
    motion: str = "slow push in"
    transition_out: str = "crossfade_0.3s"
    claim_ids: list[str] = []


class StyleGuide(BaseModel):
    style_id: str = "phone-footage-v1"
    prompt_prefix: str
    palette: list[str]
    seed: int
    aspect_ratio: str = "16:9"
    resolution: str = "1920x1080"


class Storyboard(BaseModel):
    storyboard_id: str                  # hash(ordered patch_ids, schema_version)
    patch_ids: list[str]
    title: str
    total_duration_sec: float
    style: StyleGuide
    scenes: list[Scene] = Field(min_length=1)
    claims: list[Claim] = []
    voiceover_full: str
    schema_version: str = SCHEMA_VERSION

    @model_validator(mode="after")
    def _consistent(self):
        known = {c.claim_id for c in self.claims}
        for s in self.scenes:
            missing = set(s.claim_ids) - known
            if missing:
                raise ValueError("scene {} cites unknown claims {}".format(s.scene, sorted(missing)))
            if s.type == SceneType.change and not s.claim_ids:
                raise ValueError("scene {}: a change scene must cite a claim".format(s.scene))
        total = sum(s.duration_sec for s in self.scenes)
        if abs(total - self.total_duration_sec) > 0.01:
            raise ValueError("scene durations sum to {}, not {}".format(total, self.total_duration_sec))
        return self


class StoryboardRecord(BaseModel):
    """One row in RawTree `slop_human_build`: how B hands a storyboard to C.

    The storyboard travels as one JSON string: RawTree flattens nested objects into
    dotted columns, which would mangle the list of scenes.
    C polls for storyboards with no `done` MediaJob in slop_human_media_events.
    """
    storyboard_id: str
    run_id: str
    created_at: datetime
    patch_ids: str                      # comma-separated, for filtering in SQL
    title: str
    total_duration_sec: float
    scene_count: int
    is_test: bool = False               # rows can't be deleted, so test rows are flagged and C skips them
    storyboard_json: str
    schema_version: str = SCHEMA_VERSION

    @classmethod
    def from_storyboard(cls, sb: "Storyboard", run_id: str, created_at: datetime, is_test: bool = False):
        return cls(storyboard_id=sb.storyboard_id, run_id=run_id, created_at=created_at,
                   patch_ids=",".join(sb.patch_ids), title=sb.title, total_duration_sec=sb.total_duration_sec,
                   scene_count=len(sb.scenes), is_test=is_test, storyboard_json=sb.model_dump_json())

    def storyboard(self) -> "Storyboard":
        return Storyboard.model_validate_json(self.storyboard_json)


class MediaStatus(str, Enum):
    queued = "queued"
    running = "running"
    done = "done"
    failed = "failed"                   # retryable; never rolls back state


class MediaJob(BaseModel):
    media_job_id: str                   # hash(storyboard_id, model, params)
    storyboard_id: str
    scene: Optional[int] = None         # None = whole video
    model: str                          # e.g. "flux-2-pro"
    prompt: str
    seed: int
    params: dict = {}
    request_id: Optional[str] = None    # BFL request id
    output_path: Optional[str] = None
    status: MediaStatus = MediaStatus.queued
    error: Optional[str] = None
    created_at: datetime
    schema_version: str = SCHEMA_VERSION
