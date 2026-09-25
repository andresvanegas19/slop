"""MeaningfulnessGate + StoryboardComposer: accepted ops -> contract-valid Storyboard with Claims (PRD 15, 16).

Every change scene cites a Claim, and every Claim points at a belief, a patch and evidence.
Liquid may phrase the voiceover; facts, numbers and claims come from the patch, never from the model.
"""
import hashlib
from typing import Dict, List, Optional, Tuple

from contracts import SCHEMA_VERSION, Claim, OpType, Patch, PatchOp, Scene, Storyboard, StyleGuide

MIN_SIGNIFICANCE = 0.6
TOP_N = 5
WORDS_PER_SEC = 2.5

STYLE = StyleGuide(
    prompt_prefix="Flat isometric editorial illustration, clean vector shapes, deep navy background, "
                  "teal and coral accents, soft studio lighting, generous negative space, "
                  "NO text, NO letters, NO numbers, NO logos.",
    palette=["#0B1B3A", "#14B8A6", "#F97360", "#F8FAFC"], seed=42)

IMAGE_BY_CATEGORY = {
    "price_cut": "a large price tag sliced cleanly in half by a glowing blade, small coins tumbling out",
    "price_increase": "a price tag inflating like a balloon and drifting upward",
    "pricing_model": "a row of identical chairs dissolving into a flowing meter gauge",
    "new_plan": "a staircase of glowing product tiers with a brand-new step appearing, spotlight on it",
    "deprecation": "a bright doorway closing, small figures holding laptops left standing outside",
}


def is_meaningful(op: PatchOp) -> bool:
    return op.op in (OpType.add, OpType.replace, OpType.retract) and op.significance >= MIN_SIGNIFICANCE


def category(op: PatchOp) -> str:
    if op.op == OpType.add:
        return "new_plan"
    if op.op == OpType.retract:
        return "deprecation"
    if isinstance(op.before, (int, float)) and isinstance(op.after, (int, float)):
        return "price_cut" if op.after < op.before else "price_increase"
    return "pricing_model"


def money(v):
    return "custom pricing" if v is None else "${:g}".format(v)


def plan(op):
    return op.attribute.split(".")[1].title() if op.attribute.startswith("pricing.") else op.attribute


def claim_text(name, op):
    cat = category(op)
    if cat == "new_plan":
        return "{} added a {} plan at {}.".format(name, plan(op), money(op.after))
    if cat == "deprecation":
        return "{} no longer lists its {} plan (was {}).".format(name, plan(op), money(op.before))
    return "{} changed {} from {} to {} per month.".format(name, plan(op), money(op.before), money(op.after))


def fallback_copy(name, op) -> Dict[str, str]:
    cat = category(op)
    spoken = {
        "price_cut": "{} cut {} to {}.".format(name, plan(op), money(op.after)),
        "price_increase": "{} raised {} to {}.".format(name, plan(op), money(op.after)),
        "new_plan": "{} launched a new {} plan.".format(name, plan(op)),
        "deprecation": "{} dropped its {} plan.".format(name, plan(op)),
    }.get(cat, "{} changed {} pricing.".format(name, plan(op)))
    if cat in ("price_cut", "price_increase") and op.before:
        pct = (op.after - op.before) / op.before * 100
        headline = "{} {}: {:+.0f}%".format(name, plan(op), pct)
    else:
        headline = "{} {}: {} → {}".format(name, plan(op), money(op.before), money(op.after))
    return {"spoken": spoken, "headline": headline}


class StoryboardComposer:
    def __init__(self, copywriter=None):
        """copywriter(change_text) -> {"spoken", "headline"} | None, e.g. Liquid. Optional."""
        self.copywriter = copywriter

    def _copy(self, name, op):
        base = fallback_copy(name, op)
        if self.copywriter:
            got = self.copywriter(claim_text(name, op)) or {}
            spoken = str(got.get("spoken") or "")
            if spoken and len(spoken.split()) <= 10:  # must fit a 4 s scene
                base["spoken"] = spoken
        return base

    def compose(self, accepted: List[Tuple[Patch, PatchOp]], names: Dict[str, str],
                tracked: int, market: str = "Competitor pricing") -> Optional[Storyboard]:
        picked = sorted([(p, o) for p, o in accepted if is_meaningful(o)],
                        key=lambda po: po[1].significance, reverse=True)[:TOP_N]
        if not picked:
            return None
        claims, scenes, t = [], [], 0.0

        def add_scene(kind, dur, narration, on_screen, image, claim_ids=()):
            nonlocal t
            scenes.append(Scene(scene=len(scenes) + 1, start_sec=t, duration_sec=dur, type=kind, narration=narration,
                                on_screen_text=on_screen, image_prompt=STYLE.prompt_prefix + " " + image,
                                claim_ids=list(claim_ids), motion="slow zoom out" if kind == "title" else "slow push in"))
            t += dur

        n = len(picked)
        add_scene("title", 3, "{} competitors. {} {} that matter{}.".format(
            tracked, n, "move" if n == 1 else "moves", "s" if n == 1 else ""),
            {"headline": market + ": what changed", "sub": "{} tracked · {} key move{}".format(
                tracked, n, "" if n == 1 else "s")},
            "a wide constellation of small glowing nodes, a few brighter than the rest")

        copies = {}
        for i, (p, op) in enumerate(picked):
            name = names.get(op.entity_id, op.entity_id.title())
            cid = "c{}".format(i + 1)
            claims.append(Claim(claim_id=cid, text=claim_text(name, op), belief_key=op.belief_key,
                                patch_id=p.patch_id, evidence_ids=op.evidence_ids))
            copies[cid] = self._copy(name, op)
            add_scene("change", 4, copies[cid]["spoken"],
                      {"headline": copies[cid]["headline"], "competitor": name, "rank": str(i + 1)},
                      IMAGE_BY_CATEGORY[category(op)], [cid])

        quiet = tracked - len({op.entity_id for _, op in picked})
        if quiet > 0:
            add_scene("quiet", 3, "{} others: no real change.".format(quiet),
                      {"headline": "{} competitors: no real change".format(quiet)},
                      "a calm sea of dim nodes, gentle ripples fading out")

        opp = next((i for i, (_, op) in enumerate(picked) if category(op) in ("price_increase", "deprecation")), None)
        label = "Biggest opening" if opp is not None else "Biggest threat"
        k = opp if opp is not None else 0
        cid = claims[k].claim_id
        _, op_k = picked[k]
        short = fallback_copy(names.get(op_k.entity_id, op_k.entity_id.title()), op_k)["spoken"]  # label + line must fit 4 s
        add_scene("outro", 4, "{}: {}".format(label, short),
                  {"headline": label, "sub": copies[cid]["headline"]},
                  "a bright open path leading forward through a field of dim nodes", [cid])

        patch_ids = sorted({p.patch_id for p, _ in picked})
        sid = hashlib.sha256("|".join(patch_ids + [SCHEMA_VERSION]).encode()).hexdigest()[:24]
        return Storyboard(storyboard_id=sid, patch_ids=patch_ids, title=market + ": what changed",
                          total_duration_sec=t, style=STYLE, scenes=scenes, claims=claims,
                          voiceover_full=" ".join(s.narration for s in scenes))


def narration_warnings(sb: Storyboard) -> List[str]:
    return ["scene {}: {} words for {:g}s".format(s.scene, len(s.narration.split()), s.duration_sec)
            for s in sb.scenes if len(s.narration.split()) > s.duration_sec * WORDS_PER_SEC]
