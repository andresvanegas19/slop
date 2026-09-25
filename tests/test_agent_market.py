"""Market-update sessions (agent/market.py) and their HTTP routes, with a fake pipeline. No network."""
import json
import urllib.error
import urllib.request
from datetime import datetime, timezone

import pytest

from contracts import (CompanyBrief, CompetitorCandidate, DevelopmentKind, EvidenceEnvelope, MarketDevelopment,
                       MarketStatus, MarketWatch, RetrievalStatus, SourceType)
from agent.market import MarketAnalysis, MarketManager, MarketPipeline
from agent.worker import AgentWorker, serve

NOW = datetime(2026, 9, 25, tzinfo=timezone.utc)


def company():
    return CompanyBrief(company_id="acme", name="Acme", domain="acme.com", category="invoicing software")


def competitors():
    return [CompetitorCandidate(entity_id="rivalco", name="RivalCo", domain="rivalco.io", score=0.8)]


def envelope():
    return EvidenceEnvelope(obs_id="obs1", run_id="test_1", source_id="rivalco-news-1", entity_id="rivalco",
                            entity_name="RivalCo", source_type=SourceType.news, url="https://news.example/a",
                            fetched_at=NOW, status=RetrievalStatus.ok, parser_version="nimble-search-v1",
                            content_hash="h", markdown="RivalCo launched a thing.")


def development():
    return MarketDevelopment(development_id="dev_1", entity_id="rivalco", entity_name="RivalCo",
                             kind=DevelopmentKind.launch, headline="RivalCo launches a thing",
                             quote="RivalCo launched a thing.", evidence_id="obs1", url="https://news.example/a",
                             observed_at=NOW, significance=0.7)


def pipeline(**overrides):
    calls = []
    base = dict(
        resolve=lambda prompt: calls.append("resolve") or company(),
        discover=lambda c: calls.append("discover") or competitors(),
        build_watch=lambda c, comps, now: MarketWatch(watch_id=MarketWatch.make_id(c.company_id), company=c,
                                                      competitors=comps, created_at=now),
        collect=lambda watch, run_id: (calls.append("collect") or [envelope()], {}),
        analyze=lambda watch, envs, run_id: calls.append("analyze") or MarketAnalysis([development()], "sb_1"),
        get_storyboard=lambda sid: {"storyboard_id": sid} if sid == "sb_1" else None,
    )
    base.update(overrides)
    return MarketPipeline(**base), calls


def test_session_runs_all_stages_in_order():
    p, calls = pipeline()
    m = MarketManager(p, test=True)
    view = m.wait(m.start("We're Acme, invoicing software"), timeout=5)
    assert view["status"] == MarketStatus.ready.value
    assert view["storyboard_id"] == "sb_1" and view["company"]["name"] == "Acme"
    assert [c["name"] for c in view["competitors"]] == ["RivalCo"]
    assert view["pages_fetched"] == 1 and view["developments"][0]["development_id"] == "dev_1"
    assert calls == ["resolve", "discover", "collect", "analyze"]
    assert [e["stage"] for e in view["events"]] == ["discovering", "collecting", "analyzing", "storyboarding",
                                                    "ready"]
    assert view["published"] is False


def test_publishing_order_evidence_before_analysis_then_outbox():
    order = []
    p, _ = pipeline(publish_evidence=lambda w, envs: order.append(("evidence", len(envs))),
                    analyze=lambda w, envs, r: order.append("analyze") or MarketAnalysis([], "sb_1"),
                    publish_outbox=lambda: order.append("outbox") or 3)
    m = MarketManager(p)
    view = m.wait(m.start("Acme"), timeout=5)
    assert order == [("evidence", 1), "analyze", "outbox"] and view["published"] is True


def test_failure_is_reported_not_raised():
    p, _ = pipeline(discover=lambda c: [])
    m = MarketManager(p)
    view = m.wait(m.start("Acme"), timeout=5)
    assert view["status"] == "error" and "no competitors" in view["error"]


@pytest.fixture
def server():
    p, _ = pipeline()
    worker = AgentWorker(settings=None, agent=None, store=None, market=MarketManager(p, test=True))
    srv = serve(worker, 0)
    yield "http://127.0.0.1:{}".format(srv.server_address[1]), worker
    srv.shutdown()


def call(url, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"},
                                 method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_http_contract(server):
    base, worker = server
    assert call(base + "/market", {"prompt": " "})[0] == 400
    status, started = call(base + "/market", {"prompt": "We're Acme"})
    assert status == 201 and started["status"] == "starting"
    worker.market.wait(started["session_id"], timeout=5)
    status, view = call(base + "/market/" + started["session_id"])
    assert status == 200 and view["status"] == "ready"
    assert call(base + "/market/mkt_nope")[0] == 404
    assert call(base + "/market/storyboards/sb_1") == (200, {"storyboard_id": "sb_1"})
    assert call(base + "/market/storyboards/missing")[0] == 404
