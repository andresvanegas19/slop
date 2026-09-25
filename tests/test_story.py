"""Competitor research (Nimble), the storyline tool and first-prompt company detection, offline: a fake Nimble
extractor + DNS resolver, robots.txt behind httpx.MockTransport and a scripted fake Liquid."""
import json
import socket
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

import httpx
import pytest
from langchain_core.messages import AIMessage

import agent.config as agent_config
from acquisition.nimble import NimbleResult
from agent.competitors import mentions, name_terms, watch_peers
from agent.config import load_settings
from agent.nimble_fetch import NimbleFetcher, make_fetcher, page_from_result
from agent.react import CompanyAgent
from agent.research import ResearchManager
from agent.research_store import ResearchStore
from agent.store import AgentStore
from agent.story_api import StoryService, rule_company
from agent.storyline import edit_storyline
from agent.web import USER_AGENT, FetchError, WebFetcher
from agent.worker import AgentWorker, serve
from contracts.research import (CompanyProfile, Finding, ResearchIntent, ResearchSessionState, ResearchStatus,
                                SourcedText, VisualIdentity)

NOW = datetime.now(timezone.utc)
HOME = "https://www.acmecola.com/"
FIZZ = "https://www.fizzco.com"
FIZZ_HOME_QUOTE = "Fizz Co delivers sparkling water to 5,000 offices every week."
FIZZ_PRICING_QUOTE = "Plans start at $29 per month for small offices."
FIZZ_PAGES = {
    FIZZ + "/": """<html><head><title>Fizz Co | Sparkling water for offices</title>
        <meta name="description" content="Sparkling water delivered to your office."></head><body>
        <nav><a href="/pricing">Pricing</a><a href="/about">About us</a><a href="/blog/post-1">Blog</a></nav>
        <h1>Office hydration, sorted</h1><p>{}</p></body></html>""".format(FIZZ_HOME_QUOTE),
    FIZZ + "/pricing": """<html><head><title>Pricing</title></head><body><h1>Pricing</h1><p>{}</p></body></html>"""
    .format(FIZZ_PRICING_QUOTE),
    FIZZ + "/about": "<html><body><p>Fizz Co was founded in Denver.</p></body></html>",
}
FIZZ_ROBOTS = "User-agent: *\nDisallow: /about\n"

TEMPLATES = [
    {"id": "ad", "label": "Ad", "description": "Product ad", "roles": [
        {"type": "hook", "goal": "grab attention"}, {"type": "product", "goal": "show the product"},
        {"type": "benefit", "goal": "main benefit"}, {"type": "cta", "goal": "call to action"}]},
    {"id": "competitive", "label": "Competitive", "description": "Why choose us, no competitor names", "roles": [
        {"type": "problem", "goal": "the problem buyers face"}, {"type": "approach", "goal": "our approach"},
        {"type": "differentiator", "goal": "what only we do"}, {"type": "proof", "goal": "proof"},
        {"type": "cta", "goal": "call to action"}]},
]


def finding(n, topic, claim, url=HOME):
    return Finding(finding_id="f_acme{}".format(n), topic=topic, claim=claim, evidence_url=url, quote=claim,
                   found_at=NOW)


def acme_state(sid="test_research_acme", prompt="Make an ad for Acme Cola that shows why we're better than the "
               "competition", created_at=None, is_test=True) -> ResearchSessionState:
    f1 = finding(1, "about", "Acme Cola is brewed locally in Springfield since 1921", HOME + "about")
    f2 = finding(2, "product", "Acme Classic, Acme Zero and Fizzy Lime are our three drinks", HOME + "brands")
    f3 = finding(3, "proof", "Our 400 employees brew every batch locally", HOME + "about")
    profile = CompanyProfile(
        session_id=sid, name="Acme Cola", domain="acmecola.com",
        one_line=SourcedText(text="Springfield's soda maker since 1921.", finding_ids=[f1.finding_id]),
        what_they_do=SourcedText(text="Makes sodas for families.", finding_ids=[f1.finding_id]),
        products=[SourcedText(text="Acme Classic and Acme Zero", finding_ids=[f2.finding_id])],
        key_messages=[SourcedText(text="Bringing people together", finding_ids=[f1.finding_id])],
        brand_voice=SourcedText(text="warm, local, cheerful"), proof_points=[f3],
        visual_identity=VisualIdentity(imagery_style="sunny small-town family moments"), updated_at=NOW)
    return ResearchSessionState(
        session_id=sid, prompt=prompt, created_at=created_at or datetime.now(timezone.utc), updated_at=NOW,
        status=ResearchStatus.done,
        looping=False, intent=ResearchIntent(company_name="Acme Cola", likely_domain="acmecola.com",
                                             video_goal="an ad"),
        domain="acmecola.com", home_url=HOME, findings=[f1, f2, f3], profile=profile, is_test=is_test)


class FakeLiquid:
    """Routes on the [task:...] marker of each prompt."""

    def __init__(self, detect=None, delay_s=0.0):
        self.calls, self.detect, self.delay_s = [], detect, delay_s

    def invoke(self, messages, stop=None):
        text = "\n".join(str(m.content) for m in messages)
        self.calls.append(text[: text.index("]") + 1] if "]" in text else text[:20])
        if self.delay_s:
            time.sleep(self.delay_s)
        return AIMessage(content=self.reply(text),
                         usage_metadata={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15})

    def reply(self, text):
        if "[task:detect]" in text:
            return json.dumps(self.detect or {"company_name": None, "likely_domain": None, "video_goal": "a clip"})
        if "[task:competitors]" in text:
            return "```json\n" + json.dumps({"competitors": [
                {"name": "Acme Cola", "domain": "acmecola.com", "reason": "itself"},
                {"name": "Ghost Soda", "domain": "ghostsoda.com", "reason": "imaginary"},
                {"name": "Fizz Co", "domain": "fizzco.com", "reason": "sparkling drinks for the same buyers"}]}) + "\n```"
        if "[task:competitor_extract]" in text:
            items = [{"topic": "pricing" if q == FIZZ_PRICING_QUOTE else "audience", "claim": q, "quote": q}
                     for q in (FIZZ_HOME_QUOTE, FIZZ_PRICING_QUOTE) if q in text]
            items.append({"topic": "proof", "claim": "made up", "quote": "Fizz Co is the best soda in the universe."})
            return json.dumps({"summary": "Sparkling water delivery for offices.", "findings": items})
        if "[task:landscape]" in text:
            return json.dumps({"differentiators": [
                {"text": "Brewed locally in Springfield since 1921", "findings": ["F1"]},
                {"text": "Unlike Fizz Co, we care about taste", "findings": ["F1"]},
                {"text": "Invented claim", "findings": ["F99"]}],
                "competitor_themes": ["office delivery subscriptions", "Fizz Co pricing"]})
        if "[task:storyline]" in text:
            return json.dumps({
                "template": "competitive", "reason": "the user asked why we are better", "title": "Local since 1921",
                "logline": "A town's own soda, brewed with care.", "tone": "warm, proud", "audience": "families",
                "call_to_action": "Taste Acme today", "beats": [
                    {"message": "Most sodas taste like they came from nowhere.", "visual":
                        "a plain unbranded can on a grey counter, flat light", "findings": []},
                    {"message": "Better than Fizz Co in every way.", "visual":
                        "a brewer stirring a copper kettle, warm steam, morning light", "findings": ["F1"]},
                    {"message": "Brewed locally in Springfield since 1921.", "visual":
                        "a small-town main street at golden hour, families walking", "findings": ["F1", "f_bogus"]},
                    {"message": "400 neighbours brew every batch.", "visual":
                        "workers smiling on a bottling line, soft daylight", "findings": ["F3"]},
                    {"message": "Taste Acme today.", "visual": "x", "findings": []}]})
        return "{}"


@pytest.fixture(autouse=True)
def no_env_file(monkeypatch):
    monkeypatch.setattr(agent_config, "load_env", lambda _path: None)
    for name in ("NIMBLE_API_KEY", "RESEARCH_FETCHER", "RESEARCH_MAX_COMPETITORS", "RESEARCH_COMPETITOR_PAGES",
                 "RESEARCH_DETECT_TIMEOUT_S"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def settings(tmp_path):
    return load_settings(state_db=str(tmp_path / "state.db"), agent_db=str(tmp_path / "agent.db"),
                         openrouter_key="", rawtree_key="")


def fizz_fetcher(extracted=None):
    """NimbleFetcher over the fixture sites: Nimble is the injected extractor, robots.txt comes from MockTransport."""
    extracted = [] if extracted is None else extracted

    def robots(request: httpx.Request):
        assert request.headers["user-agent"] == USER_AGENT
        if request.url.path == "/robots.txt" and request.url.host == "www.fizzco.com":
            return httpx.Response(200, text=FIZZ_ROBOTS, headers={"content-type": "text/plain"})
        return httpx.Response(404, text="")

    def extractor(url):
        extracted.append(url)
        html = FIZZ_PAGES.get(url.rstrip("/") + ("/" if url.rstrip("/") == FIZZ else ""))
        if html is None:
            return NimbleResult(url=url, http_status=404, html="<html><body>Not found</body></html>")
        return NimbleResult(url=url, http_status=200, html=html)

    client = httpx.Client(transport=httpx.MockTransport(robots), headers={"User-Agent": USER_AGENT})
    return NimbleFetcher("test-key", client=client, extractor=extractor,
                         resolver=lambda host: host.endswith("fizzco.com"))


def service_for(settings, llm=True, extracted=None, auto=False, detect=None, delay_s=0.0):
    manager = ResearchManager(settings, ResearchStore(settings.agent_db))
    fake = FakeLiquid(detect=detect, delay_s=delay_s)
    service = StoryService(settings, manager, llm_factory=(lambda: fake) if llm else None,
                           fetcher_factory=lambda: fizz_fetcher(extracted), auto=auto)
    return service, manager, fake


def wait_job(service, sid, timeout=20):
    service.jobs[sid].join(timeout)
    assert not service.jobs[sid].is_alive()


# --- Nimble fetcher -----------------------------------------------------------------------------------------------
def test_page_from_result_prefers_html_and_fills_thin_text_from_markdown():
    long_md = "# Acme\n\n" + "Acme makes sodas for everyone in town. " * 40 + "\n[Pricing](https://www.acme.com/p)"
    page = page_from_result("https://www.acme.com/", NimbleResult(
        url="u", http_status=200, html="<html><head><title>Acme</title></head><body><a href='/x'>X</a>"
                                       "<p>short</p></body></html>", markdown=long_md))
    assert page.title == "Acme" and page.text.startswith("# Acme") and ("https://www.acme.com/x", "X") in page.links
    md = page_from_result("https://www.acme.com/", NimbleResult(url="u", http_status=200, markdown=long_md))
    assert md.title == "Acme" and md.headings == ["Acme"] and ("https://www.acme.com/p", "Pricing") in md.links
    with pytest.raises(FetchError):
        page_from_result("https://www.acme.com/", NimbleResult(url="u", error="blocked"))


def test_nimble_fetcher_keeps_allowlist_dns_and_robots_checks():
    extracted = []
    fetcher = fizz_fetcher(extracted)
    page = fetcher.fetch(FIZZ + "/", allowed=lambda url: "fizzco.com" in url)
    assert page.status == 200 and FIZZ_HOME_QUOTE in page.text and extracted == [FIZZ + "/"]
    with pytest.raises(FetchError, match="not allowed"):
        fetcher.fetch("https://evil.example.com/", allowed=lambda url: "fizzco.com" in url)
    with pytest.raises(FetchError, match="does not resolve"):
        fetcher.fetch("https://www.ghostsoda.com/")
    with pytest.raises(FetchError, match="robots"):
        fetcher.fetch(FIZZ + "/about")
    assert extracted == [FIZZ + "/"]  # nothing refused above cost a Nimble call


def test_make_fetcher_modes(monkeypatch):
    assert type(make_fetcher()) is WebFetcher  # auto without a key: direct fetch
    monkeypatch.setenv("NIMBLE_API_KEY", "k")
    assert isinstance(make_fetcher(), NimbleFetcher)
    monkeypatch.setenv("RESEARCH_FETCHER", "direct")
    assert type(make_fetcher()) is WebFetcher
    monkeypatch.setenv("RESEARCH_FETCHER", "nimble")
    monkeypatch.delenv("NIMBLE_API_KEY")
    with pytest.raises(FetchError, match="NIMBLE_API_KEY"):
        make_fetcher()


# --- names ----------------------------------------------------------------------------------------------------------
def test_mentions_and_name_terms(tmp_path):
    terms = name_terms("Fizz Co", "fizzco.com")
    assert {"fizz co", "fizzco.com", "fizzco", "fizz"} <= {t.lower() for t in terms}
    assert mentions("Try FIZZ-CO today", ["Fizz Co"]) == ["Fizz Co"]
    assert mentions("Visit fizzco.com now", terms)
    assert mentions("fizzy lemonade", ["Fizz"]) == []
    watch = tmp_path / "watch.yaml"
    watch.write_text("sources:\n- entity_id: notion\n  entity_name: Notion\n  seed_url: https://www.notion.com/pricing\n"
                     "- entity_id: linear\n  entity_name: Linear\n  seed_url: https://linear.app/pricing\n")
    assert watch_peers(str(watch), "Notion") == [{"name": "Linear", "domain": "linear.app",
                                                  "reason": "tracked competitor in config/watch.yaml"}]
    assert watch_peers(str(watch), "Acme Cola") == []


# --- competitor research -------------------------------------------------------------------------------------------
def test_competitor_research_verifies_grounds_and_never_names(settings):
    extracted = []
    service, manager, fake = service_for(settings, extracted=extracted)
    st = acme_state()
    manager.store.save(st)
    before = manager.store.events(st.session_id)
    assert service.start_competitors(st.session_id)["started"] is True
    wait_job(service, st.session_id)
    view = service.competitors_view(st.session_id)
    assert view["status"] == "done"
    assert [c["name"] for c in view["competitors"] if c["verified"]] == ["Fizz Co"]
    assert "Acme Cola" not in [c["name"] for c in view["competitors"]]
    assert all("ghostsoda" not in url and not url.endswith("/about") for url in extracted)  # DNS + robots first
    fizz = next(c for c in view["competitors"] if c["name"] == "Fizz Co")
    assert set(fizz["claims"]) == {FIZZ_HOME_QUOTE, FIZZ_PRICING_QUOTE}  # the made-up quote was rejected
    assert "quote" not in json.dumps(fizz)
    assert view["differentiators"] == ["Brewed locally in Springfield since 1921"]
    assert view["competitor_themes"] == ["office delivery subscriptions"]
    assert {"Fizz Co", "fizzco.com", "fizzco"} <= set(view["avoid_terms"])
    events = manager.store.events(st.session_id, after=len(before))
    types = {e["type"] for e in events}
    assert {"competitors", "competitor", "competitor_page"} <= types
    assert not types & {"status", "error", "page"}  # the company research's own status/pages stay untouched
    assert manager.store.load(st.session_id).status == ResearchStatus.done
    assert service.start_competitors(st.session_id)["started"] is False  # done: only force restarts it


def test_competitors_need_a_profile_and_a_session(settings):
    service, manager, _ = service_for(settings)
    st = acme_state()
    st.profile = None
    manager.store.save(st)
    with pytest.raises(ValueError):
        service.start_competitors(st.session_id)
    with pytest.raises(KeyError):
        service.start_competitors("research_missing")
    assert service.competitors_view(st.session_id)["status"] == "off"


def test_watcher_starts_competitors_for_new_sessions_only(settings):
    service, manager, _ = service_for(settings, auto=True)
    old = acme_state("research_old", created_at=datetime(2020, 1, 1, tzinfo=timezone.utc), is_test=False)
    new = acme_state("research_new", is_test=False)
    manager.store.save(old)
    manager.store.save(new)
    assert service.pending("research_new") and not service.pending("research_old")
    service.watch_once()
    assert set(service.jobs) == {"research_new"}
    wait_job(service, "research_new")
    assert not service.pending("research_new")
    service.watch_once()
    assert set(service.jobs) == {"research_new"}


# --- storyline -------------------------------------------------------------------------------------------------------
def test_storyline_uses_template_roles_facts_and_scrubs_competitors(settings):
    service, manager, fake = service_for(settings)
    st = acme_state()
    manager.store.save(st)
    service.start_competitors(st.session_id)
    wait_job(service, st.session_id)
    out = service.write(st.session_id, {"duration_sec": 15, "templates": TEMPLATES, "wait_s": 0})
    plan = out["storyline"]
    assert plan["template"] == "competitive" and len(plan["beats"]) == 5 and plan["version"] == 1
    assert [b["role"] for b in plan["beats"]] == ["problem", "approach", "differentiator", "proof", "cta"]
    text = json.dumps(plan["beats"]) + plan["title"] + plan["logline"] + plan["call_to_action"]
    assert not mentions(text, plan["avoid_terms"])
    assert plan["beats"][1]["message"] != "Better than Fizz Co in every way."  # replaced by a grounded fallback
    assert plan["beats"][2]["finding_ids"] == ["f_acme1"]  # F-labels mapped, unknown ids dropped
    assert plan["beats"][4]["visual"] != "x" and plan["source"] == "partial"
    assert service.storyline_view(st.session_id)["storyline"]["storyline_id"] == plan["storyline_id"]
    assert manager.store.events(st.session_id)[-1]["type"] == "storyline"

    again = service.write(st.session_id, {"duration_sec": 15, "templates": TEMPLATES, "template": "ad",
                                          "wait_s": 0})["storyline"]
    assert again["template"] == "ad" and len(again["beats"]) == 4 and again["version"] == 2


def test_storyline_without_liquid_is_deterministic(settings):
    service, manager, _ = service_for(settings, llm=False)
    st = acme_state()
    manager.store.save(st)
    service.start_competitors(st.session_id)
    wait_job(service, st.session_id)
    plan = service.write(st.session_id, {"duration_sec": 10, "templates": TEMPLATES, "wait_s": 0})["storyline"]
    assert plan["source"] == "fallback" and plan["model"] == "deterministic"
    assert service.competitors_view(st.session_id)["competitors"] == []  # no Liquid, not in watch.yaml: none
    assert plan["template"] == "ad"  # "competitive" needs a verified competitor
    assert len(plan["beats"]) == 4 and plan["beats"][-1]["message"] == "Visit acmecola.com"
    assert all(b["message"] and b["visual"] for b in plan["beats"])
    assert len({b["message"] for b in plan["beats"]}) == 4  # each fact used once
    hinted = service.write(st.session_id, {"duration_sec": 10, "templates": TEMPLATES, "template": "competitive",
                                           "wait_s": 0})["storyline"]
    assert hinted["template"] == "competitive" and len(hinted["beats"]) == 5


def test_storyline_edits_are_validated(settings):
    service, manager, _ = service_for(settings)
    st = acme_state()
    manager.store.save(st)
    service.start_competitors(st.session_id)
    wait_job(service, st.session_id)
    plan = service.write(st.session_id, {"duration_sec": 15, "templates": TEMPLATES, "wait_s": 0})["storyline"]
    sid = st.session_id
    assert service.handle("POST", "/research/{}/storyline".format(sid), {"edits": {"beats": [{}]}})[0] == 400
    beats = [{} for _ in plan["beats"]]
    beats[0] = {"message": "Switch from Fizz Co today"}
    status, body = service.handle("POST", "/research/{}/storyline".format(sid), {"edits": {"beats": beats}})
    assert status == 400 and "names a competitor" in body["error"]
    beats[0] = {"message": "Your town deserves its own soda."}
    status, body = service.handle("POST", "/research/{}/storyline".format(sid),
                                  {"edits": {"title": "Our soda", "beats": beats}})
    assert status == 200
    edited = body["storyline"]
    assert edited["version"] == 2 and edited["source"] == "user" and edited["title"] == "Our soda"
    assert edited["beats"][0]["message"] == "Your town deserves its own soda." and edited["beats"][0]["finding_ids"] == []
    with pytest.raises(ValueError):
        from contracts.story import StoryPlan
        edit_storyline(StoryPlan.model_validate(edited), {"logline": ""})


def test_storyline_request_validation(settings):
    service, manager, _ = service_for(settings)
    st = acme_state()
    manager.store.save(st)
    path = "/research/{}/storyline".format(st.session_id)
    assert service.handle("POST", path, {"duration_sec": 2, "templates": TEMPLATES})[0] == 400
    assert service.handle("POST", path, {"duration_sec": 15, "templates": [{"id": "ad", "roles": []}]})[0] == 400
    assert service.handle("POST", path, {"duration_sec": 15, "templates": TEMPLATES, "template": "nope"})[0] == 400
    assert service.handle("GET", path, None)[0] == 404  # nothing written yet
    assert service.handle("GET", "/research/research_missing/storyline", None)[0] == 404
    st.profile = None
    manager.store.save(st)
    assert service.handle("POST", path, {"duration_sec": 15, "templates": TEMPLATES, "wait_s": 0})[0] == 409
    assert service.handle("GET", "/research/{}/other".format(st.session_id), None) is None


def test_competitor_status_tells_the_app_whether_to_keep_following(settings):
    service, manager, _ = service_for(settings, auto=True)
    running = acme_state("research_running", is_test=False)
    running.profile, running.status = None, ResearchStatus.researching
    no_profile = acme_state("research_no_profile", is_test=False)
    no_profile.profile = None
    old = acme_state("research_old2", created_at=datetime(2020, 1, 1, tzinfo=timezone.utc), is_test=False)
    for st in (running, no_profile, old):
        manager.store.save(st)
    assert service.competitors_view("research_running")["status"] == "waiting"  # starts once it has a profile
    assert service.competitors_view("research_no_profile")["status"] == "none"  # done without one: never starts
    assert service.competitors_view("research_old2")["status"] == "none"  # predates this worker
    assert not service.pending("research_no_profile") and not service.pending("research_old2")


def test_storyline_failure_is_reported_and_unlocks(settings, monkeypatch):
    import agent.story_api as story_api
    service, manager, _ = service_for(settings)
    st = acme_state()
    manager.store.save(st)

    def boom(*args, **kwargs):
        raise KeyError("model output")
    monkeypatch.setattr(story_api, "write_storyline", boom)
    path = "/research/{}/storyline".format(st.session_id)
    status, body = service.handle("POST", path, {"duration_sec": 15, "templates": TEMPLATES, "wait_s": 0})
    assert status == 500 and "could not write the storyline" in body["error"]
    last = manager.store.events(st.session_id)[-1]
    assert last["type"] == "storyline" and last["stage"] == "error"
    assert not service.pending(st.session_id)


# --- detection --------------------------------------------------------------------------------------------------------
def test_rule_company():
    assert rule_company("Make an ad for Linear") == ("Linear", None)
    assert rule_company("haz un anuncio para Coca-Cola") == ("Coca-Cola", None)
    assert rule_company("a promo video for stripe.com payments") == ("Stripe", "stripe.com")
    assert rule_company("a video for Christmas morning") == (None, None)
    assert rule_company("a cat on the moon") == (None, None)


def test_detect_uses_liquid_but_only_trusts_names_in_the_prompt(settings):
    service, _, fake = service_for(settings, detect={"company_name": "Coca-Cola", "likely_domain": "coca-cola.com",
                                                     "video_goal": "a summer ad"})
    got = service.detect("quiero un comercial veraniego de Coca-Cola")
    assert got["company"] == "Coca-Cola" and got["likely_domain"] == "coca-cola.com" and got["source"] == "llm"
    assert got["video_goal"] == "a summer ad"
    fake.detect = {"company_name": "Pepsi", "likely_domain": "pepsi.com", "video_goal": "an ad"}
    got = service.detect("make an ad for my bakery")
    assert got["company"] is None and got["likely_domain"] is None
    calls = len(fake.calls)
    assert service.detect("a cat walking on the moon")["company"] is None
    assert len(fake.calls) == calls  # nothing that could name a company: no model call


def test_detect_falls_back_to_rules_without_or_with_a_slow_liquid(settings, monkeypatch):
    service, _, _ = service_for(settings, llm=False)
    assert service.detect("Make an ad for Linear") == {"company": "Linear", "likely_domain": None,
                                                       "video_goal": None, "source": "rules",
                                                       "elapsed_ms": pytest.approx(0, abs=1000)}
    monkeypatch.setenv("RESEARCH_DETECT_TIMEOUT_S", "1")
    slow, _, _ = service_for(settings, detect={"company_name": "Linear"}, delay_s=2.5)
    started = time.time()
    got = slow.detect("Make an ad for Linear")
    assert got["company"] == "Linear" and got["source"] == "rules" and time.time() - started < 2.2


# --- HTTP -------------------------------------------------------------------------------------------------------------
def _port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _req(port, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request("http://127.0.0.1:{}{}".format(port, path), data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def test_http_routes(settings):
    service, manager, _ = service_for(settings, detect={"company_name": "Linear", "likely_domain": "linear.app",
                                                        "video_goal": "an ad"})
    store = AgentStore(settings.agent_db)
    worker = AgentWorker(settings, CompanyAgent(settings, None, store=store), store, research=manager, story=service)
    st = acme_state()
    manager.store.save(st)
    port = _port()
    server = serve(worker, port)
    sid = st.session_id
    try:
        status, raw = _req(port, "POST", "/research/detect", {"prompt": "Make an ad for Linear"})
        assert status == 200 and json.loads(raw)["company"] == "Linear"
        assert _req(port, "POST", "/research/detect", {"prompt": ""})[0] == 400
        assert json.loads(_req(port, "GET", "/research/{}/competitors".format(sid))[1])["status"] == "off"
        status, raw = _req(port, "POST", "/research/{}/competitors".format(sid), {})
        assert status == 202 and json.loads(raw)["started"] is True
        wait_job(service, sid)
        assert json.loads(_req(port, "GET", "/research/{}/competitors".format(sid))[1])["status"] == "done"
        status, raw = _req(port, "POST", "/research/{}/storyline".format(sid),
                           {"duration_sec": 15, "templates": TEMPLATES, "wait_s": 0})
        assert status == 200 and len(json.loads(raw)["storyline"]["beats"]) == 5
        view = json.loads(_req(port, "GET", "/research/" + sid)[1])
        assert view["storyline"]["template"] == "competitive" and view["competitors"]["status"] == "done"
        status, raw = _req(port, "GET", "/research/{}/events?after=0&follow=0".format(sid))
        assert status == 200 and any(json.loads(line)["type"] == "storyline" for line in raw.splitlines())
        assert _req(port, "GET", "/research/research_missing/storyline")[0] == 404
        assert _req(port, "POST", "/research/research_missing/competitors", {})[0] == 404
        health = json.loads(_req(port, "GET", "/health")[1])
        assert health["story"]["fetcher"] == "direct" and health["story"]["running"] == 0
        assert _req(port, "POST", "/research/{}/answer".format(sid), {"question_id": "q_x", "answer": "y"})[0] == 404
    finally:
        server.shutdown()
        worker.pool.shutdown(wait=False, cancel_futures=True)
