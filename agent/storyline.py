"""The storyline tool: turns a research session (profile, findings, the user's answers, competitor landscape) and the
user's request into a StoryPlan, one beat per scene of a video template, for the user to review before rendering.

Liquid picks the template (ad by default) and writes the beats; code keeps the plan truthful and on-policy:
- beats cite only finding ids that exist in the session (company findings), otherwise the citation is dropped;
- a beat, title or logline that names a competitor (landscape.avoid_terms) is replaced by a deterministic beat;
- the beat count always equals the template's scene count (missing beats are filled from the profile).
Templates come from the caller (the web app sends its presets for the chosen duration), so the scene roles have a
single source of truth in generation-video/src/lib/presets.ts.
"""
import re
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from contracts.research import CompanyProfile, Finding, ResearchSessionState, SourcedText, stable_id
from contracts.story import MAX_BEATS, CompetitiveLandscape, StoryBeat, StoryPlan, StoryTemplate, TemplateRole

from .competitors import mentions
from .playbook import STORY_RULES
from .story_llm import JsonLlm

MAX_FACTS = 40
COMPETITIVE_RE = re.compile(r"compet|rival|\bvs\.?\b|versus|alternative|better than|switch|compar|mejor que|"
                            r"competencia|frente a", re.I)
COMPANY_RE = re.compile(r"\b(company|brand film|about us|who we are|recruit|hiring|culture|empresa|marca|"
                        r"qui[eé]nes somos)\b", re.I)

DEFAULT_TEMPLATES = [StoryTemplate(id="ad", label="Ad", description="Product ad: hook, product, benefit, call to action",
                                   roles=[TemplateRole(type="hook", goal="grab attention"),
                                          TemplateRole(type="product", goal="show the product"),
                                          TemplateRole(type="benefit", goal="show the main benefit"),
                                          TemplateRole(type="cta", goal="one clear call to action")])]

STORY_PROMPT = """[task:storyline] Write the storyline of a {duration}-second video for {name}.
User's request: \"\"\"{prompt}\"\"\"
What the user told us: {answers}
Company: {one_line} {what}
Facts you may use (cite by id):
{facts}
How {name} stands apart (cite the same ids): {diffs}
Brand voice: {voice}. Imagery: {imagery}
Templates (pick the one that fits the request best; "{default}" unless the request asks otherwise):
{templates}
{playbook}
Rules: exactly one beat per scene of the chosen template, in order. "message" is what the scene says: one short sentence using only the facts above (no numbers or prices unless a fact states them). "visual" is what the viewer sees: one concrete photo idea (subject, setting, light) with no text, logos, screens with words, or other companies' products. Never name or show other companies.
Reply with only JSON: {{"template": "<id>", "reason": "<why this template>", "title": "<at most 8 words>", "logline": "<the story in one sentence>", "tone": "<2-4 words>", "audience": "<who it speaks to>", "call_to_action": "<at most 6 words>", "beats": [{{"message": "...", "visual": "...", "findings": ["F1"]}}]}}"""

ROLE_KIND = {"hook": "hook", "problem": "hook", "who": "intro", "intro": "intro", "product": "product",
             "what": "product", "approach": "product", "solution": "product", "benefit": "benefit", "why": "benefit",
             "differentiator": "benefit", "edge": "benefit", "proof": "proof", "people": "people", "cta": "cta"}
ROLE_VISUAL = {
    "hook": "a bold, striking close-up that stops the scroll, dramatic light, one clear subject",
    "intro": "the people and place behind the company, warm natural light, medium-wide shot",
    "product": "the product as the hero in a clean, well-lit setting, shallow depth of field",
    "benefit": "a person enjoying the result in a real everyday moment, natural window light",
    "proof": "a satisfying detail that shows quality and care, macro shot, soft highlights",
    "people": "a candid moment of a team working together, genuine smiles, soft daylight",
    "cta": "the product centered on a clean backdrop with generous empty space, confident hero light",
}


def _now():
    return datetime.now(timezone.utc)


def _clip(text, n):
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _sentence(text: str, n: int = 220) -> str:
    first = re.split(r"(?<=[.!?])\s+", _clip(text, 600))[0]
    return _clip(first, n)


def pick_template(templates: List[StoryTemplate], prompt: str, landscape: Optional[CompetitiveLandscape],
                  hint: Optional[str] = None) -> StoryTemplate:
    by_id = {t.id: t for t in templates}
    if hint and hint in by_id:
        return by_id[hint]
    has_competitors = bool(landscape and any(c.verified for c in landscape.competitors))
    if "competitive" in by_id and has_competitors and COMPETITIVE_RE.search(prompt or ""):
        return by_id["competitive"]
    if "company" in by_id and COMPANY_RE.search(prompt or "") and not re.search(r"\bad\b|anuncio|commercial|promo",
                                                                                  prompt or "", re.I):
        return by_id["company"]
    return by_id.get("ad") or templates[0]


class FactPool:
    """Facts a beat may use: the company's differentiators, key messages, products and proof, each with finding ids."""

    def __init__(self, profile: Optional[CompanyProfile], landscape: Optional[CompetitiveLandscape],
                 findings: List[Finding]):
        self.used: set = set()
        p = profile
        self.by_kind: Dict[str, List[Tuple[str, List[str]]]] = {k: [] for k in
                                                                 ("hook", "intro", "product", "benefit", "proof",
                                                                  "people")}

        def add(kind, item):
            if isinstance(item, SourcedText) and item.text.strip():
                self.by_kind[kind].append((item.text, list(item.finding_ids)))
            elif isinstance(item, Finding):
                self.by_kind[kind].append((item.claim, [item.finding_id]))

        if p is not None:
            for k in p.key_messages[:3]:
                add("hook", k)
            add("hook", p.one_line)
            add("intro", p.one_line)
            add("intro", p.what_they_do)
            for x in p.products[:4]:
                add("product", x)
            add("product", p.what_they_do)
            for f in p.proof_points[:4]:
                add("proof", f)
        for d in (landscape.differentiators if landscape else [])[:4]:
            add("benefit", d)
        if p is not None:
            for k in p.key_messages[:4]:
                add("benefit", k)
        for f in findings:
            if f.topic == "people":
                add("people", f)
            elif f.topic == "proof":
                add("proof", f)

    def take(self, kind: str) -> Tuple[str, List[str]]:
        order = [kind] + [k for k in ("benefit", "product", "hook", "intro", "proof", "people") if k != kind]
        for k in order:
            for text, ids in self.by_kind.get(k, []):
                key = text.lower()
                if key not in self.used:
                    self.used.add(key)
                    return _sentence(text), ids
        return "", []


def fallback_beat(index: int, role: TemplateRole, pool: FactPool, name: str, cta: str, imagery: str) -> StoryBeat:
    kind = ROLE_KIND.get(role.type.lower(), "benefit")
    if kind == "cta":
        message, ids = cta, []
    else:
        message, ids = pool.take(kind)
        message = message or ("Meet {}.".format(name) if kind in ("hook", "intro") else "Made for you by {}.".format(
            name))
    visual = ROLE_VISUAL.get(kind, ROLE_VISUAL["benefit"])
    if imagery:
        visual = _clip("{}, {}".format(visual, imagery), 300)
    return StoryBeat(index=index, role=role.type, goal=_clip(role.goal, 300), message=_clip(message, 300),
                     visual=_clip(visual, 300), finding_ids=ids[:6])


def _answers(state: ResearchSessionState) -> str:
    return "; ".join("{} -> {}".format(q.question, q.answer) for q in state.questions if q.answered) or "nothing yet"


def _default_cta(state: ResearchSessionState, profile: Optional[CompanyProfile]) -> str:
    brief = profile.video_brief if profile else None
    if brief and brief.call_to_action and not re.match(r"^\s*no\b", brief.call_to_action, re.I):
        return _clip(brief.call_to_action, 60)
    if state.domain:
        return "Visit {}".format(state.domain)
    return "Discover {}".format(profile.name if profile else "us")


def write_storyline(state: ResearchSessionState, landscape: Optional[CompetitiveLandscape],
                    templates: List[StoryTemplate], duration_sec: int, llm: JsonLlm,
                    template_hint: Optional[str] = None, prompt: Optional[str] = None,
                    version: int = 1) -> StoryPlan:
    templates = templates or DEFAULT_TEMPLATES
    profile = state.profile
    name = profile.name if profile else (state.intent.company_name if state.intent else "the company")
    request = _clip(prompt or state.prompt, 2000)
    avoid = list(landscape.avoid_terms) if landscape else []
    findings = list(state.findings)[-MAX_FACTS:]
    ids = {"F{}".format(i + 1): f for i, f in enumerate(findings)}
    valid_ids = {f.finding_id for f in state.findings}
    brief = profile.video_brief if profile else None
    imagery = profile.visual_identity.imagery_style if profile else ""
    cta = _default_cta(state, profile)

    def ref(fid_or_label) -> Optional[str]:
        if isinstance(fid_or_label, str):
            if fid_or_label in ids:
                return ids[fid_or_label].finding_id
            if fid_or_label in valid_ids:
                return fid_or_label
        return None

    fid_label = {f.finding_id: label for label, f in ids.items()}
    diffs = "; ".join("{} ({})".format(d.text, ",".join(fid_label.get(x, "") for x in d.finding_ids if x in fid_label))
                      for d in (landscape.differentiators if landscape else [])[:4]) or "unknown"
    default = pick_template(templates, request, landscape, template_hint)
    template_lines = []
    for t in templates:
        scenes = "; ".join("{} {}: {}".format(i + 1, r.type, _clip(r.goal, 140)) for i, r in enumerate(t.roles))
        template_lines.append("- {} ({}, {} scenes): {}".format(t.id, t.label or t.id, len(t.roles), scenes))
    got = llm.ask(STORY_PROMPT.format(
        duration=duration_sec, name=name, prompt=request, answers=_answers(state),
        one_line=profile.one_line.text if profile and profile.one_line else "",
        what=profile.what_they_do.text if profile and profile.what_they_do else "",
        facts="\n".join("{} [{}] {}".format(label, f.topic, _clip(f.claim, 240)) for label, f in ids.items())
        or "none", diffs=diffs, voice=profile.brand_voice.text if profile and profile.brand_voice else "unknown",
        imagery=imagery or "unknown", default=default.id, templates="\n".join(template_lines), playbook=STORY_RULES))
    got = got if isinstance(got, dict) else {}

    by_id = {t.id: t for t in templates}
    template = by_id.get(template_hint or "") or by_id.get(str(got.get("template") or "")) or default
    pool = FactPool(profile, landscape, list(state.findings))
    raw_beats = [b for b in (got.get("beats") or []) if isinstance(b, dict)]
    beats, from_llm = [], 0
    for i, role in enumerate(template.roles[:MAX_BEATS]):
        fb = fallback_beat(i, role, pool, name, cta, imagery)
        raw = raw_beats[i] if i < len(raw_beats) else {}
        message = _clip(raw.get("message"), 300) if isinstance(raw.get("message"), str) else ""
        visual = _clip(raw.get("visual"), 300) if isinstance(raw.get("visual"), str) else ""
        cites = [x for x in (ref(r) for r in (raw.get("findings") or [])) if x]
        ok_message = len(message) >= 8 and not mentions(message, avoid)
        ok_visual = len(visual) >= 12 and not mentions(visual, avoid)
        from_llm += int(ok_message) + int(ok_visual)
        beats.append(StoryBeat(index=i, role=role.type, goal=_clip(role.goal, 300),
                               message=message if ok_message else fb.message,
                               visual=visual if ok_visual else fb.visual,
                               finding_ids=(cites if ok_message else fb.finding_ids)[:6]))

    def safe(value, n, fallback):
        text = _clip(value, n) if isinstance(value, str) else ""
        return text if text and not mentions(text, avoid) else fallback

    total = 2 * len(beats)
    source = "llm" if from_llm == total else "fallback" if from_llm == 0 else "partial"
    now = _now()
    title_words = safe(got.get("title"), 120, "{} {}".format(name, template.label or template.id)).split()
    plan = StoryPlan(
        storyline_id="st_" + stable_id(state.session_id, str(version), now.isoformat(), size=14),
        session_id=state.session_id, template=template.id, duration_sec=int(duration_sec),
        title=" ".join(title_words[:8]), logline=safe(got.get("logline"), 400, beats[0].message if beats else name),
        tone=safe(got.get("tone"), 120, brief.tone if brief and brief.tone else ""),
        audience=safe(got.get("audience"), 200, brief.audience if brief and brief.audience else ""),
        call_to_action=safe(got.get("call_to_action"), 60, cta), beats=beats, avoid_terms=avoid,
        reason=safe(got.get("reason"), 300, "default template for this request"), source=source, version=version,
        created_at=now, updated_at=now, model=llm.model if got else "deterministic")
    return plan


def edit_storyline(plan: StoryPlan, edits: dict) -> StoryPlan:
    """User edits (title, logline, call_to_action, beats[i].message/visual). Raises ValueError with readable messages;
    competitor names are rejected, never silently rewritten."""
    if not isinstance(edits, dict):
        raise ValueError("storyline edits must be a JSON object")
    new = plan.model_copy(deep=True)
    problems: List[str] = []
    for field, n in (("title", 120), ("logline", 400), ("call_to_action", 60), ("tone", 120), ("audience", 200)):
        if field in edits:
            value = edits[field]
            if not isinstance(value, str) or (field in ("title", "logline") and not value.strip()):
                problems.append("{} must be {}text".format(field, "non-empty " if field in ("title", "logline")
                                                           else ""))
                continue
            setattr(new, field, _clip(value, n))
    beats = edits.get("beats")
    if beats is not None:
        if not isinstance(beats, list) or len(beats) != len(plan.beats):
            raise ValueError("beats must list exactly {} scenes".format(len(plan.beats)))
        for i, (beat, edit) in enumerate(zip(new.beats, beats)):
            if not isinstance(edit, dict):
                problems.append("scene {} must be an object".format(i + 1))
                continue
            for field in ("message", "visual"):
                if field in edit:
                    value = edit[field]
                    if not isinstance(value, str) or len(value.strip()) < 3:
                        problems.append("scene {} {} is empty".format(i + 1, field))
                        continue
                    value = _clip(value, 300)
                    if value != getattr(beat, field) and field == "message":
                        beat.finding_ids = []  # the user's own words: no longer a cited fact
                    setattr(beat, field, value)
    for label, text in [("title", new.title), ("logline", new.logline), ("call to action", new.call_to_action)] + [
            ("scene {}".format(b.index + 1), b.message + " " + b.visual) for b in new.beats]:
        named = mentions(text, new.avoid_terms)
        if named:
            problems.append("{} names a competitor ({}); the video never names competitors".format(label, named[0]))
    if problems:
        raise ValueError("; ".join(problems))
    new.version = plan.version + 1
    new.source = "user"
    new.updated_at = _now()
    return new
