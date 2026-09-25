---
tags: [flux, prompting, image]
---
# Writing image prompts for FLUX

## Write natural-language descriptions
FLUX models read prompts as plain descriptive sentences, not comma-separated keyword lists or weighted tags like `(word:1.3)`. Describe the image the way you would brief an illustrator: full phrases, concrete nouns, visible details. Tag soup ("masterpiece, best quality, 8k, trending") adds noise and rarely helps.

## Prompt order: subject first
Lead with what matters most, because early words carry the most weight:
1. Subject — who or what, with its key visible traits (a red hen with speckled feathers).
2. Action or pose — what it is doing.
3. Setting — where, and what is around it.
4. Lighting — time of day, light direction and quality (low golden backlight, overcast soft light).
5. Camera / lens — shot size and angle (wide shot, close-up, low angle, 35mm, shallow depth of field).
6. Composition — placement and framing (subject on the left third, lots of negative space above).
7. Style — medium or look (flat vector illustration, 35mm film photo, watercolor).
8. Mood — one or two words (calm, tense, playful).

## Be concrete and visual
Only describe things a camera could see. Replace abstract words with visual evidence: instead of "the company is growing", write "a small green sprout pushing up through cracked pavement". Name colors, materials, sizes and counts ("three glass jars", not "some jars").

## No negative prompts — say what you want
FLUX does not take a negative prompt. Writing "no blur" or "without people" can even pull the unwanted concept in. Phrase the positive instead: "sharp focus", "an empty street". The exception is a short, firm house-style rule that is known to work in this studio (for example "NO text, NO letters"), placed once, not repeated.

## Avoid text unless it is required
FLUX can render short text, but any lettering in a frame competes with overlays and often comes out misspelled. If text is not needed, don't mention words, signs, labels, screens with writing or logos. If it is needed, keep it to a few words in quotes: a neon sign reading "OPEN".

## Keep prompts focused (~40–120 words)
One scene, one subject, one idea. Around 40–120 words is usually enough; very long prompts dilute attention and cause details to be dropped or merged. If two elements keep blending, simplify the scene instead of adding more adjectives.
