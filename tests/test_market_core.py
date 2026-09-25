"""Market path tests: news envelopes -> grounded developments (beliefs) -> stored VideoStoryboard. Offline."""
import hashlib
from datetime import timedelta

import pytest

from contracts import (TABLES, BeliefStatus, CompanyBrief, CompetitorCandidate, DevelopmentKind, EvidenceEnvelope,
                       MarketDevelopment, MarketWatch, ModelCallRecord, OpType, Patch, PatchOp, PatchOrigin,
                       VideoStoryboard, VideoStoryboardRecord, belief_key, make_obs_id)
from contracts.video import MAX_SCENE_MS, MIN_SCENE_MS, WORDS_PER_SECOND
from core.coordinator import Coordinator
from core.market import (MarketCycle, ground_developments, normalize_kind, quote_in, source_name)
from core.repository import StateRepository
from core.sources import row_to_envelope
from core.validator import PatchValidator
from core.video_storyboard import compose_market_storyboard

from .helpers import T0, FakeLiquid, ListSource, env as pricing_env

COMPETITORS = {"asana": "Asana", "clickup": "ClickUp", "monday-com": "Monday.com", "wrike": "Wrike",
               "smartsheet": "Smartsheet", "notion": "Notion", "trello": "Trello"}

ASANA_MD = """[Home](https://techcrunch.com/) [Startups](https://techcrunch.com/startups)
Sign in
# Asana launches AI Studio for no-code workflow agents
September 20, 2026
**Asana** on Tuesday [launched](https://asana.com/ai) AI Studio, a no-code builder that lets teams create AI agents inside their workflows.
The company said AI Studio is available today to all Enterprise customers at no extra cost.
Meanwhile, rival ClickUp raised $400 million in new funding last month.
Subscribe to our newsletter
"""

GOOD = {"entity": "Asana", "kind": "Product Launch", "headline": "Asana launches AI Studio for no-code workflow agents",
        "summary": "A no-code builder for AI agents inside Asana workflows.",
        "quote": "Asana on Tuesday launched AI Studio, a no-code builder that lets teams create AI agents inside "
                 "their workflows.", "published_at": "2026-09-20", "significance": 0.8}
PARAPHRASED = dict(GOOD, headline="Asana ships agents for everyone",
                   quote="Asana released a tool so every team can build AI agents in its workflows.")
OTHER_COMPANY = {"entity": "ClickUp", "kind": "funding", "headline": "ClickUp raised $400 million",
                 "summary": "", "quote": "Meanwhile, rival ClickUp raised $400 million in new funding last month.",
                 "significance": 0.9}


def make_watch(n=7):
    ids = list(COMPETITORS)[:n]
    company = CompanyBrief(company_id="acme-tasks", name="Acme Tasks", category="project management software")
    return MarketWatch(watch_id=MarketWatch.make_id("acme-tasks"), company=company, created_at=T0,
                       competitors=[CompetitorCandidate(entity_id=i, name=COMPETITORS[i]) for i in ids])


def news(entity, markdown, minutes=0, url=None, source_type="news", status="ok"):
    at = T0 + timedelta(minutes=minutes)
    url = url or "https://techcrunch.com/2026/09/20/{}-news".format(entity)
    h = hashlib.sha256(markdown.encode()).hexdigest()
    return EvidenceEnvelope(
        obs_id=make_obs_id(entity + "-news", url, at), run_id="run_fixture", source_id=entity + "-news",
        entity_id=entity, entity_name=COMPETITORS.get(entity, entity.title()), source_type=source_type, url=url,
        fetched_at=at, status=status, parser_version="fixture-v1", content_hash=h,
        section_hashes={"article": h}, structured={"title": "Article about " + entity, "query": "q"},
        markdown=markdown if status == "ok" else None)


class FakeMarketLiquid(FakeLiquid):
    """Canned developments per URL. Counts every model call by purpose."""

    def __init__(self, canned=None, copy=None):
        super().__init__()
        self.canned, self.copy = canned or {}, copy
        self.dev_calls = self.copy_calls = 0

    def _record(self, purpose):
        return ModelCallRecord(call_id="{}{}".format(purpose, self.dev_calls + self.copy_calls), run_id="r",
                               purpose=purpose, model="fake", input_tokens=500, output_tokens=50, latency_ms=1,
                               ok=True)

    def extract_developments(self, e, company, entity_name, run_id):
        self.dev_calls += 1
        return list(self.canned.get(e.url, [])), self._record("extract_developments")

    def write_market_copy(self, payload, run_id):
        self.copy_calls += 1
        return (self.copy(payload) if self.copy else None), self._record("storyboard")


@pytest.fixture
def repo(tmp_path):
    return StateRepository(str(tmp_path / "state.db"))


# --- routing ------------------------------------------------------------------------------------------------------

def test_news_row_never_triggers_pricing_extraction(repo):
    e = news("asana", ASANA_MD)
    liquid = FakeMarketLiquid({e.url: [GOOD]})
    result = MarketCycle(repo, liquid, make_watch(), use_liquid_copy=False).run([e], now=T0)
    assert liquid.extract_calls == 0 and liquid.dev_calls == 1
    assert [d.headline for d in result.new_developments] == [GOOD["headline"]]

    # Without a MarketWatch the pricing coordinator records news rows but sends them to no model at all.
    src, plain = ListSource(), FakeMarketLiquid()
    src.add(news("asana", ASANA_MD, minutes=5))
    Coordinator(StateRepository(":memory:"), src, plain, use_liquid_copy=False).run_cycle(T0)
    assert plain.extract_calls == 0 and plain.dev_calls == 0


def test_pricing_rows_still_take_the_pricing_path_in_a_market_cycle(repo):
    liquid = FakeMarketLiquid()
    p = pricing_env("notion", {"Free": 0, "Plus": 10})
    result = MarketCycle(repo, liquid, make_watch(), use_liquid_copy=False).run([p], now=T0)
    assert liquid.extract_calls == 1 and liquid.dev_calls == 0
    assert repo.get_belief(belief_key("notion", "pricing.plus.monthly_usd")).value == 10
    assert result.record is not None  # a quiet storyboard: nothing notable yet


# --- grounding ------------------------------------------------------------------------------------------------------

def test_grounding_keeps_verbatim_quote_despite_markup():
    e = news("asana", ASANA_MD)
    kept, rejected = ground_developments(e, [GOOD], COMPETITORS.values())
    assert len(kept) == 1 and not rejected
    d = kept[0]
    assert d.kind == DevelopmentKind.launch and d.source_name == "TechCrunch" and d.evidence_id == e.obs_id
    assert d.development_id == MarketDevelopment.make_id("asana", GOOD["headline"])
    assert d.observed_at == e.fetched_at and d.published_at.date().isoformat() == "2026-09-20"


def test_grounding_rejects_paraphrase_and_other_company():
    e = news("asana", ASANA_MD)
    kept, rejected = ground_developments(e, [PARAPHRASED, OTHER_COMPANY, dict(GOOD, headline="")],
                                         COMPETITORS.values())
    assert kept == []
    assert any("not verbatim" in r for r in rejected)
    assert any("not Asana" in r for r in rejected)
    assert any("empty headline" in r for r in rejected)
    # A development about another company is dropped even when Liquid labels it with the right entity.
    kept, _ = ground_developments(e, [dict(OTHER_COMPANY, entity="Asana")], COMPETITORS.values())
    assert kept == []


def test_quote_needs_substance_and_source_names():
    assert not quote_in("Asana on Tuesday", ASANA_MD)                       # too short to prove anything
    assert not quote_in("Asana on Tuesday ... AI agents inside their workflows", ASANA_MD)  # elided
    assert quote_in("“The company said AI Studio is available today to all Enterprise customers”", ASANA_MD)
    assert source_name("https://www.theverge.com/x") == "The Verge"
    assert source_name("https://blog.asana.com/2026/ai") == "Asana"
    assert source_name("https://news.example.co.uk/a") == "Example"
    assert normalize_kind("feature_release") == DevelopmentKind.launch
    assert normalize_kind("Series C round") == DevelopmentKind.other
    assert normalize_kind("raise") == DevelopmentKind.funding


# --- state -------------------------------------------------------------------------------------------------------------

def test_unchanged_article_skips_liquid_and_developments_become_beliefs(repo):
    watch, url = make_watch(), "https://techcrunch.com/2026/09/20/asana-ai-studio"
    liquid = FakeMarketLiquid({url: [GOOD]})
    cycle = MarketCycle(repo, liquid, watch, use_liquid_copy=False)

    r1 = cycle.run([news("asana", ASANA_MD, url=url)], now=T0)
    assert liquid.dev_calls == 1 and r1.skipped_unchanged == 0 and r1.liquid_calls == 1
    dev = r1.new_developments[0]
    b = repo.get_belief(belief_key("asana", "developments." + dev.development_id))
    assert b.status == BeliefStatus.active and b.value["headline"] == GOOD["headline"]
    assert [d.development_id for d in r1.developments] == [dev.development_id]
    queued = [e for e in repo.undelivered() if e.table == TABLES["development"]]
    assert len(queued) == 1 and queued[0].payload["watch_id"] == watch.watch_id

    # Same article, fetched again an hour later: no model call, the development is confirmed.
    r2 = cycle.run([news("asana", ASANA_MD, minutes=60, url=url)], now=T0 + timedelta(hours=1))
    assert liquid.dev_calls == 1 and r2.skipped_unchanged == 1 and r2.liquid_calls == 0
    assert r2.new_developments == []
    b2 = repo.get_belief(b.belief_key)
    assert b2.last_confirmed_at == T0 + timedelta(minutes=60) and len(b2.evidence_ids) == 2
    assert len([e for e in repo.undelivered() if e.table == TABLES["development"]]) == 1
    ops = [op for e in repo.undelivered() if e.table == TABLES["patch"]
           for op in Patch.model_validate_json(e.payload["patch_json"]).ops]
    assert [o.op for o in ops] == [OpType.add, OpType.confirm]

    # Blocked fetches never reach Liquid.
    r3 = cycle.run([news("asana", ASANA_MD, minutes=120, url=url, status="blocked")], now=T0 + timedelta(hours=2))
    assert r3.run.pages_invalid == 1 and liquid.dev_calls == 1


def test_validator_price_checks_only_apply_to_pricing(repo):
    e = news("asana", ASANA_MD)
    repo.record_observation(e)
    dev = ground_developments(e, [GOOD], COMPETITORS.values())[0][0]
    value = dict(dev.model_dump(mode="json"), significance=0.8)
    attr = "developments." + dev.development_id

    def check(**kw):
        op = PatchOp(**dict(dict(op=OpType.add, belief_key=belief_key("asana", attr), entity_id="asana",
                                 attribute=attr, after=value, confidence=0.8, significance=0.8,
                                 evidence_ids=[e.obs_id], reason="t"), **kw))
        p = Patch(patch_id=Patch.make_id(repo.version, [e.obs_id], [op]), run_id="r",
                  base_state_version=repo.version, origin=PatchOrigin.liquid, ops=[op], observed_at=T0)
        return PatchValidator(repo).validate(p).rejected_reasons

    assert check() == []
    assert any("does not match" in r for r in check(after=dict(value, development_id="dev_other")))
    assert any("must be an object" in r for r in check(after=250000))
    # numeric sanity is for prices only: a big number on a non-pricing attribute is not "out of range"
    assert check(attribute="jobs.engineering.count", belief_key="asana:jobs.engineering.count", after=250000) == []


# --- storyboard -----------------------------------------------------------------------------------------------------------

KINDS = ["launch", "funding", "pricing", "partnership", "hiring", "acquisition", "leadership"]


def devs(n):
    out = []
    for i, (eid, name) in enumerate(list(COMPETITORS.items())[:n]):
        headline = "{} announces a {} move affecting teams that plan projects across many departments".format(
            name, KINDS[i])
        out.append(MarketDevelopment(
            development_id=MarketDevelopment.make_id(eid, headline), entity_id=eid, entity_name=name,
            kind=KINDS[i], headline=headline, summary="{} did something notable.".format(name),
            quote="{} said this is a notable change.".format(name), evidence_id="obs_{}".format(eid),
            url="https://techcrunch.com/{}".format(eid), source_name="TechCrunch",
            observed_at=T0 - timedelta(days=i), significance=round(0.9 - i * 0.05, 2)))
    return out


def check_storyboard(sb, watch):
    VideoStoryboard.model_validate(sb.model_dump(mode="json"))       # the contract's validators
    t = 0
    for s in sb.scenes:
        assert s.timing.startMs == t and MIN_SCENE_MS <= s.timing.durationMs <= MAX_SCENE_MS
        t += s.timing.durationMs
        assert len(s.narration.split()) <= s.timing.durationMs / 1000 * WORDS_PER_SECOND
        assert all(len(o.text) <= 120 for o in s.onScreenText)
        low = s.visualPrompt.lower()
        assert "no text, letters, numbers or logos" in low
        for name in list(watch.entity_names().values()):
            assert name.lower() not in low, (s.id, name)
        assert not any(ch.isdigit() for ch in s.visualPrompt), s.id
        if s.id.startswith("dev-"):
            assert len(s.evidenceIds) == 1 and s.onScreenText[1].text.startswith("Source: ")
    assert sb.scenes[0].id == "title" and sb.scenes[-1].id == "outro"


@pytest.mark.parametrize("n", [0, 1, 4, 7])
def test_storyboard_rules_for_any_number_of_developments(n):
    watch = make_watch()
    sb, refs = compose_market_storyboard(watch, devs(n), T0, checked_evidence_ids=["obs_a", "obs_b"])
    check_storyboard(sb, watch)
    dev_scenes = [s for s in sb.scenes if s.id.startswith("dev-")]
    assert len(dev_scenes) == min(n, 4)
    if n:
        assert [s.id for s in sb.scenes] == ["title"] + ["dev-{}".format(i + 1) for i in range(min(n, 4))] + [
            "implications", "outro"]
        impl = next(s for s in sb.scenes if s.id == "implications")
        assert impl.evidenceIds == [s.evidenceIds[0] for s in dev_scenes]
        assert "Acme Tasks" in impl.narration or "Acme Tasks" in impl.onScreenText[0].text
        assert sb.patchIds == [d.development_id for d in devs(n)][:4]      # most significant first
        assert {r.obs_id for r in refs} == set(sb.evidence_ids())
    else:
        assert [s.id for s in sb.scenes] == ["title", "quiet", "outro"]
        assert sb.scenes[1].evidenceIds == ["obs_a", "obs_b"]
    # deterministic id; no evidence at all still gives a valid (outro-style) quiet storyboard
    assert compose_market_storyboard(watch, devs(n), T0, checked_evidence_ids=["obs_a", "obs_b"])[0].id == sb.id
    quiet, _ = compose_market_storyboard(watch, [], T0)
    check_storyboard(quiet, watch)


def test_storyboard_prefers_different_competitors():
    watch = make_watch()
    d = devs(3)
    extra = [MarketDevelopment(**dict(d[0].model_dump(), development_id="dev_x{}".format(i), significance=0.99,
                                      headline="Asana second headline {}".format(i))) for i in range(3)]
    sb, _ = compose_market_storyboard(watch, d + extra, T0)
    firsts = [s.onScreenText[0].text for s in sb.scenes if s.id.startswith("dev-")]
    assert len(firsts) == 4 and firsts[1].startswith("ClickUp") and firsts[2].startswith("Monday.com")


def test_copywriter_may_only_rephrase():
    watch = make_watch()

    def honest(payload):
        return {"lines": {f["id"]: "{} made a {} move.".format(f["entity"], f["kind"]) for f in payload["developments"]},
                "implication": "Acme Tasks should watch Asana closely."}

    def inventive(payload):
        return {"lines": {f["id"]: "{} raised 50 million from Sequoia.".format(f["entity"])
                          for f in payload["developments"]},
                "implication": "Acme Tasks will lose 30 percent of customers to Google."}

    sb, _ = compose_market_storyboard(watch, devs(2), T0, copywriter=honest)
    assert sb.scenes[1].narration == "Asana made a launch move."
    assert sb.scenes[3].narration == "Acme Tasks should watch Asana closely."
    sb2, _ = compose_market_storyboard(watch, devs(2), T0, copywriter=inventive)
    assert "Sequoia" not in sb2.scenes[1].narration and "30" not in sb2.scenes[3].narration
    check_storyboard(sb2, watch)


def test_storyboard_record_is_stored_and_queued(repo):
    url = "https://techcrunch.com/2026/09/20/asana-ai-studio"
    watch = make_watch()
    liquid = FakeMarketLiquid({url: [GOOD]}, copy=lambda p: {"lines": {}, "implication": ""})
    cycle = MarketCycle(repo, liquid, watch)
    r = cycle.run([news("asana", ASANA_MD, url=url), news("wrike", "Wrike posted nothing new today at all.")],
                  now=T0)
    assert r.record is not None and r.storyboard.id == r.record.storyboard_id
    assert liquid.copy_calls == 1 and r.liquid_calls == 3                 # 2 extractions + 1 copy
    stored = repo.get_video_storyboard(r.record.storyboard_id)
    assert stored == r.record and repo.latest_video_storyboard(watch.watch_id) == r.record
    assert stored.storyboard() == r.storyboard and stored.watch_id == watch.watch_id
    assert stored.development_ids == r.new_developments[0].development_id
    ev = stored.evidence()
    assert ev[0].url == url and ev[0].title == "Article about asana" and ev[0].source_name == "TechCrunch"
    queued = [e for e in repo.undelivered() if e.table == TABLES["video_storyboard"]]
    assert len(queued) == 1 and queued[0].event_id == "media:" + r.record.storyboard_id
    assert VideoStoryboardRecord(**queued[0].payload).storyboard() == r.storyboard

    # Same facts next cycle: same storyboard id, no copy call, nothing new queued.
    r2 = cycle.run([news("asana", ASANA_MD, minutes=30, url=url)], now=T0 + timedelta(minutes=30))
    assert r2.record.storyboard_id == r.record.storyboard_id and liquid.copy_calls == 1
    assert len([e for e in repo.undelivered() if e.table == TABLES["video_storyboard"]]) == 1


# --- sources ----------------------------------------------------------------------------------------------------------------

def test_row_to_envelope_folds_structured_and_section_hashes():
    e = news("asana", ASANA_MD)
    row = {k: v for k, v in e.model_dump(mode="json").items() if k not in ("structured", "section_hashes")}
    row.update({"structured.title": "AI Studio", "structured.query": "asana news",
                "structured.search_description": "Asana launched...", "structured.entity_type": "competitor",
                "structured.unused": None, "section_hashes.article": "abc", "section_hashes.pricing": ""})
    got = row_to_envelope(row)
    assert got.structured == {"title": "AI Studio", "query": "asana news",
                              "search_description": "Asana launched...", "entity_type": "competitor"}
    assert got.section_hashes == {"article": "abc"}
    row = {k: v for k, v in row.items() if not k.startswith("structured.")}
    assert row_to_envelope(row).structured is None


# --- liquid adapter (no network: _call is stubbed) -------------------------------------------------------------------

def test_extract_developments_trims_article_and_retries_unparseable_reply(monkeypatch):
    from core.liquid import LiquidAdapter, article_window
    window = article_window(ASANA_MD, "Asana")
    assert "Sign in" not in window and "[Home]" not in window and "Subscribe" not in window
    assert "on Tuesday launched AI Studio" in window                  # link reduced to its text
    replies = iter(["I think the answer is", '```json\n{"developments": [%s]}\n```' % __import__("json").dumps(GOOD)])
    prompts = []

    def fake_call(self, prompt, run_id, purpose, max_tokens):
        prompts.append(prompt)
        return next(replies), ModelCallRecord(call_id=str(len(prompts)), run_id=run_id, purpose=purpose,
                                              model="fake", input_tokens=100, output_tokens=10, latency_ms=5, ok=True)
    monkeypatch.setattr(LiquidAdapter, "_call", fake_call)
    watch = make_watch()
    got, call = LiquidAdapter("k").extract_developments(news("asana", ASANA_MD), watch.company, "Asana", "r")
    assert len(prompts) == 2 and got == [GOOD] and call.input_tokens == 200
    assert "Asana" in prompts[0] and "Acme Tasks" in prompts[0] and "Sign in" not in prompts[0]


def test_headline_gets_entity_name_and_release_wording_is_a_launch():
    e = news("asana", ASANA_MD)
    raw = dict(GOOD, headline="AI Studio now lets teams build workflow agents", kind="other")
    d = ground_developments(e, [raw], COMPETITORS.values())[0][0]
    assert d.headline == "Asana: AI Studio now lets teams build workflow agents" and d.kind == DevelopmentKind.launch
