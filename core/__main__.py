"""Run one monitoring cycle.

  python -m core                      # read new rows from RawTree slop_human, update state.db
  python -m core --local fixtures/    # read EvidenceEnvelope JSON files instead
  python -m core --publish            # also deliver queued events + storyboards to RawTree (permanent!)
  python -m core --show               # print current beliefs and exit

Nothing is written to RawTree without --publish. Events wait in the SQLite outbox until then.
"""
import argparse
import os
import sys
from pathlib import Path

from .coordinator import Coordinator, OutboxDeliverer
from .http import load_env
from .liquid import LiquidAdapter
from .repository import StateRepository
from .sources import LocalSource, RawTreeClient, RawTreeSource
from .storyboard import narration_warnings


def show(repo):
    names = repo.entity_names()
    beliefs = repo.active_beliefs()
    print("state v{} · {} active beliefs · ~{} tokens".format(repo.version, len(beliefs), repo.state_tokens()))
    for b in beliefs:
        print("  {:<10} {:<34} {:>9}  {:<20} confirmed {}  evidence {}".format(
            names.get(b.entity_id, b.entity_id), b.attribute, str(b.value), str(b.unit or ""),
            b.last_confirmed_at.strftime("%m-%d %H:%M"), len(b.evidence_ids)))
    pending = [p for e in names for p in repo.pending(e).values()]
    for p in pending:
        print("  pending: {} {} {} -> {} (seen {}x)".format(names.get(p.entity_id), p.attribute, p.kind, p.value, p.seen))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--local", help="folder of EvidenceEnvelope JSON files instead of RawTree")
    ap.add_argument("--db", default="state.db")
    ap.add_argument("--publish", action="store_true", help="deliver the outbox to RawTree (rows are permanent)")
    ap.add_argument("--no-copy", action="store_true", help="don't ask Liquid to phrase voiceover lines")
    ap.add_argument("--test", action="store_true", help="mark run and storyboards as test data")
    ap.add_argument("--out", default="out", help="folder for storyboard JSON files")
    ap.add_argument("--show", action="store_true", help="print current beliefs and exit")
    args = ap.parse_args()

    load_env()
    repo = StateRepository(args.db)
    if args.show:
        show(repo)
        return

    or_key, rt_key = os.environ.get("OPENROUTER_API_KEY"), os.environ.get("RAWTREE_API_KEY")
    if not or_key:
        sys.exit("Missing OPENROUTER_API_KEY in .env")
    if (not args.local or args.publish) and not rt_key:
        sys.exit("Missing RAWTREE_API_KEY in .env")
    client = RawTreeClient(rt_key) if rt_key else None
    source = LocalSource(args.local) if args.local else RawTreeSource(client)

    coord = Coordinator(repo, source, LiquidAdapter(or_key), use_liquid_copy=not args.no_copy, is_test=args.test)
    run, storyboard, decisions = coord.run_cycle()

    print("run {}".format(run.run_id))
    print("  pages {} · invalid {} · unchanged (no Liquid) {} · Liquid calls {} · tokens in/out {}/{}".format(
        run.pages_fetched, run.pages_invalid, run.skipped_unchanged, run.liquid_calls,
        run.input_tokens, run.output_tokens))
    print("  ops proposed {} · accepted {} · rejected {}".format(run.ops_proposed, run.ops_accepted, run.ops_rejected))
    for d in decisions:
        if not d.accepted:
            print("  REJECTED {}: {}".format(d.patch_id, "; ".join(d.rejected_reasons)))
    if storyboard:
        Path(args.out).mkdir(exist_ok=True)
        path = Path(args.out) / "storyboard_{}.json".format(storyboard.storyboard_id)
        path.write_text(storyboard.model_dump_json(indent=2))
        print("  storyboard: {} scenes, {:g}s -> {}".format(len(storyboard.scenes), storyboard.total_duration_sec, path))
        for w in narration_warnings(storyboard):
            print("    narration too long:", w)
    else:
        print("  no meaningful change, so no storyboard")
    show(repo)

    queued = repo.undelivered()
    if args.publish:
        print("published {} events to RawTree".format(OutboxDeliverer(repo, client).deliver()))
    elif queued:
        print("{} events queued in the outbox (not sent). Re-run with --publish to deliver them to RawTree.".format(
            len(queued)))


if __name__ == "__main__":
    main()
