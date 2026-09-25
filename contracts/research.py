"""Research contracts: a company research session (agent/research.py) and the CompanyProfile it produces.

A session starts from a user prompt ("make a video for Coca-Cola"), fetches the company's own website, records
grounded findings (every finding quotes text that was actually on a fetched page), asks the user follow-up
questions, and keeps a CompanyProfile + VideoBrief that the video app turns into a storyboard.
"""
import hashlib
from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field

from .common import SCHEMA_VERSION

QUESTION_TOPICS = ("goal", "audience", "product", "tone", "format", "cta", "avoid", "other")
FINDING_TOPICS = ("about", "product", "audience", "brand", "news", "proof", "people", "sustainability", "other")


def stable_id(*parts: str, size: int = 20) -> str:
    return hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()[:size]


class ResearchStatus(str, Enum):
    starting = "starting"          # extracting the company and finding its website
    researching = "researching"    # a round is running (fetching pages, recording findings)
    waiting = "waiting"            # looping: sleeping RESEARCH_INTERVAL_S before the next round
    done = "done"                  # finished; POST /loop {looping: true} starts more rounds
    stopped = "stopped"            # the user stopped it (final)
    error = "error"                # could not continue (e.g. no website found)


FINAL_STATUSES = {ResearchStatus.done, ResearchStatus.stopped, ResearchStatus.error}


class ResearchIntent(BaseModel):
    company_name: str = Field(min_length=1, max_length=120)
    likely_domain: Optional[str] = None
    video_goal: str = Field("", max_length=400)


class PageVisit(BaseModel):
    url: str
    title: str = ""
    description: str = ""
    status: int
    chars: int = 0
    fetched_at: datetime


class Finding(BaseModel):
    """A grounded fact: `quote` is a verbatim substring of the page at `evidence_url` (checked in code)."""
    finding_id: str
    topic: str = "other"
    claim: str = Field(max_length=400)
    evidence_url: str
    quote: str = Field(max_length=400)
    found_at: datetime

    @staticmethod
    def make_id(session_id: str, evidence_url: str, quote: str) -> str:
        return "f_" + stable_id(session_id, evidence_url, " ".join(quote.lower().split()), size=16)


class SourcedText(BaseModel):
    text: str = Field(max_length=500)
    evidence_url: Optional[str] = None
    finding_ids: list[str] = []


class NewsItem(BaseModel):
    title: str = Field(max_length=300)
    date: Optional[str] = None
    url: str


class VisualIdentity(BaseModel):
    colors: list[str] = []              # hex, from theme-color / CSS custom properties / inline styles
    logo_url: Optional[str] = None
    og_image: Optional[str] = None
    imagery_style: str = ""             # words for an image model (no text, no logos)
    evidence_url: Optional[str] = None


class FollowUpQuestion(BaseModel):
    question_id: str
    topic: str = "other"                # one of QUESTION_TOPICS
    question: str = Field(max_length=300)
    options: list[str] = []             # 0-4 suggested answers; the user may answer freely
    source: str = "llm"                 # llm | agent (asked from the ReAct loop) | template
    asked_at: datetime
    answered: bool = False
    answer: Optional[str] = None
    answered_at: Optional[datetime] = None

    @staticmethod
    def make_id(session_id: str, topic: str, question: str) -> str:
        return "q_" + stable_id(session_id, topic, " ".join(question.lower().split()), size=12)


class VideoBrief(BaseModel):
    """What the user told us about the video. Filled from answered FollowUpQuestions."""
    goal: str = ""
    audience: str = ""
    featured_product: str = ""
    tone: str = ""
    length_format: str = ""
    call_to_action: str = ""
    avoid: str = ""
    notes: list[str] = []


class CompanyProfile(BaseModel):
    session_id: str
    name: str
    domain: Optional[str] = None
    one_line: Optional[SourcedText] = None
    what_they_do: Optional[SourcedText] = None
    products: list[SourcedText] = []
    audience: Optional[SourcedText] = None
    brand_voice: Optional[SourcedText] = None
    visual_identity: VisualIdentity = VisualIdentity()
    key_messages: list[SourcedText] = []
    recent_news: list[NewsItem] = []
    proof_points: list[Finding] = []
    open_questions: list[str] = []
    video_brief: VideoBrief = VideoBrief()
    version: int = 0
    updated_at: datetime
    model: str = "deterministic"
    schema_version: str = SCHEMA_VERSION


class ResearchStats(BaseModel):
    rounds: int = 0
    pages: int = 0
    findings: int = 0
    llm_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0

    @property
    def tokens(self) -> int:
        return self.input_tokens + self.output_tokens


class ResearchSessionState(BaseModel):
    """Everything a session needs to resume after a worker restart (stored in agent.db)."""
    session_id: str
    prompt: str
    created_at: datetime
    updated_at: datetime
    status: ResearchStatus = ResearchStatus.starting
    looping: bool = True
    publish: bool = False
    user_id: Optional[str] = None       # from the web app (X-Longform-User); scopes get_user_context
    intent: Optional[ResearchIntent] = None
    domain: Optional[str] = None
    home_url: Optional[str] = None
    allowed_hosts: list[str] = []
    visited: list[PageVisit] = []
    findings: list[Finding] = []
    questions: list[FollowUpQuestion] = []
    prior_answers: list[FollowUpQuestion] = []   # answered in earlier sessions for the same company (and user)
    profile: Optional[CompanyProfile] = None
    stats: ResearchStats = ResearchStats()
    error: Optional[str] = None
    is_test: bool = False
    schema_version: str = SCHEMA_VERSION


class ResearchEventRow(BaseModel):
    """One row of RawTree `slop_human_research_events`. event_id is deterministic (retries never duplicate)."""
    event_id: str
    session_id: str
    company: str
    type: str                           # page | finding | question | answer | profile
    payload: str                        # JSON
    evidence_url: str = ""
    created_at: datetime
    is_test: bool = False
    schema_version: str = SCHEMA_VERSION
