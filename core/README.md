# core: B's state core

The real implementation of B from `docs/ARCHITECTURE.md`, built on `contracts/`. It replaces the spike (`extract_changes.py`, `make_storyboard.py`).

```bash
uv run pytest -q                             # offline tests, no network
.venv/bin/python -m core                     # one cycle: new slop_human rows -> state.db (nothing sent to RawTree)
.venv/bin/python -m core --show              # current beliefs + pending changes
.venv/bin/python -m core --publish           # also deliver the outbox to RawTree (rows are PERMANENT)
.venv/bin/python -m core --local DIR --db demo.db   # replay EvidenceEnvelope JSON files into a separate DB
```

## Pieces

| File | Component | PRD |
|---|---|---|
| `sources.py` | Reads `slop_human` (skips the spike's test runs and `test_*`), or a local folder. Folds `section_hashes.*` and `structured.*` columns back into dicts | 11.5 |
| `liquid.py` | `LiquidAdapter`, the only OpenRouter caller: `extract_pricing`, `write_copy`, `extract_developments` (0-3 per article, trimmed window, one retry on unparseable JSON), `write_market_copy`. Records `ModelCallRecord`s | 10.2 |
| `state_machine.py` | `PatchBuilder`: facts + beliefs + pending → `PatchOp`s. Pure, no I/O | 12, 13 |
| `validator.py` | `PatchValidator`: version, duplicates, evidence exists, before = current; price sanity (0–100k, ≤10× jump) on `pricing.*` only; `developments.*` values must be a development whose id/entity match the key | 14 |
| `reducer.py` | `Reducer`, the only writer of beliefs, in one transaction with its outbox event. Also `ExpiryWorker` (pricing TTL 48h) | 12.3, 14 |
| `repository.py` | SQLite (WAL): beliefs, pending, readings, observations, applied patches, outbox; market: `article_readings`, `evidence_refs`, `video_storyboards` (`get_video_storyboard`, `latest_video_storyboard`) | 10.5 |
| `storyboard.py` | Meaningfulness gate (significance ≥ 0.6) + composer producing a contract-valid `Storyboard` with `Claim`s | 15, 16 |
| `market.py` | Market path: grounding (quote verbatim in the markdown, right entity), `MarketAnalyzer` (article-hash gate, add/confirm `developments.<id>` beliefs), `MarketCycle` entry point | 12, 16 |
| `video_storyboard.py` | `compose_market_storyboard`: developments → contract-valid `VideoStoryboard` (5–20 s scenes, narration ≤ 2.5 words/s, phone-footage prompts without names/text) | 15, 16 |
| `coordinator.py` | One cycle: expiry → evidence → route by `source_type` (pricing → PatchBuilder path; news/changelog → `MarketAnalyzer`, only with a watch) → validate → reduce → storyboard(s) → `RunRecord`. Plus `OutboxDeliverer` | 8 |

## Market path (news / changelog)

```python
from core.market import MarketCycle
result = MarketCycle(StateRepository("state.db"), LiquidAdapter(key), watch).run(envelopes)   # or source=RawTreeSource(c)
result.new_developments, result.developments        # MarketDevelopment lists (active: most significant first)
result.record                                       # VideoStoryboardRecord; also repo.latest_video_storyboard(watch.watch_id)
```

Per usable envelope about a tracked competitor: article hash (`section_hashes["article"]`, else a hash of the normalized
markdown) already processed → reuse its developments with **no model call** (confirm); otherwise Liquid proposes 0–3,
code keeps only those whose `quote` is a markup/case/whitespace-insensitive substring of the markdown and that are about
the envelope's entity. Each kept development is a belief `developments.<development_id>` (value = the development's
JSON; op `add`, then `confirm`), and new ones are queued for `slop_human_market_developments`.
After the envelopes, the cycle composes the `VideoStoryboard` (title 5 s → up to 4 `dev-N` 6–7 s → `implications` 7 s →
`outro` 5 s; or a "quiet" storyboard citing the envelopes checked). Its id hashes watch + development ids, so the same
facts give the same storyboard (no second copy call, no duplicate row). It is stored in SQLite `video_storyboards` and
queued for `slop_human_video_storyboards`.

## Outbox → RawTree tables (on `--publish`)

`slop_human_patch_events` (accepted and rejected), `slop_human_run_events`, `slop_human_model_call_events`, `slop_human_build` (legacy pricing storyboards), `slop_human_market_developments`, `slop_human_video_storyboards` (`VideoStoryboardRecord`s for C). Event IDs are deterministic, so re-publishing never duplicates.

## Not done yet

- `dispute` (two sources disagreeing): the op type exists, but nothing emits it.
- The full-history baseline and the evaluation chart (D7).
- `python -m core` has no MarketWatch, so it records news/changelog rows without analysing them; use `MarketCycle`.
- Contract change: `PatchOp.unit` (optional) was added locally and is not in PR #1 yet.
