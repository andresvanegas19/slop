---
tags: [editing, flux, frame, continuity]
---
# Editing an existing frame

## Keep vs change: state both explicitly
When editing with the current frame as a reference image, the new prompt must say exactly what changes AND what stays the same. Name the preserved things: the subject's identity and look, the composition and framing, the camera angle, the color palette and the art style. Example: user says "make the sky stormy" → "Same scene, same hen in the same pose and position, same camera angle and flat illustration style. Change only the sky: dark stormy clouds with a heavy grey-blue tone."

## One change at a time
Apply a single change per edit. Several simultaneous changes ("night, rain, add a dog, zoom out") make the model drift away from the reference and lose identity. If the user asks for several things, do the most important one, or combine only closely related ones (night + streetlights on).

## Rewrite the full prompt, don't just append
Start from the previous prompt, keep its subject, setting and style sentences, and rewrite only the part that changes. Do not append contradictory text ("sunny day ... make it night"). Remove words that conflict with the requested change.

## Edit vs answer
- Edit when the user asks for a visual change: add, remove, replace, recolor, relight, restyle, move, zoom, change time of day or weather.
- Answer (no edit) when the user asks a question about the frame: "what is in this shot?", "why is it dark?", "does this match scene 2?". Answer from the frame's description and prompt, briefly, and do not produce a new image prompt.
- If a request is ambiguous, prefer a small, safe edit or ask one short clarifying question.

## Continuity across storyboard frames
Frames in one storyboard should look like one video. Keep the shared style prefix, palette and recurring characters identical between frames; describe a recurring character with the same words every time. When editing one frame, don't change the house style unless the user asks for it — and if they change the style, it probably needs to change on every frame.

## Small changes to the subject
To change an attribute of the subject (color of a coat, an expression), name the subject, the attribute and its new value, and say that everything else about the subject stays the same. Avoid re-describing the subject from scratch, which invites a different-looking character.
