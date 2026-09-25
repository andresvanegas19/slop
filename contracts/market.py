"""Market-update contracts: who the user is, who they compete with, and what changed in their market.

Flow (A -> B -> C):
  user prompt ("We're Acme, we make invoicing software for freelancers")
    -> CompanyBrief                 (A: extracted from the prompt, domain resolved with Nimble Search)
    -> MarketWatch                  (A: competitors discovered with Nimble Search; the watch replaces config/watch.yaml)
    -> EvidenceEnvelope rows        (A: Nimble Search finds recent content per competitor, Nimble Extract fetches it,
                                     written to RawTree `slop_human` with source_type news/changelog/pricing)
    -> MarketDevelopment            (B: Liquid proposes, code checks the quote is verbatim in the evidence markdown)
    -> VideoStoryboard              (B: contracts/video.py, stored in RawTree `slop_human_video_storyboards`)
    -> video                        (C: the web app loads the stored storyboard and renders it)
"""
import re
from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, model_validator

from .common import SCHEMA_VERSION
from .evidence import SourceType, WatchBrief
from .research import stable_id


def slugify(name: str) -> str:
    """Stable, readable entity id: "Monday.com" -> "monday-com". Used for entity_id and belief keys."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug[:40] or "entity"


class CompanyBrief(BaseModel):
    """The user's own company, from their prompt. Never inferred from chat history: persisted with the watch."""
    company_id: str                                   # slugify(name)
    name: str = Field(min_length=1, max_length=120)
    domain: Optional[str] = None                      # "acme.com", no scheme; resolved with Nimble Search if absent
    description: str = Field("", max_length=600)      # what they do, in the user's words where possible
    category: str = Field("", max_length=120)         # search phrase for the market: "invoicing software for freelancers"
    region: str = "US"
    prompt: str = Field("", max_length=4000)          # the original prompt


class CompetitorCandidate(BaseModel):
    """A competitor found by Nimble Search. `seen_in` holds the result URLs that named it (its provenance)."""
    entity_id: str                                    # slugify(name); unique within a watch
    name: str = Field(min_length=1, max_length=120)
    domain: Optional[str] = None
    score: float = Field(0.0, ge=0, le=1)             # higher = mentioned in more independent results
    mentions: int = 0
    seen_in: list[str] = []
    reason: str = Field("", max_length=300)


class MarketWatch(BaseModel):
    """Persistent config for one company's market. Versioned: re-discovery bumps `version`."""
    watch_id: str                                     # MarketWatch.make_id(company.company_id)
    company: CompanyBrief
    competitors: list[CompetitorCandidate] = Field(min_length=1, max_length=8)
    topics: list[SourceType] = [SourceType.news, SourceType.pricing]
    lookback_days: int = Field(30, ge=1, le=365)      # how recent content must be
    max_results_per_query: int = Field(5, ge=1, le=20)
    version: int = 1
    created_at: datetime
    schema_version: str = SCHEMA_VERSION

    @staticmethod
    def make_id(company_id: str) -> str:
        return "mw_" + stable_id(company_id, size=12)

    @model_validator(mode="after")
    def _unique_entities(self):
        ids = [c.entity_id for c in self.competitors]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate competitor entity_id")
        if self.company.company_id in ids:
            raise ValueError("the user's own company can't also be a competitor")
        return self

    def entity_names(self) -> dict[str, str]:
        """Every tracked entity, the user's company included (is_self)."""
        names = {c.entity_id: c.name for c in self.competitors}
        names[self.company.company_id] = self.company.name
        return names

    def watch_brief(self) -> WatchBrief:
        return WatchBrief(watch_id=self.watch_id,
                          objective="Market update for {}: {}".format(self.company.name, self.company.category),
                          entities=list(self.entity_names()), topics=self.topics, regions=[self.company.region],
                          version=self.version)


class DevelopmentKind(str, Enum):
    launch = "launch"                 # product or feature launch
    pricing = "pricing"               # price or packaging change
    partnership = "partnership"
    funding = "funding"               # funding round, IPO, earnings
    acquisition = "acquisition"
    hiring = "hiring"                 # hiring push, layoffs
    leadership = "leadership"         # executive change
    other = "other"


class MarketDevelopment(BaseModel):
    """One thing that happened in the market, grounded in one piece of evidence.

    `quote` must be a verbatim substring of the evidence envelope's markdown (whitespace-insensitive); B checks it in
    code and drops the development otherwise. Stored in B's state as a Belief with
    attribute "developments.<development_id>" and value = this model's JSON.
    """
    development_id: str                               # MarketDevelopment.make_id(entity_id, headline)
    entity_id: str
    entity_name: str
    kind: DevelopmentKind
    headline: str = Field(min_length=1, max_length=120)   # "Asana launches AI Studio for workflow automation"
    summary: str = Field("", max_length=400)
    quote: str = Field(min_length=1, max_length=400)
    evidence_id: str                                  # EvidenceEnvelope.obs_id
    url: str
    source_name: str = ""                             # "TechCrunch", from the URL's host
    published_at: Optional[datetime] = None
    observed_at: datetime
    significance: float = Field(ge=0, le=1)           # 1 = major market move, drives ordering and the video gate

    @staticmethod
    def make_id(entity_id: str, headline: str) -> str:
        return "dev_" + stable_id(entity_id, " ".join(headline.lower().split()), size=16)
