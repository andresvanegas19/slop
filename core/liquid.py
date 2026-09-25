"""The only place that talks to Liquid. Liquid extracts facts and writes copy; it never decides state (DECISIONS D2).

Pricing pages: `extract_pricing`, `write_copy`. News/changelog articles: `extract_developments`, `write_market_copy`.
"""
import hashlib
import json
import re
import time
from typing import Dict, Optional, Tuple

from contracts import EvidenceEnvelope, ModelCallRecord

from .http import request_json

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "liquid/lfm-2.5-2.6b:free"
MAX_PAGE_CHARS = 14000

# attribute -> {"value": float | None, "unit": str | None}
Facts = Dict[str, dict]

EXTRACT_PROMPT = """You extract pricing facts from a SaaS pricing page.
Return ONLY JSON, no commentary:
{{"plans": [{{"name": "<plan name exactly as on page>", "price_monthly_usd": <number or null>, "unit": "<per member/month, flat/month, custom>"}}]}}
Rules: if monthly and yearly prices are both shown, use the monthly-billing price. Use null for "Contact sales" or custom pricing.

Company: {company}
Page:
{content}
"""

COPY_PROMPT = """Write one voiceover line for this competitor change. Return ONLY JSON, no commentary:
{{"spoken": "<max 10 words, numbers written as words>", "headline": "<max 6 words, include the key number>"}}
Change: {change}
"""


def plan_attribute(name):
    """'Plus*' and 'Plus' must be the same belief: Liquid adds footnote marks inconsistently."""
    clean = re.sub(r"[^a-z0-9 ]", "", str(name).lower()).strip()
    return "pricing.{}.monthly_usd".format(clean) if clean else None


def parse_json(text):
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except ValueError:
        return None


def pricing_window(markdown):
    i = markdown.find("$")
    start = max(0, i - 2000) if i >= 0 else 0
    return markdown[start:start + MAX_PAGE_CHARS]


def facts_from_plans(plans) -> Facts:
    facts = {}
    for p in plans or []:
        attr = plan_attribute(p.get("name", ""))
        if not attr:
            continue
        price = p.get("price_monthly_usd")
        try:
            price = None if price is None else round(float(price), 2)
        except (TypeError, ValueError):
            price = None
        facts[attr] = {"value": price, "unit": p.get("unit")}
    return facts


# --- market path: developments from news/changelog articles ------------------------------------------------------

ARTICLE_CHARS = 6000
DEVELOPMENT_KINDS = "launch|pricing|partnership|funding|acquisition|hiring|leadership|other"

DEVELOPMENTS_PROMPT = """You read one web article about {entity}. {entity} is a competitor of {company}{category}.
List at most 3 concrete, recent developments ABOUT {entity} that the article itself reports.
Ignore other companies, ads, navigation, related-article links and old background.
Return ONLY JSON, no commentary:
{{"developments": [{{"entity": "<the company this development is about>", "kind": "<one of {kinds}>", "headline": "<max 120 characters, factual, no hype, starts with {entity}>", "summary": "<one or two plain sentences>", "quote": "<one full sentence copied EXACTLY, character for character, from the article, that proves the development>", "published_at": "<YYYY-MM-DD if the article states its date, else null>", "significance": <0.0 to 1.0, where 1 is a major market move and 0.2 is minor news>}}]}}
If the article reports nothing concrete about {entity}, return {{"developments": []}}.

Article title: {title}
URL: {url}
Article:
{content}
"""

MARKET_COPY_PROMPT = """You write the voiceover for a short market-update video made for {company}.
Rephrase ONLY the facts below. Do not add any number, name, date, product or claim that is not in them.
Return ONLY JSON, no commentary:
{{"lines": {{"<fact id>": "<one plain spoken sentence, at most {line_words} words, that names the company it is about>"}}, "implication": "<one sentence, at most {implication_words} words: what these moves mean for {company}, using only these facts>"}}
Facts:
{facts}
"""

_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_BOILERPLATE = re.compile(r"\b(cookie|cookies|subscribe|sign in|sign up|log in|newsletter|privacy policy|terms of "
                          r"service|all rights reserved|advertisement|skip to|share this|follow us)\b", re.I)


def strip_links(text):
    return _LINK.sub(r"\1", _IMAGE.sub(" ", text or ""))


def article_window(markdown, entity_name="", max_chars=ARTICLE_CHARS):
    """The part of an article worth a model call: navigation, link lists and boilerplate lines dropped.

    Only whole lines are dropped and link syntax is reduced to its text, so a sentence Liquid copies from the
    window is still a (markup-insensitive) substring of the original markdown.
    """
    keep = []
    for line in (markdown or "").splitlines():
        t = line.strip()
        if not t:
            if keep and keep[-1]:
                keep.append("")
            continue
        plain = strip_links(t).strip(" *-+|")
        words = plain.split()
        if not words:
            continue                                       # image-only or link-only markup
        if _LINK.fullmatch(t.lstrip("*-+ ").strip()) and len(words) < 12:
            continue                                       # a line that is just one link: navigation
        if len(words) <= 3 and not t.startswith("#") and not re.search(r"\d", t):
            continue                                       # "Menu", "Share", "Home"
        if _BOILERPLATE.search(plain) and len(words) < 15:
            continue
        keep.append(strip_links(t))
    text = "\n".join(keep).strip()
    start = 0
    if entity_name:
        i = text.lower().find(entity_name.lower())
        if i > max_chars // 2:
            start = max(0, i - 1000)                       # the article body starts well after the header junk
    return text[start:start + max_chars]


class LiquidAdapter:
    def __init__(self, api_key, model=DEFAULT_MODEL):
        self.key, self.model = api_key, model

    def _call(self, prompt, run_id, purpose, max_tokens):
        # LFM 2.5 always reasons first (it can't be disabled); max_tokens must cover reasoning + answer.
        body = {"model": self.model, "messages": [{"role": "user", "content": prompt}], "temperature": 0,
                "max_tokens": max_tokens, "reasoning": {"effort": "low"}}
        t0 = time.time()
        status, res = None, None
        for attempt in range(4):
            status, res = request_json("POST", OPENROUTER_URL, self.key, body)
            if status != 429:
                break
            time.sleep(8 * (attempt + 1))  # free-tier rate limit
        ok = status == 200
        usage = (res or {}).get("usage", {}) if ok else {}
        record = ModelCallRecord(
            call_id=hashlib.sha256("{}|{}|{}".format(run_id, purpose, t0).encode()).hexdigest()[:24],
            run_id=run_id, purpose=purpose, model=self.model,
            input_tokens=usage.get("prompt_tokens", 0), output_tokens=usage.get("completion_tokens", 0),
            reasoning_tokens=(usage.get("completion_tokens_details") or {}).get("reasoning_tokens", 0) or 0,
            latency_ms=int((time.time() - t0) * 1000), ok=ok,
            error=None if ok else "HTTP {}: {}".format(status, str(res)[:200]))
        text = res["choices"][0]["message"]["content"] if ok else ""
        return text, record

    def extract_pricing(self, env: EvidenceEnvelope, run_id: str) -> Tuple[Facts, ModelCallRecord]:
        prompt = EXTRACT_PROMPT.format(company=env.entity_name, content=pricing_window(env.markdown or ""))
        text, record = self._call(prompt, run_id, "extract_facts", 4000)
        return facts_from_plans((parse_json(text) or {}).get("plans")), record

    def write_copy(self, change: str, run_id: str) -> Tuple[Optional[dict], ModelCallRecord]:
        text, record = self._call(COPY_PROMPT.format(change=change), run_id, "storyboard", 1500)
        return parse_json(text), record

    def extract_developments(self, env: EvidenceEnvelope, company, entity_name: str, run_id: str):
        """Liquid proposes 0-3 developments about `entity_name` from one article.

        Returns raw dicts: core.market grounds them (quote verbatim, right entity) before anything is kept."""
        title = ((env.structured or {}).get("title") or "") if isinstance(env.structured, dict) else ""
        category = " ({})".format(company.category) if getattr(company, "category", "") else ""
        prompt = DEVELOPMENTS_PROMPT.format(entity=entity_name, company=company.name, category=category,
                                            kinds=DEVELOPMENT_KINDS, title=title or "-", url=env.url,
                                            content=article_window(env.markdown or "", entity_name))
        text, record = self._call(prompt, run_id, "extract_developments", 4000)
        parsed = parse_json(text)
        if parsed is None and record.ok:
            # LFM sometimes spends the whole budget reasoning or drops the JSON: one retry, then give up.
            text, retry = self._call(prompt, run_id, "extract_developments", 4000)
            parsed = parse_json(text)
            record = retry.model_copy(update={
                "input_tokens": record.input_tokens + retry.input_tokens,
                "output_tokens": record.output_tokens + retry.output_tokens,
                "reasoning_tokens": record.reasoning_tokens + retry.reasoning_tokens,
                "latency_ms": record.latency_ms + retry.latency_ms})
        got = (parsed or {}).get("developments")
        return [d for d in got if isinstance(d, dict)] if isinstance(got, list) else [], record

    def write_market_copy(self, payload: dict, run_id: str):
        """Liquid rephrases the storyboard's facts. core.video_storyboard checks it added nothing before using it."""
        facts = "\n".join("- {id}: {entity} ({kind}): {headline}. {summary}".format(**f)
                          for f in payload.get("developments", []))
        prompt = MARKET_COPY_PROMPT.format(company=payload.get("company", "the company"), facts=facts,
                                           line_words=payload.get("line_words", 14),
                                           implication_words=payload.get("implication_words", 16))
        text, record = self._call(prompt, run_id, "storyboard", 3000)
        return parse_json(text), record
