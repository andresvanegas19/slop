"""The market path: news/changelog envelopes -> grounded MarketDevelopments (as beliefs) -> stored VideoStoryboard.

    envelope (news | changelog, usable, about a tracked competitor)
      -> article hash already processed?  yes: reuse its developments, no model call (confirm them)
                                          no:  Liquid proposes 0-3 developments
      -> grounding in code: quote verbatim in the markdown, right entity, non-empty headline
      -> Patch: add developments.<id> (new) / confirm (seen again) -> PatchValidator -> Reducer
      -> outbox: slop_human_market_developments (new ones)
    after all envelopes: compose_market_storyboard -> local SQLite + outbox slop_human_video_storyboards

`MarketCycle` is the entry point: MarketCycle(repo, liquid, watch).run(envelopes) -> MarketCycleResult.
"""
import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Iterable, List, Optional, Tuple
from urllib.parse import urlparse

from contracts import (TABLES, DevelopmentKind, EventType, EvidenceEnvelope, EvidenceRef, MarketDevelopment,
                       MarketWatch, OpType, OutboxEvent, Patch, PatchDecision, PatchOp, PatchOrigin, RunRecord,
                       SourceType, VideoStoryboard, VideoStoryboardRecord, belief_key, slugify)

DEVELOPMENT_PREFIX = "developments."
MARKET_SOURCES = (SourceType.news, SourceType.changelog)
MIN_QUOTE_CHARS, MIN_QUOTE_WORDS = 20, 4
MAX_PER_ARTICLE = 3

KNOWN_SOURCES = {
    "techcrunch.com": "TechCrunch", "theverge.com": "The Verge", "reuters.com": "Reuters",
    "bloomberg.com": "Bloomberg", "cnbc.com": "CNBC", "businesswire.com": "Business Wire",
    "prnewswire.com": "PR Newswire", "globenewswire.com": "GlobeNewswire", "venturebeat.com": "VentureBeat",
    "wsj.com": "The Wall Street Journal", "nytimes.com": "The New York Times", "forbes.com": "Forbes",
    "zdnet.com": "ZDNET", "wired.com": "WIRED", "axios.com": "Axios", "siliconangle.com": "SiliconANGLE",
    "geekwire.com": "GeekWire", "linkedin.com": "LinkedIn", "x.com": "X", "twitter.com": "X",
    "youtube.com": "YouTube", "github.com": "GitHub", "producthunt.com": "Product Hunt", "ft.com": "Financial Times",
    "businessinsider.com": "Business Insider", "engadget.com": "Engadget", "arstechnica.com": "Ars Technica",
    "fortune.com": "Fortune", "inc.com": "Inc.", "fastcompany.com": "Fast Company", "cnet.com": "CNET",
    "theinformation.com": "The Information", "sifted.eu": "Sifted", "crunchbase.com": "Crunchbase",
    "medium.com": "Medium", "substack.com": "Substack", "news.ycombinator.com": "Hacker News",
}
KIND_SYNONYMS = {
    "launch": ["launch", "product", "feature", "release", "update", "announcement", "ai"],
    "pricing": ["pricing", "price", "plan", "packaging", "discount"],
    "partnership": ["partnership", "partner", "integration", "alliance", "collaboration"],
    "funding": ["funding", "fund", "raise", "investment", "ipo", "earnings", "revenue", "valuation", "financial"],
    "acquisition": ["acquisition", "acquire", "merger", "merge", "buyout"],
    "hiring": ["hiring", "hire", "layoff", "jobs", "headcount", "workforce", "restructuring"],
    "leadership": ["leadership", "executive", "ceo", "cfo", "cto", "appoint", "resign", "board"],
}
LAUNCH_WORDS = re.compile(r"\b(launch\w*|introduc\w*|unveil\w*|releas\w*|ships?|shipped|rolls? out|rolled out|"
                          r"debuts?|adds?|added|now (supports?|lets|allows|offers|runs?|can))\b", re.I)
_QUOTES = str.maketrans({"“": '"', "”": '"', "„": '"', "‘": "'", "’": "'", "–": "-", "—": "-", " ": " "})


# --- grounding (pure) ------------------------------------------------------------------------------------------------

def normalize_text(text: str) -> str:
    """Markup-, case- and whitespace-insensitive form used for the verbatim check."""
    s = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text or "")
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)
    s = s.translate(_QUOTES)
    s = re.sub(r"(?m)^\s*(#+|>+|[-*+]\s)", " ", s)
    s = re.sub(r"[*_`]+", "", s)
    return " ".join(s.lower().split())


def quote_in(quote: str, markdown: str) -> bool:
    q = normalize_text(quote).strip(" \"'.…")
    if len(q) < MIN_QUOTE_CHARS or len(q.split()) < MIN_QUOTE_WORDS or "..." in q or "…" in q:
        return False
    return q in normalize_text(markdown)


def source_name(url: str) -> str:
    """'https://www.techcrunch.com/2026/..' -> 'TechCrunch'; unknown hosts -> 'Example' from example.com."""
    host = (urlparse(url).hostname or "").lower()
    host = host[4:] if host.startswith("www.") else host
    if not host:
        return ""
    for known, name in KNOWN_SOURCES.items():
        if host == known or host.endswith("." + known):
            return name
    labels = host.split(".")
    if len(labels) >= 3 and labels[-2] in ("co", "com", "org", "net", "ac", "gov"):
        label = labels[-3]
    else:
        label = labels[-2] if len(labels) >= 2 else labels[0]
    return label[:1].upper() + label[1:]


def normalize_kind(value, headline: str = "") -> DevelopmentKind:
    """LFM labels are unstable ("Product Launch", "feature_release"): map them onto DevelopmentKind.
    A missing or "other" label on a headline that reads like a release ("now supports", "introduces") is a launch."""
    v = re.sub(r"[^a-z]+", " ", str(value or "").lower()).strip()
    kind = None
    try:
        kind = DevelopmentKind(v)
    except ValueError:
        for k, words in KIND_SYNONYMS.items():
            if any(re.search(r"\b" + w, v) for w in words):
                kind = DevelopmentKind(k)
                break
    if kind in (None, DevelopmentKind.other) and LAUNCH_WORDS.search(headline or ""):
        return DevelopmentKind.launch
    return kind or DevelopmentKind.other


def _parse_date(value) -> Optional[datetime]:
    if not value or not isinstance(value, str):
        return None
    for candidate in (value.strip(), value.strip()[:10]):
        try:
            dt = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _significance(value) -> float:
    try:
        return round(min(1.0, max(0.0, float(value))), 2)
    except (TypeError, ValueError):
        return 0.5


def _about_entity(raw: dict, env: EvidenceEnvelope, other_names: Iterable[str]) -> bool:
    claimed = str(raw.get("entity") or "").strip()
    mine = {env.entity_id, slugify(env.entity_name)}
    text = "{} {}".format(raw.get("headline") or "", raw.get("summary") or "").lower()
    if claimed:
        c = slugify(claimed)
        if not (c in mine or any(c.startswith(m) or m.startswith(c) for m in mine)):
            return False
    elif env.entity_name.lower() not in text:
        return False
    headline = str(raw.get("headline") or "").lower()
    others = [n for n in other_names if n and n.lower() != env.entity_name.lower()]
    if env.entity_name.lower() not in headline and any(n.lower() in headline for n in others):
        return False                                         # headline is about another tracked company
    return True


def ground_developments(env: EvidenceEnvelope, raw: Iterable[dict], other_names: Iterable[str] = ()
                        ) -> Tuple[List[MarketDevelopment], List[str]]:
    """Code decides what Liquid proposed: returns (kept, reasons for each rejection)."""
    kept, rejected, seen = [], [], set()
    other_names = list(other_names)
    for d in raw:
        if not isinstance(d, dict):
            rejected.append("not an object")
            continue
        headline = " ".join(str(d.get("headline") or "").split()).rstrip("!")
        quote = " ".join(str(d.get("quote") or "").split()).strip(" \"'")
        label = headline[:60] or "(no headline)"
        if not headline:
            rejected.append("{}: empty headline".format(label))
            continue
        if not _about_entity(d, env, other_names):
            rejected.append("{}: about {!r}, not {}".format(label, d.get("entity"), env.entity_name))
            continue
        if not quote_in(quote, env.markdown or ""):
            rejected.append("{}: quote not verbatim in the evidence".format(label))
            continue
        if env.entity_name.lower() not in headline.lower():
            headline = "{}: {}".format(env.entity_name, headline)   # the overlay must say who did it
        if len(headline) > 120:
            headline = headline[:119].rsplit(" ", 1)[0].rstrip(",;:") + "…"
        if len(quote) > 400:
            quote = quote[:400].rsplit(" ", 1)[0]
        dev_id = MarketDevelopment.make_id(env.entity_id, headline)
        if dev_id in seen:
            continue
        seen.add(dev_id)
        kept.append(MarketDevelopment(
            development_id=dev_id, entity_id=env.entity_id, entity_name=env.entity_name,
            kind=normalize_kind(d.get("kind"), headline), headline=headline,
            summary=" ".join(str(d.get("summary") or "").split())[:400], quote=quote, evidence_id=env.obs_id,
            url=env.url, source_name=source_name(env.url), published_at=_parse_date(d.get("published_at")),
            observed_at=env.fetched_at, significance=_significance(d.get("significance"))))
        if len(kept) >= MAX_PER_ARTICLE:
            break
    return kept, rejected


def article_hash(env: EvidenceEnvelope) -> str:
    """A's normalized article hash when present; otherwise a hash of the markup-normalized text."""
    h = env.section_hashes.get("article") or env.section_hashes.get(env.source_type.value)
    return h or hashlib.sha256(normalize_text(env.markdown or "").encode()).hexdigest()


def evidence_ref(env: EvidenceEnvelope) -> EvidenceRef:
    title = (env.structured or {}).get("title") if isinstance(env.structured, dict) else ""
    return EvidenceRef(obs_id=env.obs_id, url=env.url, title=str(title or ""), source_name=source_name(env.url),
                       entity_id=env.entity_id)


def _event(kind, table, key, payload):
    return OutboxEvent(event_id="{}:{}".format(kind, key), event_type=EventType.media if kind == "video_storyboard"
                       else EventType.patch, table=table, created_at=datetime.now(timezone.utc), payload=payload)


# --- analyzer: one envelope at a time, called by the Coordinator -------------------------------------------------------

class MarketAnalyzer:
    """Turns one usable news/changelog envelope into a development Patch. Owned by a Coordinator."""

    def __init__(self, repo, liquid, watch: MarketWatch, is_test: bool = False):
        self.repo, self.liquid, self.watch, self.is_test = repo, liquid, watch, is_test
        self.competitors = {c.entity_id: c.name for c in watch.competitors}
        self.checked: List[str] = []              # usable market envelopes read this cycle
        self.new: List[MarketDevelopment] = []    # developments added this cycle
        self.rejected: List[str] = []             # grounding rejections this cycle (for logs / live checks)

    def reset(self):
        self.checked, self.new, self.rejected = [], [], []

    def process(self, env: EvidenceEnvelope, run: RunRecord, submit, record_call) -> Optional[PatchDecision]:
        if env.entity_id not in self.competitors or not env.markdown:
            return None                           # the user's own company or an untracked entity: not reported
        self.checked.append(env.obs_id)
        key = article_hash(env)
        cached = self.repo.article_reading(env.entity_id, key)
        if cached is not None:
            devs = [MarketDevelopment(**d) for d in cached]
            run.skipped_unchanged += 1            # unchanged article: stops before a model call
        else:
            raw, call = self.liquid.extract_developments(env, self.watch.company, env.entity_name, run.run_id)
            record_call(call, run)
            if not call.ok:
                return None                       # model failure: nothing learned, retry next cycle
            devs, rejected = ground_developments(env, raw, self.watch.entity_names().values())
            self.rejected += ["{}: {}".format(env.url, r) for r in rejected]
            with self.repo.tx():
                self.repo.save_article_reading(env.entity_id, key, [d.model_dump(mode="json") for d in devs])

        ops, added = [], []
        for dev in devs:
            attr = DEVELOPMENT_PREFIX + dev.development_id
            bk = belief_key(dev.entity_id, attr)
            if any(o.belief_key == bk for o in ops):
                continue
            current = self.repo.get_belief(bk)
            if current is not None and current.status.value == "active":
                ops.append(PatchOp(op=OpType.confirm, belief_key=bk, entity_id=dev.entity_id, attribute=attr,
                                   before=current.value, after=current.value, confidence=max(current.confidence, 0.9),
                                   significance=0.0, evidence_ids=[env.obs_id],
                                   reason="development reported again"))
            else:
                ops.append(PatchOp(op=OpType.add, belief_key=bk, entity_id=dev.entity_id, attribute=attr,
                                   before=None, after=dev.model_dump(mode="json"), confidence=0.8,
                                   significance=dev.significance, evidence_ids=[env.obs_id],
                                   reason=("{}: {}".format(dev.kind.value, dev.headline))[:280]))
                added.append(dev)
        if not ops:
            return None
        patch = Patch(patch_id=Patch.make_id(self.repo.version, [env.obs_id], ops), run_id=run.run_id,
                      base_state_version=self.repo.version, origin=PatchOrigin.liquid, ops=ops,
                      observed_at=env.fetched_at)

        decision = submit(patch, run, env.source_id)
        if decision.accepted and added:
            with self.repo.tx():
                for dev in added:
                    payload = dict(dev.model_dump(mode="json"), watch_id=self.watch.watch_id, run_id=run.run_id,
                                   is_test=self.is_test)
                    self.repo.enqueue(_event("development", TABLES["development"],
                                             "{}:{}".format(self.watch.watch_id, dev.development_id), payload))
            self.new += added
        return decision

    def active_developments(self, now: datetime) -> List[MarketDevelopment]:
        """Active developments about the watch's competitors within its lookback, most significant then newest."""
        since = now - timedelta(days=self.watch.lookback_days)
        out = []
        for b in self.repo.active_beliefs():
            if b.entity_id in self.competitors and b.attribute.startswith(DEVELOPMENT_PREFIX) \
                    and isinstance(b.value, dict):
                d = MarketDevelopment(**b.value)
                if (d.published_at or d.observed_at) >= since:
                    out.append(d)
        return sorted(out, key=lambda d: (-d.significance, -(d.published_at or d.observed_at).timestamp(),
                                          d.development_id))


# --- the cycle ----------------------------------------------------------------------------------------------------------

@dataclass
class MarketCycleResult:
    run: RunRecord
    new_developments: List[MarketDevelopment]
    developments: List[MarketDevelopment]           # all active for the watch, most significant first
    storyboard: Optional[VideoStoryboard] = None
    record: Optional[VideoStoryboardRecord] = None  # also in repo.get_video_storyboard(record.storyboard_id)
    rejected: List[str] = field(default_factory=list)
    decisions: List[PatchDecision] = field(default_factory=list)

    @property
    def liquid_calls(self) -> int:
        return self.run.liquid_calls

    @property
    def input_tokens(self) -> int:
        return self.run.input_tokens

    @property
    def output_tokens(self) -> int:
        return self.run.output_tokens

    @property
    def skipped_unchanged(self) -> int:
        return self.run.skipped_unchanged


class _Envelopes:
    """In-memory source. Ignores the cursor: the caller hands over exactly what to process."""

    def __init__(self, name, envelopes):
        self.name, self.envelopes = name, sorted(envelopes, key=lambda e: e.fetched_at)

    def fetch_new(self, cursor):
        return [(e, e.fetched_at.isoformat()) for e in self.envelopes]


class _WatchFilter:
    """Wraps a RawTreeSource/LocalSource: only envelopes about the watch's competitors (or the user's company)."""

    def __init__(self, source, entity_ids):
        self.source, self.entity_ids = source, set(entity_ids)
        self.name = source.name

    def fetch_new(self, cursor):
        return [(e, c) for e, c in self.source.fetch_new(cursor) if e.entity_id in self.entity_ids]


class MarketCycle:
    """One market-update cycle for a MarketWatch.

        cycle = MarketCycle(StateRepository("state.db"), LiquidAdapter(key), watch)
        result = cycle.run(envelopes)                  # or MarketCycle(..., source=RawTreeSource(client)).run()
        result.record                                  # VideoStoryboardRecord, stored locally and queued for RawTree
    """

    def __init__(self, repo, liquid, watch: MarketWatch, source=None, use_liquid_copy: bool = True,
                 is_test: bool = False):
        from .coordinator import Coordinator      # coordinator imports this module
        self.repo, self.watch, self.source = repo, watch, source
        self.analyzer = MarketAnalyzer(repo, liquid, watch, is_test=is_test)
        self.coordinator = Coordinator(repo, None, liquid, watch_id=watch.watch_id,
                                       market=watch.company.category or "Competitor pricing",
                                       use_liquid_copy=use_liquid_copy, is_test=is_test, analyzer=self.analyzer)

    def run(self, envelopes: Optional[Iterable[EvidenceEnvelope]] = None,
            now: Optional[datetime] = None, run_id: Optional[str] = None) -> MarketCycleResult:
        """envelopes: in-memory EvidenceEnvelopes (None: read the `source` given at construction).
        run_id: reuse the caller's run id (e.g. A's collection run); default run_/test_<timestamp>."""
        entity_ids = list(self.watch.entity_names())
        if envelopes is not None:
            source = _Envelopes("market:" + self.watch.watch_id,
                                [e for e in envelopes if e.entity_id in set(entity_ids)])
        elif self.source is not None:
            source = _WatchFilter(self.source, entity_ids)
        else:
            source = _Envelopes("market:" + self.watch.watch_id, [])
        self.coordinator.source = source
        out = self.coordinator.cycle(now, run_id=run_id)
        return MarketCycleResult(run=out.run, new_developments=list(self.analyzer.new),
                                 developments=out.developments, storyboard=out.video_storyboard,
                                 record=out.video_record, rejected=list(self.analyzer.rejected),
                                 decisions=out.decisions)
