"""Smoke test: Nimble scrape -> RawTree insert -> RawTree query.

Keys are read from .env (or the environment). Nothing secret is printed.
Usage: python3 smoke_test.py [url]
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

NIMBLE_URL = "https://sdk.nimbleway.com/v2/extract"
RAWTREE_BASE = "https://api.rawtree.com/v1"
TABLE = "slop_human"             # our evidence table (EvidenceEnvelope rows). The RawTree db is shared by all teams.
SMOKE_TABLE = "slop_human_smoke"  # this test writes here so it never touches the real table
TARGET = sys.argv[1] if len(sys.argv) > 1 else "https://www.notion.com/pricing"


def load_env():
    env_file = Path(__file__).with_name(".env")
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def post(url, key, body):
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read() or b"null"), time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")[:500], time.time() - t0


def check(name, status, payload, secs):
    ok = 200 <= status < 300
    print("[{}] {} -> HTTP {} ({:.1f}s)".format("PASS" if ok else "FAIL", name, status, secs))
    if not ok:
        print("       ", payload)
    return ok


def main():
    load_env()
    nimble_key = os.environ.get("NIMBLE_API_KEY")
    rawtree_key = os.environ.get("RAWTREE_API_KEY")
    if not nimble_key:
        sys.exit("Missing in .env: NIMBLE_API_KEY")

    # 1. Nimble: scrape a competitor page as markdown
    for attempt in range(3):  # sites intermittently block (403) or return a half-rendered page
        status, res, secs = post(NIMBLE_URL, nimble_key, {"url": TARGET, "render": True, "formats": ["markdown", "html"]})
        if 200 <= status < 300:
            break
        print("        attempt {} got HTTP {}, retrying".format(attempt + 1, status))
        time.sleep(2 * (attempt + 1))
    if not check("Nimble extract " + TARGET, status, res, secs):
        sys.exit(1)
    data = res.get("data", {})
    content = data.get("markdown") or ""
    if len(content) < 1000:  # render sometimes returns only the nav; fall back to stripped html
        html = re.sub(r"<script.*?</script>|<style.*?</style>", " ", data.get("html", ""), flags=re.S)
        content = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()
    print("        got {} chars; preview: {!r}".format(len(content), content[:150]))

    if not rawtree_key:
        print("\nNimble works. Skipping RawTree (no RAWTREE_API_KEY in .env).")
        return

    # 2. RawTree: insert the raw observation (table auto-creates on first insert)
    row = {
        "obs_id": res.get("task_id") or str(int(time.time())),
        "url": TARGET,
        "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "chars": len(content),
        "content": content[:50000],
    }
    status, ins, secs = post("{}/tables/{}".format(RAWTREE_BASE, SMOKE_TABLE), rawtree_key, [row])
    if not check("RawTree insert into " + SMOKE_TABLE, status, ins, secs):
        sys.exit(1)

    # 3. RawTree: read it back
    sql = "SELECT url, fetched_at, chars FROM {} ORDER BY fetched_at DESC LIMIT 5".format(SMOKE_TABLE)
    for _ in range(5):  # a just-created table takes a few seconds to become queryable
        status, q, secs = post(RAWTREE_BASE + "/query", rawtree_key, {"sql": sql})
        if status == 200:
            break
        time.sleep(3)
    if not check("RawTree query", status, q, secs):
        sys.exit(1)
    print("        rows:", json.dumps(q.get("data", q) if isinstance(q, dict) else q, indent=2)[:800])
    print("\nAll good: Nimble -> RawTree pipeline works.")


if __name__ == "__main__":
    main()
