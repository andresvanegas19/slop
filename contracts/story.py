"""Story contracts: competitor research and the storyline an ad is rendered from (agent/competitors.py, agent/storyline.py).

After a research session (contracts/research.py) has a CompanyProfile, the agent researches 2-3 competitors on their
own websites and keeps a CompetitiveLandscape. The storyline tool then writes a StoryPlan: one beat per scene of a
video template (presets in generation-video/src/lib/presets.ts). Competitors only inform positioning: their names are
listed in `avoid_terms` and must never appear in narration, headlines or image prompts.
"""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

from .common import SCHEMA_VERSION
from .research import Finding, PageVisit, SourcedText, stable_id

COMPETITOR_TOPICS = ("positioning", "product", "pricing", "audience", "proof", "other")
LANDSCAPE_STATUSES = ("waiting", "running", "done", "skipped", "error")
MAX_BEATS = 8


class Competitor(BaseModel):
    competitor_id: str
    name: str = Field(min_length=1, max_length=120)
    domain: Optional[str] = None
    home_url: Optional[str] = None
    reason: str = Field("", max_length=300)     # why the agent thinks it competes
    source: str = "llm"                         # llm | watch (config/watch.yaml) | user
    verified: bool = False                      # its homepage was fetched and mentions the name
    pages: list[PageVisit] = []
    findings: list[Finding] = []                # quotes verified on this competitor's fetched pages
    summary: str = Field("", max_length=600)    # internal positioning summary; never on screen
    error: Optional[str] = None

    @staticmethod
    def make_id(session_id: str, name: str) -> str:
        return "c_" + stable_id(session_id, " ".join(name.lower().split()), size=12)


class CompetitiveLandscape(BaseModel):
    session_id: str
    company: str
    status: str = "waiting"                     # one of LANDSCAPE_STATUSES
    message: str = ""
    competitors: list[Competitor] = []
    differentiators: list[SourcedText] = []     # the company's own strengths, citing the company's findings
    competitor_themes: list[str] = []           # what competitors emphasise (internal, no names)
    avoid_terms: list[str] = []                 # competitor names and domain labels
    version: int = 0
    updated_at: datetime
    model: str = "deterministic"
    error: Optional[str] = None
    schema_version: str = SCHEMA_VERSION


class TemplateRole(BaseModel):
    type: str = Field(min_length=1, max_length=40)
    goal: str = Field("", max_length=400)


class StoryTemplate(BaseModel):
    """One video template the caller can render (the web app sends its presets for the chosen duration)."""
    id: str = Field(min_length=1, max_length=40)
    label: str = Field("", max_length=80)
    description: str = Field("", max_length=300)
    roles: list[TemplateRole] = Field(min_length=1, max_length=MAX_BEATS)


class StoryBeat(BaseModel):
    index: int
    role: str
    goal: str = ""
    message: str = Field(max_length=300)        # what this scene says (facts only from findings)
    visual: str = Field(max_length=300)         # what the viewer sees (no text, logos or competitor products)
    finding_ids: list[str] = []


class StoryPlan(BaseModel):
    storyline_id: str
    session_id: str
    template: str
    duration_sec: int
    title: str = Field(max_length=120)
    logline: str = Field(max_length=400)
    tone: str = Field("", max_length=120)
    audience: str = Field("", max_length=200)
    call_to_action: str = Field("", max_length=120)
    beats: list[StoryBeat] = Field(min_length=1, max_length=MAX_BEATS)
    avoid_terms: list[str] = []
    reason: str = Field("", max_length=300)     # why this template
    source: str = "llm"                         # llm | partial | fallback | user
    version: int = 1
    approved: bool = False
    created_at: datetime
    updated_at: datetime
    model: str = "deterministic"
    schema_version: str = SCHEMA_VERSION
