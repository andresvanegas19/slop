# Decisions

Refinements to [PRD.md](../PRD.md) based on building and testing a vertical slice. Status **Proposed** means it needs team sign-off.

---

### D1 · `obs_id` is unique per fetch, not per content · Proposed

**PRD 20** hashes source, URL and *content*, so two identical fetches share an ID.
**Problem:** confirmation (`confirm`, `last_confirmed_at`) needs every fetch to count as its own evidence. With content-based IDs, a page seen unchanged at 09:00 and 15:00 is one observation, and a blocked or empty fetch collides with every other blocked fetch.
**Decision:** `obs_id = sha256(source_id | url | fetched_at)[:24]` (`contracts.make_obs_id`). Deduplication uses `content_hash` and `section_hashes`, so "identical content never calls Liquid twice" still holds.

### D2 · For numeric sources, Liquid extracts and code decides the operation · Proposed

**PRD 13** has Liquid propose typed patch operations.
**Problem:** in testing, the 2.6B model read the same Notion page as "Plus" on one run and "Plus\*" (a footnote marker) on the next. Asked to propose operations, it would have reported a new plan.
**Decision:**
- *Pricing, and any source whose facts are numbers:* Liquid only extracts facts (`{plan, price, unit}`). Code compares them with beliefs and builds the `PatchOp`s (`Patch.origin = "diff"`).
- *Changelog, news, jobs text:* Liquid proposes ops directly (`origin = "liquid"`) and the `PatchValidator` checks them.

Both still satisfy "models propose, code decides".

### D3 · A value change must be seen twice before it's applied · Proposed

A different value in a single fetch is held as pending. It becomes a `replace` only after `CONFIRMATIONS = 2` fetches agree. The same applies to new plans, and a plan must be missing twice before it's retracted. This absorbs model misreadings and half-rendered pages. The cost is one extra cycle of latency, which the demo covers by fetching twice.

### D4 · Field names follow A's envelope · Proposed

Contracts use `obs_id`, `url` and `fetched_at` (already in RawTree and shared with the team) rather than the PRD's `observation_id`, `canonical_url` and `retrieved_at`. Same meaning, different names.

### D5 · Every RawTree table starts with `slop_human` · Accepted

The RawTree database is shared by all hackathon teams (30+ foreign tables). The PRD's six tables become `slop_human` (observations) and `slop_human_{patch,run,model_call,media,evaluation}_events`; see `contracts/common.py`. Never write to a table without the prefix. Creating and deleting tables needs an admin key; ours isn't one, so our rows are effectively permanent (and other teams can't delete our tables either). Tag test rows (`run_id` starting `test_`, or `is_test`) and filter them out.

### D6 · B produces the storyboard; C renders it · Proposed

**PRD 26** puts the storyboard composer under Output. Proposal: B owns it, because only B has the beliefs and evidence needed to fill `Claim`s, and the `Storyboard` validator requires them. C receives a finished storyboard through `slop_human_build` (D8) and owns everything visual.

### D7 · B owns evaluation · Proposed

**PRD 26's** "Data and evaluation" workstream has no owner in the A/B/C split, yet it produces the main demo chart (stateful vs full-history). B already records `RunRecord`s, so B runs the baseline over the same observations.

### D8 · B hands storyboards to C through RawTree `slop_human_build` · Proposed

Each teammate runs on their own machine, so a local `storyboard.json` can't reach C. B inserts `StoryboardRecord` rows (the storyboard as one JSON string). C polls for rows without a `done` `MediaJob` and records progress in `slop_human_media_events`. There are no updates, only new rows. See ARCHITECTURE.md.

### D9 · Liquid runs through OpenRouter · Accepted

The model is `liquid/lfm-2.5-2.6b:free` via OpenRouter; see SPIKE_FINDINGS for the required settings. It sits behind one adapter function, so switching to a sponsor endpoint changes one file.
