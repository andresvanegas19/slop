"""Market-update sessions: "tell us about your company" -> competitors -> content -> developments -> storyboard.

One session runs in its own thread and moves through MarketStatus stages (contracts/market.py). The stages are
plain functions supplied by a `pipeline` object so tests can swap them for fakes:

  resolve(prompt)                      -> CompanyBrief                  (A: acquisition/discovery.py)
  discover(company)                    -> list[CompetitorCandidate]     (A)
  collect(watch, run_id)               -> (list[EvidenceEnvelope], stats) (A: acquisition/content.py)
  analyze(watch, envelopes, run_id)    -> MarketAnalysis                (B: core/market.py; stores the storyboard)
  publish_evidence(watch, envelopes)   -> None   (RawTree slop_human + the watch row; only when publishing is on)
  publish_outbox()                     -> int    (B's queued developments + storyboard -> RawTree)

The web app polls GET /market/{id} (MarketSessionView) and renders `storyboard_id` once status is `ready`.
"""
import json
import logging
import secrets
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

from contracts import (CompanyBrief, CompetitorCandidate, EvidenceEnvelope, MarketDevelopment, MarketEvent,
                       MarketSessionView, MarketStatus, MarketWatch)

log = logging.getLogger("agent.market")
MAX_RUNNING = 2
MAX_EVENTS = 200
TOP_DEVELOPMENTS = 8


class Busy(Exception):
    pass


@dataclass
class MarketAnalysis:
    developments: list[MarketDevelopment]
    storyboard_id: Optional[str]
    liquid_calls: int = 0
    skipped_unchanged: int = 0


@dataclass
class MarketPipeline:
    resolve: Callable[[str], CompanyBrief]
    discover: Callable[[CompanyBrief], list[CompetitorCandidate]]
    collect: Callable[[MarketWatch, str], tuple[list[EvidenceEnvelope], dict]]
    analyze: Callable[[MarketWatch, list[EvidenceEnvelope], str], MarketAnalysis]
    build_watch: Callable[[CompanyBrief, list[CompetitorCandidate], datetime], MarketWatch]
    publish_evidence: Optional[Callable[[MarketWatch, list[EvidenceEnvelope]], None]] = None
    publish_outbox: Optional[Callable[[], int]] = None
    get_storyboard: Optional[Callable[[str], Optional[dict]]] = None   # storyboard_id -> VideoStoryboardRecord JSON


def _now():
    return datetime.now(timezone.utc)


@dataclass
class _Session:
    view: MarketSessionView
    lock: threading.Lock = field(default_factory=threading.Lock)
    thread: Optional[threading.Thread] = None


class MarketManager:
    def __init__(self, pipeline: MarketPipeline, sessions_dir: Optional[Path] = None, test: bool = False):
        self.pipeline, self.sessions_dir, self.test = pipeline, sessions_dir, test
        self._sessions: dict[str, _Session] = {}
        self._lock = threading.Lock()

    # --- public API (agent/worker.py HTTP routes) ---

    def start(self, prompt: str) -> str:
        with self._lock:
            if self.running() >= MAX_RUNNING:
                raise Busy("{} market updates are already running; try again in a minute".format(MAX_RUNNING))
            sid = "mkt_" + secrets.token_hex(8)
            now = _now()
            session = _Session(MarketSessionView(session_id=sid, status=MarketStatus.starting,
                                                 message="Reading your company description", started_at=now,
                                                 updated_at=now))
            self._sessions[sid] = session
        session.thread = threading.Thread(target=self._run, args=(session, prompt), name="market-" + sid, daemon=True)
        session.thread.start()
        return sid

    def view(self, sid: str) -> Optional[dict]:
        session = self._sessions.get(sid)
        if session is None:
            return None
        with session.lock:
            return session.view.model_dump(mode="json")

    def storyboard(self, storyboard_id: str) -> Optional[dict]:
        return None if self.pipeline.get_storyboard is None else self.pipeline.get_storyboard(storyboard_id)

    def running(self) -> int:
        return sum(1 for s in self._sessions.values() if s.thread is not None and s.thread.is_alive())

    def wait(self, sid: str, timeout: Optional[float] = None) -> Optional[dict]:
        session = self._sessions.get(sid)
        if session and session.thread:
            session.thread.join(timeout)
        return self.view(sid)

    # --- the session ---

    def _update(self, session: _Session, status: Optional[MarketStatus] = None, message: Optional[str] = None,
                **fields):
        with session.lock:
            v = session.view
            changes = dict(fields, updated_at=_now())
            if status is not None:
                changes["status"] = status
            if message is not None:
                changes["message"] = message[:300]
                events = (v.events + [MarketEvent(at=changes["updated_at"], stage=status or v.status,
                                                  message=message[:300])])[-MAX_EVENTS:]
                changes["events"] = events
            session.view = v.model_copy(update=changes)
        self._save(session)

    def _save(self, session: _Session):
        if self.sessions_dir is None:
            return
        try:
            self.sessions_dir.mkdir(parents=True, exist_ok=True)
            path = self.sessions_dir / "{}.json".format(session.view.session_id)
            with session.lock:
                path.write_text(session.view.model_dump_json(indent=2))
        except OSError as e:
            log.warning("could not save market session: %s", e)

    def _run(self, session: _Session, prompt: str):
        p = self.pipeline
        sid = session.view.session_id
        run_id = "{}{}".format("test_" if self.test else "run_", _now().strftime("%Y%m%dT%H%M%S%fZ"))
        try:
            company = p.resolve(prompt)
            self._update(session, MarketStatus.discovering, "Looking for {}'s competitors{}".format(
                company.name, " ({})".format(company.domain) if company.domain else ""), company=company)

            competitors = p.discover(company)
            if not competitors:
                raise RuntimeError("Nimble Search found no competitors for {}".format(company.name))
            watch = p.build_watch(company, competitors, _now())
            self._update(session, MarketStatus.collecting, "Found {} competitors: {}. Collecting recent news".format(
                len(competitors), ", ".join(c.name for c in competitors)), competitors=competitors,
                watch_id=watch.watch_id)

            envelopes, stats = p.collect(watch, run_id)
            usable = sum(1 for e in envelopes if e.usable)
            self._update(session, MarketStatus.analyzing, "Fetched {} pages ({} usable). Reading them for market "
                         "moves".format(len(envelopes), usable), pages_fetched=len(envelopes))

            if p.publish_evidence is not None:
                p.publish_evidence(watch, envelopes)      # evidence first, so the storyboard's citations exist

            analysis = p.analyze(watch, envelopes, run_id)
            developments = sorted(analysis.developments, key=lambda d: (-d.significance, d.observed_at))
            self._update(session, MarketStatus.storyboarding, "{} market developments found".format(
                len(developments)), developments=developments[:TOP_DEVELOPMENTS])
            if not analysis.storyboard_id:
                raise RuntimeError("no storyboard was produced")

            published = False
            if p.publish_outbox is not None:
                p.publish_outbox()                        # developments + the storyboard row B queued
                published = True
            self._update(session, MarketStatus.ready, "Storyboard ready", storyboard_id=analysis.storyboard_id,
                         published=published)
        except Exception as e:  # a failed session reports why; the worker keeps running
            log.exception("market session %s failed", sid)
            self._update(session, MarketStatus.error, "Market update failed", error="{}: {}".format(
                type(e).__name__, str(e)[:300]))

    @staticmethod
    def dumps(obj) -> str:
        return json.dumps(obj, default=str)
