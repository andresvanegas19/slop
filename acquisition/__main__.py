"""CLI: python -m acquisition <command>

  run        fetch every enabled source; writes runs/<run_id>.jsonl, and RawTree only with --rawtree
  fixtures   record raw Nimble responses under tests/fixtures (no RawTree writes)
"""
import argparse
import asyncio
import json
from datetime import datetime, timezone

from . import fixtures
from .config import load_watch
from .envelope import build
from .env import ROOT, require
from .nimble import NimbleClient
from .rawtree import RawTreeClient

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

    args = ap.parse_args()
    asyncio.run(args.func(args))


if __name__ == "__main__":
    main()
