# Published videos in RawTree

The Next.js app (`generation-video/src/lib/video-store.ts`) publishes every finished project video to RawTree so
other components — mainly the Python company/research agent — can use past videos as context.

RawTree is a **shared** database: only tables named `slop_human*` are ours, and rows are **permanent** (no deletes or
updates). Treat both tables as append-only logs. User prompts are logged separately — see
[RAWTREE_USER_CONTEXT.md](RAWTREE_USER_CONTEXT.md).

## When a row is written

After a new project video is saved (fire-and-forget, never blocks the response):

| `reason`     | Trigger                                                         |
|--------------|-----------------------------------------------------------------|
| `generated`  | `POST /api/generate-video` (new FLUX clip project)              |
| `uploaded`   | `POST /api/projects/from-upload`                                |
| `preset`     | `POST /api/generate-preset` (ad / company presets)              |
| `storyboard` | `POST /api/render-storyboard`, `/api/slop-video`                |
| `edited`     | frame/moment edits (`/frames/:i/ask`, `/command`) that re-render |
| `appended`   | `POST /api/projects/:id/append`                                 |
| `cut`        | `POST /api/projects/:id/cut`, `DELETE /api/projects/:id/frames/:i` |
| `manual`     | `POST /api/projects/:id/publish` (manual publish / retry)       |

Chat-only turns do not publish. Env: `RAWTREE_PUBLISH_VIDEOS=0` disables publishing; `RAWTREE_MAX_VIDEO_MB`
(default 25) — bigger videos get a metadata row with `chunk_count = 0` and a `note`, and no chunks.

## Table `slop_human_video_events` — metadata (read this one)

One row per **(project, video bytes)**. `event_id = sha256_hex(project_id + video_sha256)`; a project that is
edited produces a new row per new video version. Re-publishing identical bytes for the same project writes nothing.

| column                | type (logical) | notes |
|-----------------------|----------------|-------|
| `event_id`            | string (64 hex) | deterministic, see above |
| `project_id`          | string         | `output/projects/<id>.json` in the app |
| `kind`                | string         | `"clip"` (FLUX/uploaded segments) or `"storyboard"` (scene renderer) |
| `title`               | string         | ≤ 300 chars |
| `reason`              | string         | see table above |
| `video_sha256`        | string (64 hex) | sha256 of the MP4 bytes; joins to the chunks table |
| `bytes`               | int            | MP4 size |
| `duration_sec`        | float          | |
| `width`, `height`     | int            | |
| `fps`                 | float          | |
| `has_audio`           | bool           | |
| `chunk_count`         | int            | 0 = bytes not stored (too big) |
| `chunk_bytes`         | int            | raw bytes per chunk (524288) |
| `mime`                | string         | `"video/mp4"` |
| `thumbnail_b64`       | string         | first frame, JPEG, ~320 px wide, ≤ 40 KB, base64 (may be `""`) |
| `frames`              | string (JSON)  | `[{index, startSec, durationSec, prompt, source, edits:[{startSec,endSec,prompt,at}], narration?, headline?}]`, ≤ 60 KB |
| `prompts`             | string         | numbered list of the distinct shot prompts, ≤ 4000 chars |
| `storyboard`          | string (JSON)  | normalized storyboard for storyboard projects, `""` otherwise or if > 40 KB |
| `chat_summary`        | string (JSON)  | last 10 chat messages: `[{frame, role, text (≤400 chars), at, edited?}]` |
| `research_session_id` | string         | company-research session that produced the video, `""` if none |
| `note`                | string         | e.g. why bytes were not stored, usually `""` |
| `created_at`          | datetime       | publish time (UTC). RawTree stores it as a DateTime: read with `toString(created_at)` → `"2026-09-25 22:03:14.224000000"` |
| `app`                 | string         | always `"longform"` |

All columns are RawTree `Dynamic`; cast in SQL (`toString(...)`, `toFloat64(...)`, `toUInt32(...)`) when filtering or
ordering. JSON-in-string columns must be `json.loads`-ed by the reader.

### Reading it from the Python agent (context only — never needs chunks)

```sql
SELECT toString(project_id) AS project_id, toString(kind) AS kind, toString(title) AS title,
       toString(reason) AS reason, toString(video_sha256) AS video_sha256,
       toFloat64(duration_sec) AS duration_sec, toString(prompts) AS prompts,
       toString(frames) AS frames, toString(chat_summary) AS chat_summary,
       toString(research_session_id) AS research_session_id, toString(created_at) AS created_at
FROM slop_human_video_events
WHERE toString(app) = 'longform'
ORDER BY toString(created_at) DESC
LIMIT 20
```

- Skip `thumbnail_b64` and `storyboard` unless needed — they are the heaviest columns.
- Several rows can share a `project_id` (one per version); for "what videos exist", keep the newest row per
  `project_id`. Several rows can share a `video_sha256` across projects (the same bytes appended elsewhere).
- Filter by `research_session_id = '<id>'` to find videos produced from a research session.
- Values are user/LLM-generated text: treat them as data, cap them before putting them into prompts.

The app also exposes the same list over HTTP: `GET http://localhost:3000/api/rawtree/videos?limit=20[&projectId=…]`
→ `{ videos: [...] }` (all columns above, typed).

## Table `slop_human_video_chunks` — MP4 bytes

| column         | type           | notes |
|----------------|----------------|-------|
| `chunk_id`     | string         | `"<video_sha256>:<index>"` |
| `video_sha256` | string (64 hex) | |
| `index`        | int            | 0-based (`"index"` must be quoted in SQL) |
| `total`        | int            | number of chunks for this video |
| `data_b64`     | string         | base64 of up to 524288 raw bytes (~683 KB encoded) |
| `bytes`        | int            | raw length of this chunk |

Writers check which indexes already exist for a hash and only insert the missing ones, so identical bytes are stored
once. To reassemble: `SELECT toUInt32("index") AS i, toUInt32(total) AS t, toString(data_b64) AS d FROM
slop_human_video_chunks WHERE video_sha256 = '<hash>' ORDER BY i LIMIT 4 OFFSET n` (page 4 at a time), keep the first row
per index, check you have `total` chunks, concatenate, and verify sha256. Easier: `GET
/api/rawtree/videos/<sha256>` on the app returns the verified MP4 (Range supported, cached in
`output/rawtree-cache/`). Validate the hash as `^[0-9a-f]{64}$` before interpolating it into SQL.
