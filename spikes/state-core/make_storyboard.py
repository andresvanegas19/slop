"""Turn one cycle of state changes into a 30s storyboard for the video layer (Black Forest Labs).

Usage: python3 make_storyboard.py [changes.json] [storyboard.json]

Selection is the point: 30 competitors in, only the top few moves on screen.
Narration comes from each change's `spoken` line (<=10 words, written by Liquid in the real pipeline).
"""
import json
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else "mock_changes.json"
OUT = sys.argv[2] if len(sys.argv) > 2 else "storyboard.json"

TOP_N = 5
SCENE_SEC = 4
WORDS_PER_SEC = 2.5  # comfortable voiceover pace (~150 wpm)

STYLE = {
    # Prepend to every image prompt so frames look like one video.
    "prompt_prefix": "Flat isometric editorial illustration, clean vector shapes, deep navy background, "
                     "teal and coral accents, soft studio lighting, generous negative space, "
                     "NO text, NO letters, NO numbers, NO logos.",
    "palette": ["#0B1B3A", "#14B8A6", "#F97360", "#F8FAFC"],
    "seed": 42,
    "aspect_ratio": "16:9",
    "resolution": "1920x1080",
}

# One visual metaphor per change category. Images never carry text or numbers;
# those are overlaid in editing so they can't be hallucinated.
IMAGE_BY_CATEGORY = {
    "price_cut": "a large price tag sliced cleanly in half by a glowing blade, small coins tumbling out",
    "price_increase": "a price tag inflating like a balloon and drifting upward",
    "new_plan": "a staircase of glowing product tiers with a brand-new step appearing, spotlight on it",
    "deprecation": "a bright doorway closing, small figures holding laptops left standing outside",
    "hiring_signal": "a stylized map of Europe with glowing pins on three cities, tiny figures walking toward them",
    "feature_launch": "a small rocket launching out of a laptop screen that shows abstract timeline bars",
    "review_sentiment": "a row of five stars where the last one cracks and dims, a few frowning speech bubbles",
    "pricing_model": "a row of identical chairs dissolving into a flowing meter gauge",
    "exec_hire": "a single chess king placed onto a board under dramatic top light",
    "integration": "two puzzle pieces clicking together, soft glow at the seam",
    "retraction": "a magnifying glass over a document with one line being erased",
    "minor": "a small gear turning quietly",
}


def scene(n, start, dur, kind, narration, on_screen, image, change_ids=(), motion="slow push in"):
    return {
        "scene": n,
        "start_sec": start,
        "duration_sec": dur,
        "type": kind,
        "narration": narration,
        "on_screen_text": on_screen,
        "image_prompt": STYLE["prompt_prefix"] + " " + image,
        "motion": motion,
        "transition_out": "crossfade_0.3s",
        "change_ids": list(change_ids),
    }


def main():
    cyc = json.load(open(SRC))
    stats = cyc["stats"]
    changes = [c for c in cyc["changes"] if c["category"] != "retraction"]
    if not changes:
        print("No changes this cycle, so no storyboard.")
        return
    changes.sort(key=lambda c: c["importance"], reverse=True)
    top = changes[:TOP_N]
    n_comp = stats["competitors_tracked"]
    n_changed = len({c["competitor"] for c in cyc["changes"]})
    n_quiet = n_comp - n_changed

    scenes, t = [], 0
    scenes.append(scene(1, t, 3, "title",
                        "{} competitors. {} {} that matter{}.".format(n_comp, len(top), "move" if len(top) == 1 else "moves", "s" if len(top) == 1 else ""),
                        {"headline": "{}: This Week".format(cyc["market"]),
                         "sub": "{} competitors · {} key move{}".format(n_comp, len(top), "" if len(top) == 1 else "s")},
                        "a wide constellation of {} small glowing nodes, {} of them brighter than the rest".format(n_comp, len(top)),
                        motion="slow zoom out"))
    t += 3

    for i, c in enumerate(top):
        scenes.append(scene(len(scenes) + 1, t, SCENE_SEC, "change", c["spoken"],
                            {"headline": c["headline"], "competitor": c["competitor"], "rank": i + 1},
                            IMAGE_BY_CATEGORY.get(c["category"], IMAGE_BY_CATEGORY["minor"]),
                            change_ids=[c["change_id"]]))
        t += SCENE_SEC

    scenes.append(scene(len(scenes) + 1, t, 3, "quiet",
                        "{} others: no real change.".format(n_quiet),
                        {"headline": "{} competitors: no real change".format(n_quiet),
                         "sub": "{} noisy scrapes discarded".format(stats["observations_discarded_as_noise"])},
                        "a calm sea of dim nodes, gentle ripples fading out",
                        motion="static"))
    t += 3

    opp = next((c for c in changes if c.get("opportunity")), None)
    label = "Biggest opening" if opp else "Biggest threat"
    opp = opp or top[0]
    scenes.append(scene(len(scenes) + 1, t, 4, "outro",
                        label + ": " + opp["spoken"],
                        {"headline": label, "sub": opp["headline"]},
                        "a bright open path leading forward through a field of dim nodes",
                        change_ids=[opp["change_id"]], motion="slow push in"))
    t += 4

    # Voiceover must fit its scene, or the video drifts out of sync.
    warnings = []
    for s in scenes:
        words = len(s["narration"].split())
        if words > s["duration_sec"] * WORDS_PER_SEC:
            warnings.append("scene {}: {} words for {}s (max ~{})".format(
                s["scene"], words, s["duration_sec"], int(s["duration_sec"] * WORDS_PER_SEC)))

    board = {
        "storyboard_id": "sb_" + cyc["cycle_id"][4:],
        "source_cycle_id": cyc["cycle_id"],
        "title": cyc["market"] + ": This Week",
        "total_duration_sec": t,
        "style": STYLE,
        "scenes": scenes,
        "voiceover_full": " ".join(s["narration"] for s in scenes),
        "evidence_index": {c["change_id"]: c["evidence"] for c in cyc["changes"]},
        "narration_warnings": warnings,
    }
    json.dump(board, open(OUT, "w"), indent=2)
    print("wrote {}: {} scenes, {}s, {} of {} changes on screen".format(
        OUT, len(scenes), t, len(top), len(cyc["changes"])))
    for w in warnings:
        print("  narration too long ->", w)


if __name__ == "__main__":
    main()
