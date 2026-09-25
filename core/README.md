# core: B's state core

The real implementation of B from `docs/ARCHITECTURE.md`, built on `contracts/`. It replaces the spike (`extract_changes.py`, `make_storyboard.py`).

```bash
.venv/bin/python -m pytest tests -q          # 12 offline tests, no network
.venv/bin/python -m core                     # one cycle: new slop_human rows -> state.db (nothing sent to RawTree)
.venv/bin/python -m core --show              # current beliefs + pending changes
.venv/bin/python -m core --publish           # also deliver the outbox to RawTree (rows are PERMANENT)
.venv/bin/python -m core --local DIR --db demo.db   # replay EvidenceEnvelope JSON files into a separate DB
```

## Pieces

| File | Component | PRD |
|---|---|---|
| `sources.py` | Reads `slop_human` (skips the spike's test runs and `test_*`), or a local folder | 11.5 |
| `liquid.py` | `LiquidAdapter`, the only OpenRouter caller: `extract_pricing`, `write_copy`. Records `ModelCallRecord`s | 10.2 |
| `state_machine.py` | `PatchBuilder`: facts + beliefs + pending → `PatchOp`s. Pure, no I/O | 12, 13 |
| `validator.py` | `PatchValidator`: version, duplicates, evidence exists, before = current, sanity (0–100k, ≤10× jump) | 14 |
| `reducer.py` | `Reducer`, the only writer of beliefs, in one transaction with its outbox event. Also `ExpiryWorker` (pricing TTL 48h) | 12.3, 14 |
| `repository.py` | SQLite (WAL): beliefs, pending, readings, observations, applied patches, outbox | 10.5 |
| `storyboard.py` | Meaningfulness gate (significance ≥ 0.6) + composer producing a contract-valid `Storyboard` with `Claim`s | 15, 16 |
| `coordinator.py` | One cycle: expiry → evidence → gate → Liquid → build → validate → reduce → storyboard → `RunRecord`. Plus `OutboxDeliverer` | 8 |

## Outbox → RawTree tables (on `--publish`)

`slop_human_patch_events` (accepted and rejected), `slop_human_run_events`, `slop_human_model_call_events`, `slop_human_build` (storyboards for C). Event IDs are deterministic, so re-publishing never duplicates.

## Not done yet

- `dispute` (two sources disagreeing): the op type exists, but nothing emits it.
- The full-history baseline and the evaluation chart (D7).
- Narrative sources (changelog/news) with Liquid-proposed ops (D2).
- Contract change: `PatchOp.unit` (optional) was added locally and is not in PR #1 yet.
