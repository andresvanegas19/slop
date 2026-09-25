"""Market developments -> the VideoStoryboard the web app renders (contracts/video.py, schema 1.0).

    title (5 s) -> up to 4 dev-N scenes (6-7 s, one per development, different competitors first)
                -> implications (7 s: what it means for the user's company) -> outro (5 s)
    no developments: title -> quiet (7 s, cites the envelopes checked) -> outro

Every scene is a 5-20 s FLUX clip, so each is one human moment of candid phone footage; facts live in
`onScreenText` overlays and narration, never in the image. Liquid may rephrase narration (`copywriter`), but a line
is used only if it adds no number or name that is not in the facts it was given; otherwise the deterministic line is.
"""
import hashlib
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from contracts import (EvidenceRef, MarketDevelopment, MarketWatch, Patch, PatchOp, VideoMotion, VideoOnScreenText,
                       VideoScene, VideoStoryboard, VideoStyle, VideoTiming, VideoTransition)
from contracts.video import STORYBOARD_SCHEMA_VERSION, WORDS_PER_SECOND

from .storyboard import PHONE_FOOTAGE_PREFIX, claim_text

MAX_DEV_SCENES = 4
TITLE_MS, DEV_SHORT_MS, DEV_LONG_MS, IMPLICATIONS_MS, QUIET_MS, OUTRO_MS = 5000, 6000, 7000, 7000, 7000, 5000
TEXT_MAX = 120

STYLE = VideoStyle(id="market-phone-footage-v1", visualPrompt=PHONE_FOOTAGE_PREFIX, aspectRatio="16:9", seed=42)
NO_TEXT = "No text, letters, numbers or logos in frame."

# Two human moments per kind, so two launches in one video don't get the same shot. Screens face away from the lens.
KIND_VISUALS = {
    "launch": ["a small product team gathered around a laptop in a bright office, one person demoing while the others "
               "lean in and nod, screen turned away from camera",
               "a designer and an engineer high-fiving beside a standing desk after a demo, teammates smiling behind "
               "them, laptop screen facing away"],
    "pricing": ["a woman at a cafe table comparing plans on her laptop, screen turned away from camera, chin resting "
                "on her hand, thinking it over",
                "a small-business owner at a kitchen table weighing options on a laptop with a colleague, screen "
                "facing away, quiet concentration"],
    "partnership": ["two teams meeting in a glass-walled conference room, two leads shaking hands across the table "
                    "while colleagues smile",
                    "two people from different companies walking and talking through an office lobby, relaxed and "
                    "laughing, one clapping the other on the shoulder"],
    "funding": ["two founders in a small startup office sharing a quiet celebratory hug, coworkers clapping softly in "
                "the background",
                "a founder on a phone call by a window breaking into a relieved smile, teammates glancing up from "
                "their desks"],
    "acquisition": ["two groups of coworkers meeting in an open office on their first day together, handshakes and "
                    "nervous smiles",
                    "a team carrying boxes into a new shared office, people greeting each other in the hallway"],
    "hiring": ["a job interview in a sunlit meeting room, a candidate smiling across the table from two interviewers",
               "a new hire being welcomed by a small team at her desk on her first morning, warm handshakes"],
    "leadership": ["a new executive addressing a small standing crowd of employees in an open office, attentive "
                   "faces turned toward her",
                   "a leader walking the office floor and stopping to talk with a small group of employees, listening "
                   "closely"],
    "other": ["coworkers talking animatedly by a window in a busy office, one holding a phone face down while "
              "explaining",
              "a small team huddled around a coffee table in an office lounge, deep in discussion"],
}
TITLE_VISUAL = ("morning in a busy open-plan office, people arriving with coffee and glancing at their phones, one "
                "woman stopping to read something with a curious expression")
IMPLICATIONS_VISUAL = ("a small leadership team in a quiet meeting room leaning in over coffee, one person talking with "
                       "her hands while the others listen intently")
QUIET_VISUAL = "a calm office late in the afternoon, people working quietly at their desks, an ordinary unhurried day"
OUTRO_VISUAL = ("a team lead stepping out of an office onto a sunny street, taking a breath and looking ahead with a "
                "confident half-smile")

CAMERA_DESCRIPTIONS = {
    "static": "steady handheld frame, people moving naturally within it",
    "push-in": "slow handheld push-in toward the people",
    "pull-out": "slow handheld pull-out revealing the room",
    "pan-left": "gentle handheld pan to the left across the group",
    "pan-right": "gentle handheld pan to the right across the group",
    "tilt-up": "slow handheld tilt up from hands to faces",
    "tilt-down": "slow handheld tilt down from faces to hands",
}
DEV_CAMERAS = ["pan-right", "push-in", "pan-left", "tilt-up"]

KIND_DONE = {  # "<names> <done>": past tense works for one or many names
    "launch": "shipped new features", "pricing": "changed pricing", "partnership": "announced partnerships",
    "funding": "raised capital", "acquisition": "made acquisitions", "hiring": "shifted hiring",
    "leadership": "changed leadership", "other": "made notable moves",
}
KIND_ACTION = {
    "launch": "Check where your product now has gaps.",
    "pricing": "Review how your pricing compares.",
    "partnership": "Watch which customers they can now reach.",
    "funding": "Watch for bigger sales and marketing pushes.",
    "acquisition": "Watch how the combined product competes.",
    "hiring": "Watch where they are investing next.",
    "leadership": "Watch for a shift in their strategy.",
    "other": "Keep an eye on what comes next.",
}
_STOP_TAIL = {"and", "or", "to", "of", "the", "a", "an", "with", "for", "in", "on", "as", "by", "at", "from", "its"}
_COMMON_CAPS = {"The", "A", "An", "For", "This", "That", "These", "Those", "Its", "It", "Their", "They", "And", "But",
                "With", "In", "On", "Now", "New", "Meanwhile", "Also", "What", "Your", "You", "We", "Our", "Expect",
                "Watch", "Keep", "Check", "Review", "Both", "Together", "Plus", "So", "As", "At", "By"}

Copywriter = Callable[[dict], Optional[dict]]


@dataclass(frozen=True)
class StoryItem:
    """One reportable fact: a grounded development, or an accepted pricing change from the pricing path."""
    key: str
    entity_id: str
    entity_name: str
    kind: str
    headline: str
    summary: str
    source_name: str
    evidence_id: str
    url: str
    significance: float
    at: datetime


def item_from_development(d: MarketDevelopment) -> StoryItem:
    return StoryItem(key=d.development_id, entity_id=d.entity_id, entity_name=d.entity_name, kind=d.kind.value,
                     headline=d.headline, summary=d.summary, source_name=d.source_name, evidence_id=d.evidence_id,
                     url=d.url, significance=d.significance, at=d.published_at or d.observed_at)


def items_from_pricing(changes: Iterable[Tuple[Patch, PatchOp]], names: Mapping[str, str]) -> List[StoryItem]:
    out = []
    for patch, op in changes:
        if not op.evidence_ids:
            continue
        name = names.get(op.entity_id, op.entity_id.title())
        out.append(StoryItem(key=patch.patch_id, entity_id=op.entity_id, entity_name=name, kind="pricing",
                             headline=claim_text(name, op).rstrip(".")[:TEXT_MAX], summary="",
                             source_name="Pricing page", evidence_id=op.evidence_ids[-1], url="",
                             significance=op.significance, at=patch.observed_at))
    return out


def pick(items: Sequence[StoryItem], limit: int = MAX_DEV_SCENES) -> List[StoryItem]:
    """Most significant first, one per competitor until every competitor with news has a scene."""
    ranked = sorted(items, key=lambda i: (-i.significance, -i.at.timestamp(), i.key))
    first, rest, seen = [], [], set()
    for i in ranked:
        (rest if i.entity_id in seen else first).append(i)
        seen.add(i.entity_id)
    return (first + rest)[:limit]


# --- text helpers ----------------------------------------------------------------------------------------------------

def budget(ms: int) -> int:
    return int(ms / 1000 * WORDS_PER_SECOND)


def fit_words(text: str, max_words: int) -> str:
    """Trim a sentence to the narration budget at a clause boundary; never mid-word."""
    words = " ".join(str(text).split()).split()
    if len(words) <= max_words:
        return " ".join(words)
    cut = words[:max_words]
    for i in range(len(cut) - 1, max_words // 2, -1):
        if cut[i].endswith((",", ";", ":")):
            cut = cut[:i + 1]
            break
    while len(cut) > 1 and cut[-1].lower().strip(",;:") in _STOP_TAIL:
        cut = cut[:-1]
    return " ".join(cut).rstrip(",;:—-") + "."


def short(text: str, limit: int = TEXT_MAX) -> str:
    text = " ".join(str(text).split())
    if len(text) <= limit:
        return text
    return text[:limit - 1].rsplit(" ", 1)[0].rstrip(",;:") + "…"


def sentence(text: str) -> str:
    text = " ".join(str(text).split()).rstrip()
    return text if text.endswith((".", "!", "?")) else text + "."


def names_phrase(names: Sequence[str]) -> str:
    names = list(dict.fromkeys(names))
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return "{} and {}".format(*names)
    return "{}, {} and others".format(names[0], names[1])


def moves_line(picked: Sequence[StoryItem]) -> str:
    """'Asana: launch · ClickUp: 2 moves' for the implications overlay."""
    by_entity: Dict[str, List[str]] = {}
    for i in picked:
        by_entity.setdefault(i.entity_name, []).append(i.kind)
    return " · ".join("{}: {}".format(name, kinds[0] if len(kinds) == 1 else "{} moves".format(len(kinds)))
                      for name, kinds in by_entity.items())


def human_date(now: datetime) -> str:
    return "{:%B} {}, {}".format(now, now.day, now.year)


def _numbers(text: str) -> set:
    return {n.replace(",", "").rstrip(".") for n in re.findall(r"\d[\d,.]*", text)}


def rephrase_ok(line, source: str, max_words: int, must_mention: str = "") -> bool:
    """A copywriter line may only rephrase `source`: no new numbers, no new capitalized names, within budget."""
    if not isinstance(line, str) or not line.strip():
        return False
    words = line.split()
    if len(words) > max_words:
        return False
    if must_mention and must_mention.lower() not in line.lower():
        return False
    if not _numbers(line) <= _numbers(source):
        return False
    low = source.lower()
    for token in re.findall(r"\b[A-Z][\w.&'-]*", " ".join(words[1:])):
        token = re.sub(r"['’]s$", "", token).rstrip(".")
        if token and token not in _COMMON_CAPS and token.lower() not in low:
            return False
    return True


# --- scenes ------------------------------------------------------------------------------------------------------------

class _Timeline:
    def __init__(self):
        self.scenes: List[VideoScene] = []
        self.t = 0

    def add(self, scene_id, ms, visual, camera, texts, narration, evidence=(), transition=None):
        on_screen = [VideoOnScreenText(text=short(text), position=pos) for text, pos in texts if str(text).strip()]
        self.scenes.append(VideoScene(
            id=scene_id, timing=VideoTiming(startMs=self.t, durationMs=ms),
            visualPrompt="{} {} {}".format(STYLE.visualPrompt, visual, NO_TEXT),
            motion=VideoMotion(camera=camera, description=CAMERA_DESCRIPTIONS[camera]),
            transition=transition or VideoTransition(), onScreenText=on_screen,
            narration=fit_words(narration, budget(ms)), evidenceIds=list(dict.fromkeys(evidence))))
        self.t += ms


def _dev_line(item: StoryItem) -> str:
    text = sentence(item.headline)
    if item.entity_name.lower() not in text.lower():
        text = "{}: {}".format(item.entity_name, text)
    return text


def _fallback_implication(company: str, picked: Sequence[StoryItem], max_words: int) -> str:
    by_kind: Dict[str, List[str]] = {}
    for i in picked:
        by_kind.setdefault(i.kind, []).append(i.entity_name)
    clauses = ["{} {}".format(names_phrase(n), KIND_DONE.get(k, KIND_DONE["other"])) for k, n in by_kind.items()]
    action = KIND_ACTION.get(picked[0].kind, KIND_ACTION["other"])
    for tail in (" " + action, ""):              # what to do about it beats listing every competitor
        for n in range(len(clauses), 0, -1):
            text = "For {}: {}.{}".format(company, "; ".join(clauses[:n]), tail)
            if len(text.split()) <= max_words:
                return text
    return fit_words("For {}: {}.".format(company, clauses[0]), max_words)


def _copy(copywriter: Optional[Copywriter], company: str, picked: Sequence[StoryItem], line_words: int,
          implication_words: int) -> Tuple[Dict[str, str], Optional[str]]:
    """Ask the copywriter once for every line; keep only lines that pass rephrase_ok."""
    if not copywriter or not picked:
        return {}, None
    facts = [{"id": "dev-{}".format(n + 1), "entity": i.entity_name, "kind": i.kind, "headline": i.headline,
              "summary": i.summary or ""} for n, i in enumerate(picked)]
    try:
        got = copywriter({"company": company, "developments": facts, "line_words": line_words,
                          "implication_words": implication_words}) or {}
    except Exception:
        return {}, None
    lines = got.get("lines") if isinstance(got.get("lines"), dict) else {}
    kept = {}
    for f in facts:
        source = "{entity} {kind} {headline} {summary}".format(**f)
        if rephrase_ok(lines.get(f["id"]), source, line_words, must_mention=f["entity"]):
            kept[f["id"]] = sentence(lines[f["id"]])
    all_facts = " ".join("{entity} {kind} {headline} {summary}".format(**f) for f in facts) + " " + company
    implication = got.get("implication")
    ok = rephrase_ok(implication, all_facts, implication_words, must_mention=company)
    return kept, sentence(implication) if ok else None


def storyboard_id(watch_id: str, keys: Sequence[str]) -> str:
    raw = "|".join([watch_id] + list(keys) + [STORYBOARD_SCHEMA_VERSION])
    return "vsb_" + hashlib.sha256(raw.encode()).hexdigest()[:20]


def compose_market_storyboard(watch: MarketWatch, developments: Sequence[MarketDevelopment], now: datetime,
                              copywriter: Optional[Copywriter] = None,
                              pricing_changes: Iterable[Tuple[Patch, PatchOp]] = (),
                              checked_evidence_ids: Sequence[str] = (),
                              evidence_refs: Optional[Mapping[str, EvidenceRef]] = None
                              ) -> Tuple[VideoStoryboard, List[EvidenceRef]]:
    """Compose and validate (constructing VideoStoryboard raises on any rule violation).

    developments: active, grounded developments for the watch. pricing_changes: accepted meaningful pricing ops.
    checked_evidence_ids: usable envelopes read this cycle (the quiet storyboard cites them).
    evidence_refs: obs_id -> EvidenceRef (url/title/source) for the evidence list stored next to the storyboard.
    """
    company = watch.company.name
    names = watch.entity_names()
    items = [item_from_development(d) for d in developments] + items_from_pricing(pricing_changes, names)
    picked = pick(items)
    n_tracked = len(watch.competitors)
    market = (watch.company.category or "competitor").strip()
    heading = short("{} market update".format(market[:1].upper() + market[1:]))
    tl = _Timeline()

    k = len(picked)
    moves = "{} notable move{}".format(k, "" if k == 1 else "s") if k else "no notable public moves"
    title_lines = ["{}. {} competitors tracked, {}.".format(heading, n_tracked, moves),
                   "Your market update. {} competitors tracked, {}.".format(n_tracked, moves),
                   "Market update: {}.".format(moves)]
    title_line = next((t for t in title_lines if len(t.split()) <= budget(TITLE_MS)), title_lines[-1])
    tl.add("title", TITLE_MS, TITLE_VISUAL, "push-in",
           [(heading, "top"), ("{} · {} competitors tracked".format(human_date(now), n_tracked), "bottom")],
           title_line)

    if picked:
        line_words = budget(DEV_LONG_MS)
        lines, implication = _copy(copywriter, company, picked, line_words, budget(IMPLICATIONS_MS))
        kind_count: Dict[str, int] = {}
        for n, item in enumerate(picked):
            scene_id = "dev-{}".format(n + 1)
            line = lines.get(scene_id) or _dev_line(item)
            ms = DEV_SHORT_MS if len(line.split()) <= budget(DEV_SHORT_MS) else DEV_LONG_MS
            variants = KIND_VISUALS.get(item.kind, KIND_VISUALS["other"])
            visual = variants[kind_count.get(item.kind, 0) % len(variants)]
            kind_count[item.kind] = kind_count.get(item.kind, 0) + 1
            source = item.source_name or item.entity_name
            tl.add(scene_id, ms, visual, DEV_CAMERAS[n % len(DEV_CAMERAS)],
                   [(item.headline, "top"), ("Source: {}".format(source), "bottom")], line, [item.evidence_id])
        cited = [i.evidence_id for i in picked]
        summary_line = moves_line(picked)
        tl.add("implications", IMPLICATIONS_MS, IMPLICATIONS_VISUAL, "pull-out",
               [("What it means for {}".format(company), "top"), (summary_line, "bottom")],
               implication or _fallback_implication(company, picked, budget(IMPLICATIONS_MS)), cited)
        sources = list(dict.fromkeys(i.source_name for i in picked if i.source_name))
        tl.add("outro", OUTRO_MS, OUTRO_VISUAL, "static",
               [("{} market update".format(company), "top"),
                ("Sources: {}".format(", ".join(sources)) if sources else "Every claim links to its source",
                 "bottom")],
               "Every claim here links to its source. Until next time.",
               transition=VideoTransition(type="fade-to-black", durationMs=800))
        keys = [i.key for i in picked]
        headline = "{}: {}".format(heading, picked[0].headline)
    else:
        checked = list(dict.fromkeys(e for e in checked_evidence_ids if e))
        if checked:
            tl.add("quiet", QUIET_MS, QUIET_VISUAL, "pan-left",
                   [("No notable moves", "top"),
                    ("{} sources checked across {} competitors".format(len(checked), n_tracked), "bottom")],
                   "We checked {} recent sources on {} competitors and found no notable public moves.".format(
                       len(checked), n_tracked), checked)
        else:
            tl.add("outro-quiet", QUIET_MS, QUIET_VISUAL, "pan-left",
                   [("No new sources this time", "top"), ("{} competitors tracked".format(n_tracked), "bottom")],
                   "No new public sources on your competitors turned up this time.")
        tl.add("outro", OUTRO_MS, OUTRO_VISUAL, "static",
               [("{} market update".format(company), "top"), ("A quiet period", "bottom")],
               "We'll keep watching and flag the next real move.",
               transition=VideoTransition(type="fade-to-black", durationMs=800))
        keys = ["quiet"] + sorted(checked)
        headline = "{}: a quiet period".format(heading)

    sb = VideoStoryboard(id=storyboard_id(watch.watch_id, keys), patchIds=keys, headline=headline, style=STYLE,
                         scenes=tl.scenes)

    by_evidence = {i.evidence_id: i for i in items}
    refs = []
    for obs_id in sb.evidence_ids():
        ref = (evidence_refs or {}).get(obs_id)
        if ref is None:
            i = by_evidence.get(obs_id)
            ref = EvidenceRef(obs_id=obs_id, url=i.url if i else "", source_name=i.source_name if i else "",
                              entity_id=i.entity_id if i else "")
        refs.append(ref)
    return sb, refs
