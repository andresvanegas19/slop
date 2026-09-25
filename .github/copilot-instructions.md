# Copilot instructions

## Working directory and commands

The Next.js application is in `generation-video/`; run application commands from
that directory.

```bash
npm run dev       # local development server
npm run lint      # lint the whole application
npm run build     # production build and TypeScript validation
npm run start     # serve a completed production build
```

There is no automated test runner or test script configured. For a focused static
check, run ESLint against the changed file, for example:

```bash
npx eslint src/lib/storyboard.ts
```

Generation requires Node.js 20+, `ffmpeg` on `PATH`, and server-side credentials
in the repository-root `.env` (one level above `generation-video/`). Copy
`.env.example` to `.env`; never commit it or expose `BFL_API_KEY` or
`RAWTREE_API_KEY` to client code. `next.config.ts` and the server integrations load
the parent environment explicitly.

## Architecture

- `src/app/page.tsx` is the single client-side prompt UI. It submits image, short
  video, multi-shot, and storyboard requests directly to App Router API routes and
  displays locally served generated assets.
- BFL work is server-only. `src/lib/bfl.ts` validates the configured BFL endpoint,
  submits asynchronous image jobs, polls them, and returns short-lived provider
  result URLs. Routes and renderers must download results into `output/frames/`
  before returning browser-facing URLs.
- `src/app/api/generate*/route.ts` provides the image, short-clip, and three-shot
  continuity flows. The multi-shot route passes the previous image as BFL
  `input_image`; preserve that handoff when changing continuity behavior.
- Prompt clips use FLUX 3 video (`generateBflVideo()` → `/v1/flux-3-video`) via
  `src/lib/clip.ts`: `t2v` for new prompts, `i2v` with the key frame for editor
  re-renders. FLUX 3 only accepts 5–20 s, so it requests a 5 s `draft` and FFmpeg
  keeps the first `CLIP_SECONDS` (3 s). Its first frame becomes the project frame.
  A 403/404 from the video endpoint falls back to the still-image zoom clip.
  Before that, `writeVideoPrompt()` in `src/lib/video-prompt.ts` asks the
  OpenRouter model (`OPENROUTER_MODEL`) to expand the idea into a FLUX 3 prompt
  (style → action → camera/light → `Audio:` → no text). It is capped at 20 s and
  never throws; on failure the user's prompt is used unchanged.
- Storyboard rendering flows through `validateStoryboard()` in
  `src/lib/storyboard.ts`, then `POST /api/render-storyboard`, then
  `src/lib/storyboard-renderer.ts`. The validator accepts both the internal typed
  contract and the supplied snake_case storyboard format, normalizing the latter
  before strict validation. The renderer creates BFL frames, applies motion and
  overlays, synthesizes narration where supported, and muxes the final MP4.
- `src/lib/rawtree.ts` is the only RawTree access layer. Its routes expose
  connection status, metadata, and bounded storyboard data. It deliberately
  constructs an allowlisted `SELECT … LIMIT …` query from confirmed metadata;
  do not add arbitrary SQL input.
- Generated frames, manifests, audio, text overlays, and MP4s stay under
  `generation-video/output/` and are ignored by Git. Serve assets through the
  existing `/api/assets/[filename]` and `/api/videos/[filename]` routes rather
  than filesystem paths. Storyboards saved by `/api/slop-video` and
  `/api/generate-preset` go to `generation-video/storyboards/generated/`, which
  is also ignored by Git.
- The company agent is the Python package `agent/` at the repository root
  (`.venv/bin/python -m agent worker`). It is a LangChain text-ReAct agent:
  Liquid via OpenRouter is the LLM, and its tools (`agent/tools.py`) read
  `contracts/` models from RawTree `slop_human*` tables and core's `state.db`
  with code-built, bounded SQL. It serves `POST http://127.0.0.1:8765/context`;
  `src/lib/company-agent.ts` calls it from every generation route and never
  throws. Only the distilled `CompanyContext` brief reaches Next/BFL prompts.
  See `agent/README.md`.
- Content strategy (audience-first hooks in the first 0.6–2 s, a value shift per
  scene, the 5-7-10 angle/format matrix, the growth/connection/sale funnel) lives
  in `src/lib/content-playbook.ts`: `scriptPlaybook(planContent())` is in the
  preset script prompt (with a planning-only `SHIFT:` line per scene) and
  `shotPlaybook()` in the cinematic shot prompt. `agent/playbook.py` mirrors it
  for `agent/storyline.py`, and `knowledge/content-strategy.md` holds the
  long-form notes for RAG; update all three together. The Copilot custom agent
  `.github/agents/content-strategist.agent.md` applies the same techniques.

## Repository-specific conventions

- Keep API keys and raw business data out of responses, client components, prompts,
  manifests, and logs. Use `runtime-log.ts` for structured, non-sensitive server
  events.
- BFL endpoint configuration may be blank in `.env`; treat blank values as the
  default endpoint, not as a configured URL. Provider errors should remain
  actionable without logging credentials or complete submitted prompts.
- Validate untrusted storyboard JSON with `validateStoryboard()` before using it.
  Rendering requires contiguous scenes beginning at zero, a bounded duration and
  scene count, and no `narrationWarnings`; return validation issues rather than
  silently changing or rendering an invalid storyboard.
- The canonical storyboard uses camelCase fields and milliseconds. The external
  format uses fields such as `storyboard_id`, `start_sec`, `duration_sec`,
  `image_prompt`, `on_screen_text`, and `change_ids`; update the normalizer and
  typed contract together when supporting new fields.
- FFmpeg produces 1920×1080 H.264 MP4 output at 30 fps. This macOS environment's
  FFmpeg lacks `drawtext`, so the renderer uses `render-overlay.swift` with AppKit
  for text overlays on macOS. Preserve a viable overlay path when changing render
  filters, and keep `say` narration optional.
- Fine-tune registration is intentionally local metadata validation only; it does
  not train, upload, or activate a LoRA. Do not represent it as a provider-backed
  fine-tuning flow without verified BFL support.
