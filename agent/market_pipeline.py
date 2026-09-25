"""Wires MarketManager (agent/market.py) to the real acquisition (A) and state-core (B) functions.

Each stage runs in the session's own thread: async Nimble clients get a fresh event loop per stage, and B opens its
own StateRepository because core's SQLite connection can't be shared across threads. B writes happen under the
worker's loop lock so a market session never interleaves with the periodic core cycle.
"""
import asyncio
import logging
import threading
from datetime import datetime

from contracts import TABLES, CompanyBrief, CompetitorCandidate, EvidenceEnvelope, MarketWatch

from .market import MarketAnalysis, MarketPipeline

log = logging.getLogger("agent.market")
MAX_COMPETITORS = 4
MAX_PAGES = 20


def liquid_text(settings):
    """A sync prompt -> text callable over the project's Liquid adapter, or None without an OpenRouter key."""
    if not settings.openrouter_key:
        return None
    from core.liquid import LiquidAdapter
    adapter = LiquidAdapter(settings.openrouter_key)

    def call(prompt: str) -> str:
        text, _record = adapter._call(prompt, "market", "market_discovery", 4000)
        return text
    return call


def build_pipeline(settings, rawtree=None, publish=False, lock=None) -> MarketPipeline:
    from acquisition import discovery
    from acquisition.content import collect_market_content
    from acquisition.env import require
    from acquisition.nimble import NimbleClient
    from acquisition.search import NimbleSearch

    nimble_key = require("NIMBLE_API_KEY")
    llm = liquid_text(settings)
    lock = lock or threading.Lock()

    def resolve(prompt: str) -> CompanyBrief:
        async def go():
            async with NimbleSearch(nimble_key) as search:
                return await discovery.resolve_company(prompt, search, llm)
        return asyncio.run(go())

    def discover(company: CompanyBrief) -> list[CompetitorCandidate]:
        async def go():
            async with NimbleSearch(nimble_key) as search:
                return await discovery.discover_competitors(company, search, llm, max_competitors=MAX_COMPETITORS)
        return asyncio.run(go())

    def collect(watch: MarketWatch, run_id: str) -> tuple[list[EvidenceEnvelope], dict]:
        async def go():
            async with NimbleSearch(nimble_key) as search, NimbleClient(nimble_key) as nimble:
                return await collect_market_content(watch, search, nimble, run_id, max_pages=MAX_PAGES)
        return asyncio.run(go())

    def analyze(watch: MarketWatch, envelopes: list[EvidenceEnvelope], run_id: str) -> MarketAnalysis:
        from core.liquid import LiquidAdapter
        from core.market import MarketCycle
        from core.repository import StateRepository
        if not settings.openrouter_key:
            raise RuntimeError("OPENROUTER_API_KEY is required to read articles for market developments")
        with lock:
            repo = StateRepository(settings.state_db)
            try:
                res = MarketCycle(repo, LiquidAdapter(settings.openrouter_key), watch).run(envelopes, run_id=run_id)
            finally:
                repo.db.close()
        log.info("market cycle %s: %d new / %d active developments, %d Liquid calls, %d unchanged skipped",
                 run_id, len(res.new_developments), len(res.developments), res.liquid_calls, res.skipped_unchanged)
        return MarketAnalysis(developments=res.developments,
                              storyboard_id=res.record.storyboard_id if res.record else None,
                              liquid_calls=res.liquid_calls, skipped_unchanged=res.skipped_unchanged)

    def get_storyboard(storyboard_id: str):
        from core.repository import StateRepository
        repo = StateRepository(settings.state_db)
        try:
            record = repo.get_video_storyboard(storyboard_id)
        finally:
            repo.db.close()
        return None if record is None else record.model_dump(mode="json")

    publish_evidence = publish_outbox = None
    if publish and rawtree is not None:
        from acquisition.rawtree import RawTreeClient

        def publish_evidence(watch: MarketWatch, envelopes: list[EvidenceEnvelope]) -> None:
            async def go():
                async with RawTreeClient(require("RAWTREE_API_KEY")) as rt:
                    if envelopes:
                        await rt.insert(envelopes)
            asyncio.run(go())
            rawtree.insert(TABLES["market_watch"], [{"watch_id": watch.watch_id, "company_name": watch.company.name,
                                                     "version": watch.version, "created_at": watch.created_at.isoformat(),
                                                     "watch_json": watch.model_dump_json()}])

        def publish_outbox() -> int:
            from core.coordinator import OutboxDeliverer
            from core.repository import StateRepository
            with lock:
                repo = StateRepository(settings.state_db)
                try:
                    return OutboxDeliverer(repo, rawtree).deliver()
                finally:
                    repo.db.close()

    return MarketPipeline(
        resolve=resolve, discover=discover, collect=collect, analyze=analyze,
        build_watch=lambda company, competitors, now: discovery.build_watch(company, competitors, now),
        publish_evidence=publish_evidence, publish_outbox=publish_outbox, get_storyboard=get_storyboard,
    )
