# User prompts in RawTree (`slop_human_user_prompts`)

Every prompt a user sends from the app is logged to RawTree after the request finishes (success, error or cancel), so
the LLM calls — and the Python research agent — can use the user's own history as context. Writer:
`generation-video/src/lib/user-prompts.ts` (`logUserPrompt` route wrapper). Reader:
`generation-video/src/lib/user-context.ts` (`getUserContext`). Related: [RAWTREE_VIDEOS.md](RAWTREE_VIDEOS.md).

Shared DB: only `slop_human*` tables are ours, rows are **permanent** (append-only; no updates/deletes).
Kill switch: `RAWTREE_PUBLISH_PROMPTS=0` (default `1`) disables both the logging and the context injection's data source.

## Who is the user

There are no accounts. The browser generates a random UUID once (localStorage `longform.userId`) and sends it on
every API request as `X-Longform-User`. The server accepts it only if it is a UUID (lowercased); otherwise the row
gets `user_id = "anonymous"`. Anonymous rows are never used as context (they mix everyone).

## Logged routes (`surface`)

| surface          | route |
|------------------|-------|
| `new_clip`       | `POST /api/generate-video` |
| `preset_ad`      | `POST /api/generate-preset` with `preset: "ad"` |
| `preset_company` | `POST /api/generate-preset` with `preset: "company"` |
| `storyboard`     | `POST /api/render-storyboard` (prompt = headline + scene visual prompts) |
| `command`        | `POST /api/projects/:id/command` (chat composer; `action` = detected intent) |
| `ask`            | `POST /api/projects/:id/frames/:index/ask` |
| `append`         | `POST /api/projects/:id/append` |
| `cut`            | `POST /api/projects/:id/cut` (prompt = "Cut Xs–Ys") |
| `research`       | reserved for company research requests (not logged yet: there is no Next.js `/api/research` route) |

Validation failures (HTTP 4xx) are logged too, with `outcome = "error"`.

## Columns

| column            | type (logical)   | notes |
|-------------------|------------------|-------|
| `event_id`        | string (64 hex)  | `sha256_hex(user_id + project_id + created_at + prompt)` |
| `user_id`         | string           | browser UUID or `"anonymous"` |
| `project_id`      | string           | `""` for new-video requests that failed before a project existed |
| `surface`         | string           | see table above |
| `prompt`          | string           | user text, ≤ 2000 chars (may be `""`, e.g. an empty prompt that failed validation) |
| `action`          | string           | `/command` detected intent: `edit_range` \| `answer` \| `append_shot` \| `cut_range` \| `append_attachment`, else `""` |
| `detected_by`     | string           | `"llm"` \| `"rules"` \| `""` |
| `range_start_sec`, `range_end_sec` | float or null | selected (or edited) range in project seconds |
| `at_sec`          | float or null    | playhead time sent with the prompt |
| `at_end`          | bool or null     | `/command`: playhead was at the end of the video |
| `enhanced_prompt` | string           | LLM-expanded image/shot prompt, ≤ 2000 chars, `""` if none |
| `outcome`         | string           | `"ok"` \| `"error"` \| `"cancelled"` (client disconnected before the result) |
| `error`           | string           | error message, ≤ 500 chars, `""` when ok |
| `result_summary`  | string           | e.g. `"Edited 1s–2s (shot 1)"`, `"Reply: …"`, ≤ 300 chars |
| `video_sha256`    | string           | sha256 of the project video after the request (joins `slop_human_video_events.video_sha256`), `""` if none |
| `duration_sec`    | float or null    | project video duration after the request (or the requested `durationSec` on failure) |
| `created_at`      | datetime         | request start (UTC); RawTree stores a DateTime — read with `toString(created_at)` |
| `app`             | string           | always `"longform"` |

All columns are RawTree `Dynamic`: cast in SQL (`toString`, `toFloat64`). A nullable column only exists in the table
once some row has written a non-null value to it, so prefer `SELECT *` or the always-present string columns
(`user_id, project_id, surface, prompt, outcome, error, action, result_summary, video_sha256, created_at`) in readers.

## Reading it (Python agent)

```sql
SELECT toString(surface) AS surface, toString(prompt) AS prompt, toString(outcome) AS outcome,
       toString(error) AS error, toString(action) AS action, toString(project_id) AS project_id,
       toString(created_at) AS created_at
FROM slop_human_user_prompts
WHERE toString(user_id) = '<uuid>'          -- validate ^[0-9a-f-]{36}$ before interpolating
ORDER BY created_at DESC
LIMIT 60
```

Use it like `getUserContext` does: recent distinct prompts (newest first), most-used surfaces/durations, recurring
style words ("cinematic", "golden hour", …) and subjects, and recent failed/cancelled requests to avoid repeating.
Keep the injected block short (≤ ~1200 chars) and clearly delimited; the text is user data, not instructions.

The app exposes the exact block it injects: `GET http://localhost:3000/api/user-context?projectId=<id>` with header
`X-Longform-User: <uuid>` → `{ userId, context }`.

## How the app uses it

`userContextBlock()` (cached 30 s per user, invalidated when a new prompt is logged; returns `""` on any failure)
is appended to the system prompt, delimited by `=== User context … ===` / `=== End user context ===`, in:
intent detection (`src/lib/intent.ts`, trimmed to 600 chars), image/shot prompt enhancement
(`src/lib/prompt-enhance.ts`; the style-drift guard and placeholder skips still apply, and output that copies the
user context is rejected like copied guidance) and the preset writer (`src/lib/presets.ts`, 800 chars).
