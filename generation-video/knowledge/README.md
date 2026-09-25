# Studio knowledge base

These Markdown files are retrieved (BM25 keyword search, `src/lib/rag.ts`) and pasted as short "Guidance" into the LLM's system prompt before frame/clip edits.

## Adding knowledge
- Drop a new `.md` file anywhere under `knowledge/`. It is picked up automatically (no restart needed).
- Split it into `##` sections. Each section is one retrievable chunk, so give it a descriptive heading and keep it short (a few sentences) and self-contained.
- Optional front matter at the top of the file adds tags that get a small ranking boost when a caller filters by tag:

```
---
tags: [editing, flux]
---
```

## Learned examples
Successful edits are appended automatically to `output/knowledge/edits.jsonl` and retrieved as examples (latest 500 kept in the index). Delete lines there to forget bad examples.

## Debugging
`GET /api/rag?q=make the sky stormy&k=4` returns the guidance text and the matched sources with scores.
