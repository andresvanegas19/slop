"""The research session's tools, shown to Liquid in the ReAct loop.

Same safety style as tools.py:
- The model only picks a tool and typed arguments. URLs are checked against the session's host allowlist and
  robots.txt in code (agent/web.py); nothing else is reachable.
- `record_finding` is grounded in code: its quote must be a verbatim (whitespace/case-insensitive) substring of a
  page this session fetched, and `evidence_url` must be that page.
- Every result is JSON and bounded; failures come back as {"error": ...} observations, never exceptions.
"""
import html
import json
import re
from typing import Callable, List, Optional

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from contracts.research import FINDING_TOPICS, QUESTION_TOPICS

from .web import normalize_url

MIN_QUOTE_CHARS = 12
MAX_QUOTE_CHARS = 300
MAX_OPTIONS = 4
MAX_OPEN_QUESTIONS = 8
PUNCT = str.maketrans({"’": "'", "‘": "'", "“": '"', "”": '"', "–": "-", "—": "-",
                       " ": " ", "™": "", "®": ""})


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(text or "").translate(PUNCT)).strip().lower()


def clean_quote(quote: str) -> str:
    q = (quote or "").strip().strip("\"'“”").strip()
    q = re.sub(r"(\.\.\.|…)$", "", q).strip()
    return q


class UrlArgs(BaseModel):
    url: str = Field(description="absolute URL on the company's site (from list_links or the homepage)")
    offset: int = Field(0, ge=0, description="character offset to continue reading a long page; 0 = start")


class LinksArgs(BaseModel):
    url: str = Field(description="URL of a page already fetched (or the homepage)")


class FindingArgs(BaseModel):
    topic: str = Field(description="one of " + ", ".join(FINDING_TOPICS))
    claim: str = Field(description="one fact in your own words, at most 300 characters")
    evidence_url: str = Field(description="the fetched page the quote is on")
    quote: str = Field(description="12-300 characters copied EXACTLY from that page's text")


class AskArgs(BaseModel):
    question: str = Field(description="one short question for the user about the video")
    options: List[str] = Field(default_factory=list, description="2-4 short suggested answers")
    topic: str = Field("other", description="one of " + ", ".join(QUESTION_TOPICS))


class NoArgs(BaseModel):
    pass


class UserArgs(BaseModel):
    limit: int = Field(15, ge=1, le=50, description="how many of the user's recent prompts")


class VideoArgs(BaseModel):
    limit: int = Field(5, ge=1, le=10, description="how many past videos, newest first")
    company: Optional[str] = Field(None, description="company name; omit for this session's company")


def _dump(value) -> str:
    return json.dumps(value, default=str, ensure_ascii=False)


class ResearchTools:
    """Thin, bounded views over one ResearchSession (agent/research.py) that owns state, fetching and events."""

    def __init__(self, session):
        self.session = session

    @property
    def cap(self):
        return self.session.settings.research_observation_chars

    # --- tools --------------------------------------------------------------------------------------------------
    def fetch_page(self, url, offset=0):
        page = self.session.get_page(url)
        if page is None:
            return {"error": "invalid URL {!r}".format(url)[:300]}
        if "error" in page:
            return page
        text = page.get("text", "")
        window = max(1000, self.cap - 2500)
        chunk = text[offset:offset + window]
        out = {"url": page["url"], "title": page.get("title", ""), "description": page.get("description", ""),
               "headings": page.get("headings", [])[:25], "text": chunk, "total_chars": len(text)}
        if offset + window < len(text):
            out["next_offset"] = offset + window
        out["top_links"] = [d["url"] for d in self.session.links_for(page["url"], limit=8)]
        return out

    def list_links(self, url):
        target = normalize_url(url)
        if target is None:
            return {"error": "invalid URL"}
        page = self.session.get_page(target)
        if page is None or "error" in page:
            return page or {"error": "invalid URL"}
        links = self.session.links_for(page["url"], limit=40)
        return {"url": page["url"], "links": links, "visited": len(self.session.state.visited),
                "pages_left_this_round": self.session.pages_left()}

    def record_finding(self, topic, claim, evidence_url, quote):
        return self.session.add_finding(topic, claim, evidence_url, quote, source="agent")

    def get_findings(self):
        items = [{"id": f.finding_id, "topic": f.topic, "claim": f.claim, "evidence_url": f.evidence_url}
                 for f in self.session.state.findings]
        out = {"count": len(items), "findings": items[-60:]}
        text = _dump(out)
        while len(text) > self.cap and out["findings"]:
            out["findings"] = out["findings"][5:]
            text = _dump(out)
        return out

    def ask_user(self, question, options=None, topic="other"):
        q = self.session.add_question(question, options or [], topic, source="agent")
        if isinstance(q, dict):
            return q
        return {"ok": True, "question_id": q.question_id, "note": "queued; the user answers asynchronously. "
                "Keep researching; call get_user_answers later."}

    def get_user_answers(self):
        qs = self.session.state.questions
        return {"answers": [{"question_id": q.question_id, "topic": q.topic, "question": q.question,
                             "answer": q.answer} for q in qs if q.answered],
                "unanswered": [q.question for q in qs if not q.answered][:MAX_OPEN_QUESTIONS]}

    def get_recent_videos(self, limit=5, company=None):
        return self.session.recent_videos(limit, company)

    def get_user_context(self, limit=15):
        return self.session.user_context(limit)

    # --- LangChain wiring -------------------------------------------------------------------------------------------
    def _wrap(self, fn: Callable) -> Callable:
        def run(**kwargs):
            try:
                text = _dump(fn(**kwargs))
            except Exception as e:
                text = _dump({"error": "{}: {}".format(type(e).__name__, str(e)[:300])})
            return text if len(text) <= self.cap else text[:self.cap] + "…[truncated]"
        return run

    def langchain_tools(self) -> List[StructuredTool]:
        spec = [
            ("fetch_page", self.fetch_page, UrlArgs,
             "Fetch a page of the company's website: title, description, headings, clean text (use offset to read "
             "more) and its best links. Counts against the page budget unless already fetched."),
            ("list_links", self.list_links, LinksArgs,
             "Same-site links of a page, deduped and prioritized (about, products/brands, news, sustainability, "
             "careers, pricing), minus pages already visited."),
            ("record_finding", self.record_finding, FindingArgs,
             "Save one grounded fact for the video. The quote must be copied exactly from the fetched page."),
            ("get_findings", self.get_findings, NoArgs, "Findings recorded so far (id, topic, claim, url)."),
            ("ask_user", self.ask_user, AskArgs,
             "Queue a follow-up question for the user (audience, product to feature, tone, format, call to action, "
             "things to avoid). Does not wait for the answer."),
            ("get_user_answers", self.get_user_answers, NoArgs, "The user's answers to follow-up questions so far."),
            ("get_recent_videos", self.get_recent_videos, VideoArgs,
             "Videos the studio already made for this company (titles, prompts, edits that worked, durations)."),
            ("get_user_context", self.get_user_context, UserArgs,
             "This user's past prompts: companies they asked about, style words, durations, what failed. Use it to "
             "focus research and to avoid asking what they already told us."),
        ]
        return [StructuredTool.from_function(func=self._wrap(fn), name=name, description=desc, args_schema=schema)
                for name, fn, schema, desc in spec]


def quote_in_page(quote: str, page: Optional[dict]) -> bool:
    if not page:
        return False
    hay = norm("\n".join([page.get("title", ""), page.get("description", ""), page.get("text", "")]))
    return norm(quote) in hay
