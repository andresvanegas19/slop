# Storyboard format (for the video layer)

You get one `storyboard.json` per agent cycle. Render it into a video of `total_duration_sec` seconds.

## Per scene

| Field | What to do with it |
|---|---|
| `start_sec`, `duration_sec` | Timeline position. Scenes are back to back. |
| `image_prompt` | Send to Black Forest Labs (FLUX) as is. The shared style prefix is already included. Use `style.seed` and `style.aspect_ratio` for every frame so the video looks consistent. |
| `on_screen_text` | **Overlay this yourself** (ffmpeg drawtext, Remotion, etc.). Don't ask FLUX to draw text or numbers; it gets them wrong. |
| `narration` | Voiceover line for this scene. Already sized to fit (about 2.5 words per second). |
| `motion` | Ken Burns effect on the still image: `slow push in`, `slow zoom out` or `static`. |
| `transition_out` | Transition into the next scene. |
| `change_ids` | Links to `evidence_index`, which lists the raw observation IDs in the database. Optional: show a tiny "source" footer. |

## Scene types

`title` → 5 × `change` (top moves, ranked by importance) → `quiet` (everyone who didn't change) → `outro` (biggest opening).

## Top-level fields

- `voiceover_full`: the whole script in one string, handy for a single text-to-speech call.
- `narration_warnings`: should be empty. If it isn't, tell the state/Liquid owner, since a line is too long for its scene.

## Minimal render loop

1. For each scene, generate an image from `image_prompt` (with the same seed each time).
2. Generate `voiceover_full` as one audio file (or one clip per scene).
3. Build the video: image + motion for `duration_sec` + `on_screen_text` overlay, then crossfade between scenes.
4. Lay the audio over it and export as 1920×1080 MP4.

Test input: `mock_changes.json` (fictional). Regenerate with `python3 make_storyboard.py`.
