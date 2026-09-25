# Acquisition spike (A)

Prototype code that scrapes competitor pages with Nimble and writes one evidence row per fetch to RawTree table `slop_human`. It works end to end, but it's a **spike**: a starting point, not production code. Not meant to be merged as is.

## Setup

```bash
cd spikes/acquisition
cp .env.example .env        # fill in NIMBLE_API_KEY and RAWTREE_API_KEY (never commit .env)
```

Python 3.9+, standard library only.

## Run

```bash
python3 ingest.py --local snapshots   # scrape into local JSON files first (safe)
python3 ingest.py --only notion       # one competitor -> RawTree
python3 ingest.py                     # everything in competitors.json -> RawTree
python3 show_columns.py               # columns and row count of slop_human (read-only)
python3 smoke_test.py <url>           # quick Nimble -> RawTree round trip (writes to slop_human_smoke)
```

## What it does per page

1. Nimble `POST /v2/extract` with `render: true` and `formats: ["markdown", "html"]`, retried up to 3× on errors.
2. If the markdown is under 1,000 chars (a half-rendered page), fall back to stripped HTML.
3. Set `status`: `ok`, `partial` (pricing page with no `$`), `empty` (<500 chars), `blocked` (401/403/429) or `error`. **Failures are written too.**
4. Compute `section_hashes.pricing`: a hash of the *normalized* pricing section (links and images removed, whitespace collapsed, lowercased). B skips the Liquid call when this is unchanged.
5. `obs_id = sha256(source_id|url|fetched_at)[:24]`: unique per fetch (see `docs/DECISIONS.md` D1 in PR #1).

## Known gaps (yours to take over)

- **Not on the contracts yet.** It builds plain dicts matching `EvidenceEnvelope` in `contracts/evidence.py` (PR #1). Switch to the Pydantic model.
- **Jira returns `partial`:** its prices aren't in what Nimble returns. Try browser actions, a longer render wait, or the stealth driver (`vx10`), or drop Jira.
- **The pricing-section finder is crude:** a window around the first `$`. Nimble parsing schemas (`structured`) would be sturdier.
- `ingest.py` imports helpers from `smoke_test.py`. Merge them.
- Sequential fetching (7–18 s per page). Make it concurrent.

## Careful

- The RawTree database is **shared by every hackathon team**. Only write tables starting with `slop_human`.
- RawTree has **no delete**, so every row you insert is permanent. Test with `--local` first.
- `slop_human` already holds 6 test rows (run IDs `run_20260925T194641Z` and `run_20260925T194801Z`). Ignore them.
