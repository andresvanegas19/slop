"""Offline fixtures: evidence envelopes and a fake Liquid that reads 'Plan: $10' lines. No network."""
import hashlib
import re
from datetime import datetime, timedelta, timezone

from contracts import EvidenceEnvelope, ModelCallRecord, make_obs_id

T0 = datetime(2026, 9, 25, 12, 0, tzinfo=timezone.utc)
NAMES = {"notion": "Notion", "linear": "Linear", "jira": "Jira"}


def env(entity, prices, minutes=0, status="ok", run_id="run_fixture"):
    """prices: {"Plus": 10, "Enterprise": None}. The pricing hash follows the content, like A's."""
    at = T0 + timedelta(minutes=minutes)
    md = "\n".join("{}: {}".format(k, "custom" if v is None else "${:g}".format(v)) for k, v in prices.items())
    url = "https://{}.example/pricing".format(entity)
    h = hashlib.sha256(md.encode()).hexdigest()
    return EvidenceEnvelope(
        obs_id=make_obs_id(entity + "-pricing", url, at), run_id=run_id, source_id=entity + "-pricing",
        entity_id=entity, entity_name=NAMES.get(entity, entity.title()), source_type="pricing", url=url,
        fetched_at=at, status=status, parser_version="fixture-v1", content_hash=h,
        section_hashes={"pricing": h} if status == "ok" else {}, markdown=md if status == "ok" else None)


class FakeLiquid:
    def __init__(self):
        self.extract_calls = 0

    def extract_pricing(self, e, run_id):
        self.extract_calls += 1
        facts = {}
        for name, val in re.findall(r"^(.+?): (\$[\d.]+|custom)$", e.markdown or "", re.M):
            key = "pricing.{}.monthly_usd".format(re.sub(r"[^a-z0-9 ]", "", name.lower()).strip())
            facts[key] = {"value": None if val == "custom" else float(val[1:]), "unit": "per member/month"}
        return facts, ModelCallRecord(call_id="call{}".format(self.extract_calls), run_id=run_id,
                                      purpose="extract_facts", model="fake", input_tokens=100, output_tokens=20,
                                      latency_ms=1, ok=True)

    def write_copy(self, text, run_id):
        return None, ModelCallRecord(call_id="copy", run_id=run_id, purpose="storyboard", model="fake",
                                     input_tokens=10, output_tokens=5, latency_ms=1, ok=True)


class ListSource:
    """Feeds envelopes in batches: each run_cycle() consumes what was added since the last one."""
    name = "fixture"

    def __init__(self):
        self.items = []

    def add(self, *envs):
        self.items.extend(envs)

    def fetch_new(self, cursor):
        out = [(e, e.fetched_at.isoformat()) for e in sorted(self.items, key=lambda e: e.fetched_at)]
        return [(e, c) for e, c in out if c > (cursor or "")]
