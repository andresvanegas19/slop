"""Offline tests for market acquisition: prompt -> competitors -> pages. Recorded Nimble Search responses live
in tests/fixtures/nimble_search; the pipeline tests use fake search/extract objects. No network."""
import asyncio
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

from acquisition import discovery as d
from acquisition.content import (Entity, Planned, collect_market_content, envelope_for, market_hint, round_robin,
                                 time_range_for)
from acquisition.nimble import NimbleResult
from acquisition.search import SearchHit, host_of, is_low_value, normalize_url, parse_results
from contracts import CompanyBrief, CompetitorCandidate, RetrievalStatus, SourceType

FIXTURES = Path(__file__).parent / "fixtures" / "nimble_search"
NOW = datetime(2026, 9, 25, tzinfo=timezone.utc)
ARTICLE = "# Trello launches AI boards\n\n" + "Trello today announced AI boards for every plan. " * 40


def recorded(name: str) -> list[SearchHit]:
    doc = json.loads((FIXTURES / (name + ".json")).read_text())
    return parse_results(doc["response"], doc["request"]["query"])


def hit(url, title="", description="", query="q", entity_type="OrganicResult", position=1):
    return SearchHit(title=title, url=url, description=description, position=position, entity_type=entity_type,
                     query=query)


class FakeSearch:
    """Answers by first matching rule (query substring -> hits); records every call."""
    def __init__(self, rules=()):
        self.rules, self.calls = list(rules), []

    async def search(self, query, focus="general", max_results=10, time_range=None, include_domains=None,
                     exclude_domains=None):
        self.calls.append(dict(query=query, focus=focus, time_range=time_range, include_domains=include_domains))
        for needle, hits in self.rules:
            if needle(query, include_domains) if callable(needle) else needle in query:
                return [h for h in hits][:max_results]
        return []


class FakeNimble:
    def __init__(self, pages):
        self.pages, self.urls = pages, []

    async def extract(self, url, render=True, driver=None, country=None, locale=None, wait_ms=0):
        self.urls.append(url)
        markdown, status = self.pages.get(url, ("", 404))
        return NimbleResult(url=url, fetched_at=NOW, http_status=status, markdown=markdown,
                            raw={"status": "success"}, task_id="t1")


def asana() -> CompanyBrief:
    return CompanyBrief(company_id="asana", name="Asana", domain="asana.com", category="project management software")


# --- prompt parsing (no LLM) ---

@pytest.mark.parametrize("prompt,name,category", [
    ("We're Acme, we make invoicing software for freelancers", "Acme", "invoicing software for freelancers"),
    ("We make Loom, async video messaging", "Loom", "async video messaging"),
    ("We're Pipedrive, a CRM for small sales teams", "Pipedrive", "CRM for small sales teams"),
    ("I run Harvest. It's time tracking.", "Harvest", ""),
    ("Acme Corp is a payroll tool for startups", "Acme Corp", "payroll tool for startups"),
    ("my company is monday.com and we build work management software", "monday.com", "work management software"),
])
def test_parse_prompt(prompt, name, category):
    got_name, got_category, _ = d.parse_prompt(prompt)
    assert (got_name, got_category) == (name, category)


def test_resolve_company_without_llm_uses_official_site_search():
    search = FakeSearch([("official site", recorded("asana-official-site"))])
    company = asyncio.run(d.resolve_company("We're Asana, we make project management software", search))
    assert (company.company_id, company.name, company.domain) == ("asana", "Asana", "asana.com")
    assert company.category == "project management software"
    assert search.calls[0]["query"] == "Asana official site"


def test_resolve_company_ignores_ungrounded_llm_name_and_survives_llm_errors():
    search = FakeSearch([("official site", recorded("asana-official-site"))])
    liar = lambda p: '```json\n{"name": "Globex", "category": "work management"}\n```'
    company = asyncio.run(d.resolve_company("We're Asana, we make project management software", search, liar))
    assert company.name == "Asana" and company.category == "work management"

    def broken(p):
        raise RuntimeError("429")
    assert asyncio.run(d.resolve_company("We're Asana, a PM tool", search, broken)).name == "Asana"


def test_pick_domain_skips_low_value_and_falls_back_to_titled_result():
    hits = [hit("https://www.g2.com/products/jira"), hit("https://www.atlassian.com/software/jira", "Jira | Atlassian")]
    assert d.pick_domain("Jira", hits) == "atlassian.com"
    assert d.pick_domain("HubSpot", [hit("https://blog.hubspot.com/x")]) == "hubspot.com"
    assert d.pick_domain("Zoho CRM", [hit("https://www.zoho.com/crm/")]) == "zoho.com"


# --- low-value hosts ---

@pytest.mark.parametrize("url,low", [
    ("https://www.g2.com/products/asana/competitors/alternatives", True),
    ("https://learn.g2.com/asana-vs-jira", True),
    ("https://www.reddit.com/r/projectmanagement/x", True),
    ("https://finance.yahoo.com/markets/stocks/articles/asana-asan-beat", True),
    ("https://www.investing.com/equities/asana-inc", True),
    ("https://www.investing.com/news/stock-market-news/asana-launches-ai-123", False),
    ("https://www.sec.gov/Archives/edgar/data/1477720", True),
    ("https://techcrunch.com/2026/09/01/asana-ai-studio/", False),
    ("https://asana.com/pricing", False),
])
def test_low_value_hosts(url, low):
    assert is_low_value(url) is low


def test_host_and_url_normalization():
    assert host_of("https://WWW.Monday.com/blog") == "monday.com"
    assert normalize_url("https://www.x.com/a/?utm_source=1#top") == normalize_url("http://x.com/a")


# --- competitor extraction from recorded listicles (fallback, no LLM) ---

def recorded_discovery_hits():
    return recorded("asana-competitors") + recorded("asana-vs") + recorded("best-project-management-software")


def test_fallback_competitors_from_recorded_asana_results():
    hits = recorded_discovery_hits()
    strong = {d.name_key(n) for h in hits for pair in d.VS_RE.findall(h.title + " " + h.description) for n in pair}
    found = d.score_candidates(d.candidate_names(hits), hits, asana(), strong)
    names = [c.entity_id for c in found]
    assert names[:2] == ["monday-com", "trello"]
    assert {"clickup", "jira", "wrike"} <= set(names)
    assert not {"asana", "g2", "forbes", "forbes-advisor"} & set(names)
    top = found[0]
    assert 0 < top.score <= 1 and top.mentions >= 5 and all(u.startswith("http") for u in top.seen_in)


def test_fallback_competitors_from_recorded_pipedrive_results():
    hits = recorded("pipedrive-competitors") + recorded("pipedrive-vs") + recorded("best-crm-for-small-sales-teams")
    strong = {d.name_key(n) for h in hits for pair in d.VS_RE.findall(h.title + " " + h.description) for n in pair}
    company = CompanyBrief(company_id="pipedrive", name="Pipedrive", domain="pipedrive.com",
                           category="CRM for small sales teams")
    names = [c.entity_id for c in d.score_candidates(d.candidate_names(hits), hits, company, strong)]
    assert names[:2] == ["hubspot", "salesforce"]
    assert "pipedrive" not in names and not {"crm", "crms", "sales"} & set(names)


def test_alias_dedupe():
    hits = [hit("https://a.com/1", description="Try Monday or Trello."),
            hit("https://b.com/2", description="We compared monday.com and Trello."),
            hit("https://c.com/3", description="Monday.com is great.")]
    found = d.score_candidates(["Monday", "monday.com", "Monday.com", "Trello"], hits, asana())
    assert sorted(c.entity_id for c in found) == ["monday-com", "trello"]
    assert next(c for c in found if c.entity_id == "monday-com").mentions == 3


def test_generic_words_are_not_competitors():
    hits = [hit("https://a.com/{}".format(i), description="The best CRMs: HubSpot and Sales Tools.") for i in range(3)]
    found = d.score_candidates(["CRMs", "Sales Tools", "Project Management", "HubSpot CRM"], hits, asana())
    assert [c.name for c in found] == ["HubSpot"]


def test_own_company_is_never_a_competitor():
    hits = [hit("https://a.com/{}".format(i), description="Asana and Trello, Asana Work Graph.") for i in range(3)]
    found = d.score_candidates(["Asana", "asana.com", "ASANA", "Asana Work Graph", "Trello"], hits, asana())
    assert [c.entity_id for c in found] == ["trello"]


def test_discover_competitors_offline_with_llm_grounding():
    hits = recorded_discovery_hits()
    domains = {"Trello": "trello.com", "Jira": "atlassian.com", "ClickUp": "clickup.com", "Wrike": "wrike.com"}
    rules = [("competitors", recorded("asana-competitors")), ("Asana vs", recorded("asana-vs")),
             ("best project", recorded("best-project-management-software"))]
    rules += [(n + " official", [hit("https://{}/".format(dom), n)]) for n, dom in domains.items()]
    search = FakeSearch(rules)
    llm = lambda p: '```json\n{"competitors": ["Trello", "Imaginary Corp", "Asana", "ClickUp"]}\n```'
    found = asyncio.run(d.discover_competitors(asana(), search, llm, max_competitors=4))
    ids = [c.entity_id for c in found]
    assert ids[:2] == ["trello", "clickup"]                  # LLM order first, grounded
    assert "imaginary-corp" not in ids and "asana" not in ids
    assert len(ids) == 4 and len(set(ids)) == 4
    assert all(c.domain for c in found)
    assert next(c for c in found if c.entity_id == "monday-com").domain == "monday.com"   # from a result's host
    assert len(hits) >= 20


def test_build_watch_excludes_self_and_requires_competitors():
    comp = [CompetitorCandidate(entity_id="trello", name="Trello", domain="trello.com")]
    watch = d.build_watch(asana(), comp, NOW, lookback_days=7)
    assert watch.watch_id.startswith("mw_") and watch.lookback_days == 7
    with pytest.raises(ValueError):
        d.build_watch(asana(), [CompetitorCandidate(entity_id="asana", name="Asana")], NOW)


# --- content: queries, budget, envelopes ---

def test_time_range_and_hint():
    assert [time_range_for(n) for n in (7, 30, 90)] == ["week", "month", "year"]
    assert market_hint("CRM for small sales teams") == "CRM"
    assert market_hint("project management software") == "project management software"


def test_round_robin_budget_is_fair():
    e = [Entity("a", "A", None), Entity("b", "B", None), Entity("c", "C", None)]
    queues = [[Planned(e[0], SourceType.news, hit("https://a.com/{}".format(i))) for i in range(10)],
              [Planned(e[1], SourceType.news, hit("https://b.com/1"))],
              [Planned(e[2], SourceType.news, hit("https://c.com/{}".format(i))) for i in range(3)]]
    picked = round_robin(queues, 6)
    assert [p.entity.entity_id for p in picked] == ["a", "b", "c", "a", "c", "a"]
    assert len(round_robin(queues, 100)) == 14


def news_watch():
    comp = [CompetitorCandidate(entity_id="trello", name="Trello", domain="trello.com"),
            CompetitorCandidate(entity_id="monday-com", name="Monday.com", domain="monday.com")]
    return d.build_watch(asana(), comp, NOW)


def test_envelope_for_news_page():
    watch = news_watch()
    h = hit("https://techcrunch.com/2026/09/01/trello-ai?utm=x", "Trello launches AI boards", "Trello today...",
            '"Trello" project management software', "NewsResult")
    p = Planned(Entity("trello", "Trello", "trello.com"), SourceType.news, h)
    env = envelope_for(watch, p, "run_t", NimbleResult(url=h.url, fetched_at=NOW, http_status=200, markdown=ARTICLE,
                                                        raw={"status": "success"}))
    assert env.status == RetrievalStatus.ok and env.usable
    assert re.fullmatch(r"trello-news-[0-9a-f]{8}", env.source_id)
    assert env.structured == {"title": "Trello launches AI boards", "query": h.query,
                              "search_description": "Trello today...", "entity_type": "NewsResult"}
    assert all(isinstance(v, str) for v in env.structured.values())
    assert len(env.section_hashes["article"]) == 64
    assert env.parser_version == "nimble-search-v1" and env.url == h.url and env.entity_name == "Trello"
    # same article, different formatting and tracking params: same source_id and article hash
    again = envelope_for(watch, Planned(p.entity, SourceType.news, hit("https://techcrunch.com/2026/09/01/trello-ai/")),
                         "run_t2", NimbleResult(url=h.url, fetched_at=NOW, http_status=200,
                                                markdown=ARTICLE.replace("\n\n", "\n\n\n"), raw={"status": "success"}))
    assert again.source_id == env.source_id and again.section_hashes == env.section_hashes


def test_markdown_is_capped():
    p = Planned(Entity("trello", "Trello", None), SourceType.news, hit("https://x.com/a"))
    env = envelope_for(news_watch(), p, "r", NimbleResult(url="https://x.com/a", fetched_at=NOW, http_status=200,
                                                          markdown="word " * 20000, raw={"status": "success"}))
    assert len(env.markdown) <= 40_000


@pytest.mark.parametrize("result,status", [
    (NimbleResult(url="u", fetched_at=NOW, http_status=403, raw={"status": "success"}), RetrievalStatus.blocked),
    (NimbleResult(url="u", fetched_at=NOW, http_status=200, markdown="tiny", raw={"status": "success"}),
     RetrievalStatus.empty),
    (NimbleResult(url="u", fetched_at=NOW, error="ReadTimeout"), RetrievalStatus.error),
])
def test_failures_carry_no_content(result, status):
    p = Planned(Entity("trello", "Trello", None), SourceType.news, hit("https://x.com/a", "T"))
    env = envelope_for(news_watch(), p, "r", result)
    assert env.status == status and not env.usable
    assert env.markdown is None and env.content_hash == "" and env.section_hashes == {}
    assert env.structured["title"] == "T"      # search metadata is still recorded


def test_collect_market_content_pipeline():
    watch = news_watch()
    trello_news = [hit("https://techcrunch.com/trello-ai", "Trello launches AI boards", entity_type="NewsResult"),
                   hit("https://finance.yahoo.com/trello", "Trello stock"),                 # low value
                   hit("https://news.com/monday-morning", "Monday morning markets")]        # off topic for Trello
    monday_news = [hit("https://news.com/monday-morning", "Monday morning markets"),        # off topic (no ".com")
                   hit("https://www.verge.com/monday-com-crm?ref=x", "monday.com ships a CRM")]
    asana_news = [hit("https://techcrunch.com/trello-ai/", "Trello launches AI boards, Asana responds")]  # duplicate
    pricing = {"trello.com": [hit("https://trello.com/pricing", "Trello pricing")]}
    search = FakeSearch([(lambda q, dom, d_=d_: dom == [d_], hits) for d_, hits in pricing.items()])
    search.rules += [(lambda q, dom: dom is None and q.startswith('"Trello"'), trello_news),
                     (lambda q, dom: dom is None and q.startswith('"Monday.com"'), monday_news),
                     (lambda q, dom: dom is None and q.startswith('"Asana"'), asana_news)]
    pricing_md = "# Pricing\n\n### Standard\n$5 per user/month\n\n### Premium\n$10 per user/month\n" + "x " * 400
    nimble = FakeNimble({"https://techcrunch.com/trello-ai": (ARTICLE, 200),
                         "https://trello.com/pricing": (pricing_md, 200),
                         "https://www.verge.com/monday-com-crm?ref=x": ("", 403)})
    envs, funnel = asyncio.run(collect_market_content(watch, search, nimble, "run_x", max_pages=10))

    news_calls = [c for c in search.calls if c["focus"] == "news"]
    assert len(news_calls) == 3 and all(c["time_range"] == "month" for c in news_calls)
    assert {c["include_domains"][0] for c in search.calls if c["include_domains"]} == {"trello.com", "monday.com",
                                                                                         "asana.com"}
    assert sorted(nimble.urls) == sorted(["https://techcrunch.com/trello-ai", "https://trello.com/pricing",
                                          "https://www.verge.com/monday-com-crm?ref=x"])
    by_url = {e.url: e for e in envs}
    assert by_url["https://trello.com/pricing"].source_type == SourceType.pricing
    assert by_url["https://trello.com/pricing"].status == RetrievalStatus.ok
    assert by_url["https://www.verge.com/monday-com-crm?ref=x"].status == RetrievalStatus.blocked
    assert funnel["skipped_low_value"] >= 2 and funnel["duplicates"] >= 1 and funnel["skipped_off_topic"] >= 1
    assert funnel["fetched"] == 3 and funnel["by_status"] == {"ok": 2, "blocked": 1}
    assert funnel["queries"] == 9
