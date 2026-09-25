"""CLI: python -m acquisition <command>

  run        fetch every enabled source; writes runs/<run_id>.jsonl, and RawTree only with --rawtree
  fixtures   record raw Nimble responses under tests/fixtures (no RawTree writes)
  market     "We're Acme, we make ..." -> company, competitors, recent pages; writes runs/market_<run_id>.*
             (no RawTree writes: the orchestrator inserts the envelopes)
"""
import argparse
import asyncio
import json
from datetime import datetime, timezone

from . import fixtures
from .config import load_watch
from .content import collect_market_content
from .discovery import build_watch, discover_competitors, resolve_company
from .envelope import build
from .env import ROOT, require
from .nimble import NimbleClient
from .rawtree import RawTreeClient
from .search import NimbleSearch, host_of

RUNS_DIR = ROOT / "runs"


def country_locale(regions: list[str]) -> tuple[str, str]:
    country = (regions or ["US"])[0].upper()
    return country, "en-" + country


def selected(sources, only):
    return [s for s in sources if s.enabled and (not only or s.source_id in only or s.entity_id in only)]


async def cmd_run(args) -> None:
    watch, sources = load_watch()
    country, locale = country_locale(watch.regions)
    sources = selected(sources, args.only)[:watch.max_pages_per_run]
    run_id = "run_{}{}".format("dev_" if args.dev else "", datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))

    async with NimbleClient(require("NIMBLE_API_KEY"), concurrency=args.concurrency) as nimble:
        results = await asyncio.gather(*(nimble.extract(s.seed_url, render=s.render, driver=s.driver,
                                                        country=country, locale=locale) for s in sources))
    built = [build(s, run_id, r, country) for s, r in zip(sources, results)]

    RUNS_DIR.mkdir(exist_ok=True)
    out = RUNS_DIR / "{}.jsonl".format(run_id)
    out.write_text("".join(json.dumps(e.model_dump(mode="json")) + "\n" for e, _ in built))

    print("run {}  ({} sources, country={})".format(run_id, len(sources), country))
    for (env, c), r in zip(built, results):
        print("  {:<16} {:<8} http={:<4} chars={:>6} pricing={:<10} {}".format(
            env.source_id, env.status.value, env.http_status or "-", len(env.markdown or ""),
            env.section_hashes.get("pricing", "-")[:10], c.detail or r.error or ""))
    print("wrote {}".format(out.relative_to(ROOT)))

    if args.rawtree:
        async with RawTreeClient(require("RAWTREE_API_KEY")) as rt:
            await rt.insert([e for e, _ in built])
        print("inserted {} rows into RawTree slop_human".format(len(built)))


async def cmd_fixtures(args) -> None:
    watch, sources = load_watch()
    country, locale = country_locale(watch.regions)
    sources = selected(sources, args.only)
    async with NimbleClient(require("NIMBLE_API_KEY"), concurrency=args.concurrency) as nimble:
        jobs = [(s, nimble.extract(s.seed_url, render=s.render, driver=s.driver, country=country, locale=locale))
                for s in sources for _ in range(args.times)]
        results = await asyncio.gather(*(j for _, j in jobs))
    for (s, _), r in zip(jobs, results):
        path = fixtures.save(s.source_id, r)
        print("{:<16} http={} md={:>6} html={:>7} attempts={} {}".format(
            s.source_id, r.http_status, len(r.markdown), len(r.html), r.attempts, path.name))


def liquid_llm(run_id: str):
    """Sync prompt -> text over OpenRouter, with core.liquid's settings (mandatory reasoning, 429 backoff)."""
    from core.liquid import LiquidAdapter
    adapter = LiquidAdapter(require("OPENROUTER_API_KEY"))

    def call(prompt: str) -> str:
        text, record = adapter._call(prompt, run_id, "market_discovery", 4000)
        if not record.ok:
            print("  (liquid failed: {}; using the fallback)".format(record.error))
        return text or ""
    return call


async def cmd_market(args) -> None:
    run_id = "run_{}{}".format("dev_" if args.dev else "", datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    llm = None if args.no_llm else liquid_llm(run_id)
    api_key = require("NIMBLE_API_KEY")
    async with NimbleSearch(api_key) as search, NimbleClient(api_key, concurrency=args.concurrency) as nimble:
        company = await resolve_company(args.prompt, search, llm)
        print("company  {} ({})  category={!r}".format(company.name, company.domain or "domain unknown",
                                                      company.category))
        competitors = await discover_competitors(company, search, llm, max_competitors=args.competitors)
        print("competitors  ({} discovery searches so far)".format(search.calls))
        for c in competitors:
            print("  {:<20} {:<22} score={:.2f} mentions={:<2} e.g. {}".format(
                c.name, c.domain or "-", c.score, c.mentions, c.seen_in[0] if c.seen_in else "-"))
        watch = build_watch(company, competitors, datetime.now(timezone.utc), lookback_days=args.lookback_days)
        envelopes, funnel = await collect_market_content(watch, search, nimble, run_id, max_pages=args.max_pages,
                                                         include_self=not args.no_self)

    print("pages")
    for e in envelopes:
        print("  {:<16} {:<8} {:<8} {:<28} chars={:>6}  {}".format(
            e.entity_id[:16], e.status.value, e.source_type.value, host_of(e.url)[:28], len(e.markdown or ""),
            (e.structured or {}).get("title", "")[:60]))
    print("funnel  " + json.dumps(funnel))
    print("nimble search calls={} errors={}".format(search.calls, search.errors or "none"))

    RUNS_DIR.mkdir(exist_ok=True)
    out = RUNS_DIR / "market_{}.jsonl".format(run_id)
    out.write_text("".join(json.dumps(e.model_dump(mode="json")) + "\n" for e in envelopes))
    watch_out = RUNS_DIR / "market_{}.watch.json".format(run_id)
    watch_out.write_text(watch.model_dump_json(indent=2))
    print("wrote {} and {}".format(out.relative_to(ROOT), watch_out.relative_to(ROOT)))


def main() -> None:
    ap = argparse.ArgumentParser(prog="acquisition")
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="fetch sources and build EvidenceEnvelopes")
    r.add_argument("--only", nargs="*", help="source_ids or entity_ids")
    r.add_argument("--rawtree", action="store_true", help="also insert into slop_human (permanent: no delete)")
    r.add_argument("--dev", action="store_true", help="prefix run_id with run_dev_ so test rows are easy to filter")
    r.add_argument("--concurrency", type=int, default=4)
    r.set_defaults(func=cmd_run)

    f = sub.add_parser("fixtures", help="record raw Nimble responses under tests/fixtures (no RawTree writes)")
    f.add_argument("--only", nargs="*", help="source_ids or entity_ids")
    f.add_argument("--times", type=int, default=1, help="fetches per source")
    f.add_argument("--concurrency", type=int, default=4)
    f.set_defaults(func=cmd_fixtures)

    m = sub.add_parser("market", help="prompt -> competitors -> recent pages as EvidenceEnvelopes (no RawTree)")
    m.add_argument("prompt", help="e.g. \"We're Acme, we make invoicing software for freelancers\"")
    m.add_argument("--max-pages", type=int, default=20)
    m.add_argument("--competitors", type=int, default=4)
    m.add_argument("--lookback-days", type=int, default=30)
    m.add_argument("--no-self", action="store_true", help="don't collect pages about the user's own company")
    m.add_argument("--no-llm", action="store_true", help="deterministic fallbacks only (no Liquid calls)")
    m.add_argument("--dev", action="store_true", help="prefix run_id with run_dev_")
    m.add_argument("--concurrency", type=int, default=4)
    m.set_defaults(func=cmd_market)

    args = ap.parse_args()
    asyncio.run(args.func(args))


if __name__ == "__main__":
    main()
