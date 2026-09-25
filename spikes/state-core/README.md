# State-core spike (B)

Prototype of B's layer: reads evidence rows from RawTree `slop_human`, has Liquid extract pricing facts, runs the belief state machine, and writes what changed. **Not the real state core:** it doesn't use `contracts/` (PR #1) yet and keeps state in a JSON file instead of SQLite. It's here so the team can see and run the logic. Not for merge.

## Setup

```bash
cd spikes/state-core
cp .env.example .env        # RAWTREE_API_KEY and OPENROUTER_API_KEY (never commit .env)
```

Python 3.9+, standard library only. The OpenRouter account needs two privacy settings for the free Liquid model: see `docs/SPIKE_FINDINGS.md` in PR #1.

## Run

```bash
python3 extract_changes.py                        # new rows in slop_human -> state.json + changes.json
python3 make_storyboard.py changes.json out.json  # changes -> 30s storyboard (skipped if nothing changed)
python3 make_storyboard.py                        # sample storyboard from mock_changes.json (fictional data)
```

Delete `state.json` to start from an empty memory. The first run on a competitor only records a baseline, so it reports 0 changes.

## The state machine (`apply_observation` in extract_changes.py)

```
new plan after baseline  -> unconfirmed -> seen again -> active (emits new_plan)
                                        -> missing once -> forgotten, never reported
active + same value      -> confirm (refresh last_verified)
active + different value -> pending -> same new value again -> replace (emits price_cut / price_increase)
active + missing twice   -> retracted (emits deprecation)
status != ok             -> no transition at all (a blocked page is not evidence of absence)
```

Also:

- **Pricing-hash gate:** if `section_hashes.pricing` is unchanged, the last Liquid reading is reused. No model call.
- **Plan-name cleanup:** "Plus\*" becomes "plus", because Liquid adds footnote marks inconsistently.
- **Liquid:** `liquid/lfm-2.5-2.6b:free` via OpenRouter, `reasoning.effort=low`, `max_tokens=4000` (reasoning is mandatory and uses up the budget).
- **Test rows:** `EXCLUDED_RUNS` filters the spike's test rows out of `slop_human`. RawTree can't delete them.

## Verified

On A's first run (`run_dev_20260925T202750Z`), Liquid read Notion ($0 / $10 / $20 / custom), Linear ($0 / $10 / $16 / custom) and Jira ($0 / $7.91 / $14.54 / custom), all matching the pages. A planted $10 → $8 change was held on the first fetch and emitted as `price_cut` on the second.

## Not done (the real core)

SQLite with `Belief` rows, `Patch` → `PatchValidator` → `Reducer` in one transaction, the outbox to `slop_human_*_events`, `Claim`s in the storyboard, publishing to `slop_human_build`, expiry, dispute, `RunRecord`, and the full-history baseline.

## For C

`STORYBOARD_FORMAT.md` explains every field, and `storyboard.json` is a sample (fictional competitors) to build against. The live handoff will be RawTree `slop_human_build`: see `docs/ARCHITECTURE.md` in PR #1.
