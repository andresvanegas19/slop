# Longform Studio

Local production UI for planning a long-form AI video as a coherent series of shots. It models the recommended workflow: master document, shot continuity sheet, budget, per-shot review, live production progress, and final export.

## Run locally

```bash
npm install
cp ../.env.example ../.env
npm run dev
```

Open `http://localhost:3000`.

The UI includes a local interactive planning flow and a server-side BFL image-generation action for an individual shot. It submits to BFL, polls the returned job URL, downloads the short-lived result to `output/frames/`, and returns a local asset route. A configured API key is never read by the browser or written to project data.

The production-run panel is intentionally a UI workflow simulation while the persistent SQLite queue and FFmpeg segment assembler are built. It demonstrates the events, pause/review points and per-shot control needed for a production run without submitting every planned shot automatically.

## Continuity model

Each shot should have exactly one primary action and retain the master document's character, location, lighting, visual-style and camera-language constraints. The continuity panel represents the three anchors passed to each next generation:

1. Locked character and location reference images.
2. The final approved frame from the previous shot.
3. A prompt describing the continuation and the intended next camera angle.

This prevents an unstructured, multi-beat prompt from becoming a sequence of disconnected scenes. The full queue will use the final generated frame as an `input_image` reference for the next BFL job when the persistent asset pipeline is added.

## Requirements for generation

- Node.js 20+
- FFmpeg on the system `PATH`
- A BFL API key in `BFL_API_KEY`, stored only in the repository-root `.env`

Never commit `.env` or include API keys in shot prompts, logs, or exported manifests.

## RawTree storyboard data source

RawTree is an optional server-only, read-only source for grounding storyboard work.
Set `RAWTREE_API_KEY` in the repository-root `.env`; optionally set `RAWTREE_TABLE`
to restrict the integration to a single simple table identifier. Do not put either
value in browser environment variables or commit a real key.

- `GET /api/rawtree/status` returns only connection state and a safe error code.
- `GET /api/rawtree/metadata?table=<name>` lists approved tables and gets the
  selected table's selectable columns.
- `POST /api/rawtree/query` accepts only `{ table?, columns?, limit? }` and returns
  at most 100 rows for storyboard consumers. It rejects `sql` and never accepts
  arbitrary SQL; the server creates a `SELECT ... LIMIT ...` query solely from
  tables and columns confirmed by RawTree metadata.

Without `RAWTREE_API_KEY`, the status endpoint returns `connected: false` with
`not_configured`, and metadata/query endpoints return a configuration error. No
live RawTree connection is attempted or claimed in that state.

## Generated files

All generated artifacts are kept under `output/`:

- `output/frames/` contains BFL image results.
- `output/manifests/` is reserved for reproducible project and run manifests.
- `output/videos/` is reserved for rendered MP4 exports.

Generated content is ignored by Git; the directory layout is retained with `.gitignore` placeholders.

## Storyboard contract

`src/lib/storyboard.ts` defines the dependency-free, strongly typed JSON contract for
storyboards. Use `validateStoryboard(unknownValue)` before consuming external input;
it returns either typed `Storyboard` data or safe path/code/message validation issues
without reflecting submitted values. The tracked `storyboards/mock_changes.json`
fixture is a project-management SaaS update example covering styles, timed scenes,
motion, transitions, on-screen text, narration warnings, and evidence IDs.

## Storyboard rendering

`POST /api/render-storyboard` accepts a JSON storyboard that passes the contract
validator and renders it server-side. It generates one BFL image for each scene,
applies motion and text overlays with FFmpeg, synthesizes local narration with macOS
`say` when available, and writes the input, a safe run manifest, and all artifacts
under `output/`. The endpoint returns a local MP4 URL and non-sensitive run metadata.
It returns `422` without rendering when narration warnings need review.

## Fine-tuning LoRA (planned mock workflow)

The studio will include an **Add Finetune** flow for registering a local `.safetensors` LoRA checkpoint with a name, a base-model placeholder, FP8 precision, and an optional trigger phrase. The initial workflow only validates and records local metadata; it does not train, upload, or activate a model.

### TODO before enabling a production fine-tune

- Confirm BFL's authenticated checkpoint-upload and fine-tune-status API.
- Replace placeholder base models with provider-verified model IDs and verify FP8 support.
- Verify how the provider applies the trigger phrase and returns a remote finetune ID.
- Add durable storage, ownership/quota controls, malware scanning, content policy validation, and retention/deletion controls for uploaded checkpoints.
