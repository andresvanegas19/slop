# Spike findings

What each service actually did when tested on 2026-09-25, as input to [PRD.md](../PRD.md) §31 (open questions). Test pages: Notion, Linear and Jira pricing.

## Nimble (web acquisition)

| Finding | Evidence | Consequence |
|---|---|---|
| Works with `POST https://sdk.nimbleway.com/v2/extract`, Bearer key | 200s on all three sites | The older `api.webit.live` endpoint isn't needed |
| **The same page returns very different sizes** | Notion markdown across scrapes: 306 / 25,749 / 12,242 / 10,656 / 15,536 chars | Full-page `content_hash` changes on nearly every fetch. Gate on a *normalized pricing section* hash instead |
| Occasionally returns a half-rendered page | The 306-char result was only the nav bar | If markdown is under 1,000 chars, fall back to stripped HTML (request `formats: ["markdown","html"]`) |
| Intermittent blocks | Linear returned 403 once; the next two attempts were 200 | Retry up to 3× with backoff before setting `status=blocked` |
| Some prices aren't in the scraped page at all | Jira: 21k chars, plan names, zero `$` | Mark `status=partial`. Needs browser actions or a longer render wait, or drop Jira from the demo |
| Latency | 7–18 s per page with `render: true` | Fetch concurrently |

## Liquid (via OpenRouter)

| Finding | Evidence | Consequence |
|---|---|---|
| Model: `liquid/lfm-2.5-2.6b:free`, 65k context, $0 | OpenRouter model list | Answers PRD §31 Q1 |
| **Two OpenRouter privacy settings block it by default** | 404 "0 endpoints … matching your data policy" | Account → Privacy: turn **off** ZDR for "All other models" and turn **on** "free endpoints that train on request data". Only send public data |
| **Reasoning is mandatory** | `reasoning.enabled=false` → 400 "Reasoning is mandatory" | Use `reasoning: {effort: "low"}` |
| Reasoning consumes the token budget | `max_tokens: 800` returned empty `content`; the answer arrived only with ~1,400 reasoning tokens | Use `max_tokens` ≈ 4,000 for extraction and 1,500 for short copy |
| Wraps JSON in code fences, with no guaranteed structured output | Replies arrive as ```` ```json … ``` ```` | Parse the first `{…}` block and validate with Pydantic; one retry, then reject |
| Extraction accuracy is good on clean pages | Notion Free $0 / Plus $10 / Business $20 / Enterprise custom; Linear Free $0 / Basic $10 / Business $16 / Enterprise custom, all matching the page | Suitable for numeric extraction |
| Doesn't make up prices when there are none | Jira: returned plan names with `null` prices | Good. Treat as `partial` |
| **Unstable labels between runs** | Same page: "Plus" on one run, "Plus\*" the next | Normalize names (`[^a-z0-9 ]` stripped), and confirm twice before applying (DECISIONS D2, D3) |
| Latency | ~5 s per page at low reasoning effort | Fine per cycle; skip unchanged pages anyway |
| Free-tier quota (unverified) | OpenRouter documents low daily caps on free models for accounts without purchased credit | Section-hash gating matters. Measure calls per cycle in `RunRecord.liquid_calls` |

## RawTree (event store)

| Finding | Evidence | Consequence |
|---|---|---|
| **One database shared by all hackathon teams** | 34 foreign tables in `GET /v1/tables` (`aura_*`, `beluga_*`, `horizon_*` …) | Prefix every table `slop_human` (DECISIONS D5). Store only public data; anyone at the event can read it |
| Tables are created by the first insert; no schema up front | `POST /v1/tables/{name}` creates it; every column type is `Dynamic`. Explicit `POST /v1/tables` returns 403 "requires admin permission" with our key | The schema lives in `contracts/`, not in the DB. An empty table has no columns |
| **`IN` / `NOT IN` / `=` on a column fail unless you wrap it in `toString()`** | `run_id NOT IN (...)` → "Illegal type Dynamic of argument of function notIn" | Every filter: `toString(col) IN (...)`, `toString(col) = '...'`. Applies to all our tables |
| Nested objects become dotted columns | `section_hashes: {pricing: …}` → column `section_hashes.pricing` | Query with backticks: `` `section_hashes.pricing` `` |
| `fetched_at` stored as a timestamp with nanoseconds | Returned as `2026-09-25 19:46:50.861059000` | Cursor on `toString(fetched_at)` |
| A new table is queryable only after ~3 s | Immediate query → `UNKNOWN_IDENTIFIER`; worked 3 s later | Retry reads on a new table |
| **Delete needs admin; our key isn't admin** | `DELETE /v1/tables/{table}` exists in the API reference but requires admin; there's no row-level delete | Our rows are effectively permanent. Tag test rows and filter them out. Upside: teams sharing the non-admin key can't delete our tables |
| Fast | insert 0.4–0.8 s; query 0.1–0.2 s | Not a bottleneck |
| Useful endpoints | `GET /v1/tables/{name}` returns columns and row count; `POST /v1/query {"sql": …}` returns rows | See `show_columns.py` |

## Black Forest Labs

Not tested yet. Open: whether sponsor access includes video (PRD §31 Q2). The storyboard contract assumes still frames plus motion and overlay, so it works either way.

## Pipeline, end to end

Tested with a planted change (Notion Plus $10 → $8 in two fetches):

- Fetch 1 with the new value: held as pending, no change emitted.
- Fetch 2: `replace` emitted, importance 0.9, citing both `obs_id`s. Liquid wrote the headline and a voiceover line ("Notion Plus now costs eight dollars per month.", 8 words).
- State size after 8 fetches of 3 competitors: ~930 tokens.
- The storyboard generated from it passed the duration and word-count checks.
