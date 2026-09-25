"""The only place that talks to Liquid. Liquid extracts facts and writes copy; it never decides state (DECISIONS D2)."""
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
