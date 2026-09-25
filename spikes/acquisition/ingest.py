"""Scrape competitors with Nimble and write EvidenceEnvelope rows to RawTree table `slop_human`.

Usage:
  python3 ingest.py                       # every competitor in competitors.json -> RawTree
  python3 ingest.py --only notion         # one competitor
  python3 ingest.py --local snapshots     # write JSON files instead of RawTree

Every fetch is written, including failures: status tells the reader whether to trust it.
"""
import argparse
import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from smoke_test import NIMBLE_URL, RAWTREE_BASE, TABLE, load_env, post

PARSER_VERSION = "nimble-md-v1"
SOURCE_ID = "nimble"


def sha(*parts):
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


def pricing_section(markdown):
    """The part of the page around the prices, normalized so cosmetic changes don't alter its hash."""
    i = markdown.find("$")
    if i < 0:
        return ""
    s = markdown[max(0, i - 2000):i + 12000]
    s = re.sub(r"\(https?://[^)]*\)|!\[[^\]]*\]", "", s)  # drop link targets and images
    return re.sub(r"\s+", " ", s).strip().lower()


def scrape(url, key):
    """Returns (status, markdown, nimble_task_id)."""
    last = None
    for attempt in range(3):
        code, res, _ = post(NIMBLE_URL, key, {"url": url, "render": True, "formats": ["markdown", "html"]})
        if code == 200:
            data = res.get("data", {})
            md = data.get("markdown") or ""
            if len(md) < 1000:  # half-rendered page: fall back to stripped html
                html = re.sub(r"<script.*?</script>|<style.*?</style>", " ", data.get("html", ""), flags=re.S)
                md = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()
            return ("empty" if len(md) < 500 else "ok"), md, res.get("task_id")
        last = code
        time.sleep(2 * (attempt + 1))
    return ("blocked" if last in (401, 403, 429) else "error"), None, None


def envelope(comp, run_id, status, md, task_id):
    fetched_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    section = pricing_section(md or "")
    if status == "ok" and comp["source_type"] == "pricing" and not section:
        status = "partial"  # page loaded but no prices in it
    return {
        "obs_id": sha(SOURCE_ID, comp["url"], fetched_at)[:24],
        "run_id": run_id,
        "source_id": SOURCE_ID,
        "entity_id": comp["entity_id"],
        "entity_name": comp["entity_name"],
        "source_type": comp["source_type"],
        "url": comp["url"],
        "fetched_at": fetched_at,
        "status": status,
        "parser_version": PARSER_VERSION,
        "content_hash": sha(md or ""),
        "section_hashes": {"pricing": sha(section)} if section else {},
        "structured": None,
        "markdown": md,
        "nimble_task_id": task_id,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="entity_id to scrape")
    ap.add_argument("--local", help="write JSON files to this folder instead of RawTree")
    args = ap.parse_args()

    load_env()
    nimble_key = os.environ["NIMBLE_API_KEY"]
    rt_key = os.environ.get("RAWTREE_API_KEY")
    comps = [c for c in json.load(open("competitors.json")) if not args.only or c["entity_id"] == args.only]
    run_id = "run_" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    rows = []
    for comp in comps:
        status, md, task_id = scrape(comp["url"], nimble_key)
        row = envelope(comp, run_id, status, md, task_id)
        rows.append(row)
        print("  {:<8} {:<8} {:>6} chars  obs_id={}".format(comp["entity_id"], row["status"], len(md or ""), row["obs_id"]))

    if args.local:
        Path(args.local).mkdir(exist_ok=True)
        for r in rows:
            (Path(args.local) / (r["obs_id"] + ".json")).write_text(json.dumps(r))
        print("wrote {} rows to {}/".format(len(rows), args.local))
    else:
        code, res, _ = post("{}/tables/{}".format(RAWTREE_BASE, TABLE), rt_key, rows)
        if code != 200:
            raise SystemExit("RawTree insert failed: HTTP {} {}".format(code, res))
        print("wrote {} rows to RawTree table {} (run {})".format(len(rows), TABLE, run_id))


if __name__ == "__main__":
    main()
