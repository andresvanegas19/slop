"""Research sessions, offline: a fixture website behind httpx.MockTransport, a scripted fake Liquid, a fake RawTree."""
import json
import socket
import time
import urllib.error
import urllib.request

import httpx
import pytest
from langchain_core.messages import AIMessage

import agent.config as agent_config
from agent.config import load_settings
from agent.react import CompanyAgent
from agent.research import MAX_CONCURRENT_SESSIONS, ResearchManager, fallback_intent
from agent.research_store import ResearchStore
from agent.research_tools import ResearchTools
from agent.store import AgentStore
from agent.web import USER_AGENT, WebFetcher, extract, parse_robots, robots_allows, slugs
from agent.worker import AgentWorker, serve
from contracts import TABLES

HOME = "https://www.acmecola.com"
ABOUT_QUOTE = "Acme Cola has refreshed the town of Springfield since 1921."
BRANDS_QUOTE = "Acme Classic, Acme Zero and Fizzy Lime are our three drinks."
NEWS_QUOTE = "On 2026-05-04 we opened a solar-powered bottling plant."

PAGES = {
    "/": """<html><head><title>Acme Cola | Refreshing Springfield</title>
        <meta name="description" content="Acme Cola makes cheerful sodas for families in Springfield.">
        <meta property="og:image" content="/img/hero.jpg"><meta name="theme-color" content="#E41E2B">
        <style>:root{--brand-primary:#e41e2b;--accent-color:#ffcc00}</style></head>
        <body><header><img src="/img/acme-logo.svg" alt="Acme logo"><nav>
        <a href="/about">About us</a><a href="/brands">Our brands</a><a href="/news">Newsroom</a>
        <a href="/private/secret">Secret</a><a href="https://evil.example.com/x">Partner</a>
        <a href="/login">Log in</a><a href="/img/a.png">img</a></nav></header>
        <main><h1>Open happiness in Springfield</h1><p>We make sodas that bring people together at every table.</p>
        <script>var tracking = "do not read";</script></main></body></html>""",
    "/about": """<html><head><title>About Acme Cola</title></head><body><h1>Our story</h1>
        <p>{}</p><p>Our 400 employees brew every batch locally with care for the community.</p>
        <a href="/careers">Careers</a></body></html>""".format(ABOUT_QUOTE),
    "/brands": """<html><head><title>Brands</title></head><body><h2>Brands</h2><p>{}</p></body></html>"""
    .format(BRANDS_QUOTE),
    "/news": """<html><head><title>Newsroom</title></head><body><h2>News</h2><p>{}</p></body></html>"""
    .format(NEWS_QUOTE),
    "/careers": "<html><head><title>Careers</title></head><body><p>Join a team that loves soda and "
                "Springfield, with benefits for every employee.</p></body></html>",
    "/private/secret": "<html><body>secret</body></html>",
}
ROBOTS = "User-agent: *\nDisallow: /private/\nDisallow: /*/configuration\n"


def site_handler(requests):
    def handler(request: httpx.Request):
        requests.append(str(request.url))
        assert request.headers["user-agent"] == USER_AGENT
        host, path = request.url.host, request.url.path
        if host == "acmecola.com":
            return httpx.Response(301, headers={"location": HOME + path})
        if host != "www.acmecola.com":
            return httpx.Response(404, text="nope")
        if path == "/robots.txt":
            return httpx.Response(200, text=ROBOTS, headers={"content-type": "text/plain"})
        if path in PAGES:
            return httpx.Response(200, text=PAGES[path], headers={"content-type": "text/html; charset=utf-8"})
        return httpx.Response(404, text="not found", headers={"content-type": "text/html"})
    return handler


class FakeLiquid:
    """Routes on the [task:...] marker each research prompt carries."""

    def __init__(self):
        self.calls = []

    def invoke(self, messages, stop=None):
        text = "\n".join(str(m.content) for m in messages)
        self.calls.append(text[:80])
        usage = {"input_tokens": len(text) // 4, "output_tokens": 50, "total_tokens": len(text) // 4 + 50}
        return AIMessage(content=self.reply(messages, text), usage_metadata=usage)

    def reply(self, messages, text):
        if "[task:intent]" in text:
            return json.dumps({"company_name": "Acme Cola", "likely_domain": "acmecola.com",
                               "video_goal": "a warm brand video"})
        if "[task:research]" in text:
            step = sum(1 for m in messages if str(m.content).startswith("Observation:"))
            script = [
                ("list_links", {"url": HOME}),  # no trailing slash: normalized in code
                ("fetch_page", {"url": HOME + "/about"}),
                ("record_finding", {"topic": "about", "claim": "Founded in 1921 in Springfield",
                                    "evidence_url": HOME + "/about", "quote": ABOUT_QUOTE}),
                ("record_finding", {"topic": "proof", "claim": "Invented", "evidence_url": HOME + "/about",
                                    "quote": "Acme Cola is the world's largest soda company."}),
                ("fetch_page", {"url": "https://evil.example.com/x"}),
                ("fetch_page", {"url": HOME + "/private/secret"}),
                ("ask_user", {"question": "Which drink should we feature", "options": ["Acme Classic", "Acme Zero"],
                              "topic": "product"}),
            ]
            if step < len(script):
                name, args = script[step]
                return "Thought: next.\nAction: {}\nAction Input: {}".format(name, json.dumps(args))
            return "Thought: I can answer.\nFinal Answer: Found the story and brands."
        if "[task:extract]" in text:
            quotes = [q for q in (BRANDS_QUOTE, NEWS_QUOTE) if q in text]
            return json.dumps({"findings": [{"topic": "news" if q == NEWS_QUOTE else "product", "claim": q, "quote": q}
                                            for q in quotes] + [{"topic": "proof", "claim": "x",
                                                                 "quote": "a sentence that is not on the page"}]})
        if "[task:profile]" in text:
            return json.dumps({
                "one_line": {"text": "Springfield's soda maker since 1921.", "findings": ["F1"]},
                "what_they_do": {"text": "Makes sodas.", "findings": ["F99"]},
                "products": [{"text": "Acme Classic, Acme Zero, Fizzy Lime", "findings": ["F2", "F3"]},
                             {"text": "Invented product", "findings": []}],
                "brand_voice": {"text": "warm, local, cheerful", "findings": []},
                "imagery_style": "sunny small-town family moments",
                "key_messages": [{"text": "Bringing people together", "findings": ["F1"]}],
                "proof_points": ["F1", "F42"], "open_questions": ["Who is the target audience?"]})
        if "[task:questions]" in text:
            return json.dumps({"questions": [
                {"topic": "audience", "question": "Who should the video speak to?",
                 "options": ["Families", "Young adults"]},
                {"topic": "tone", "question": "What tone fits best?", "options": ["Nostalgic", "Upbeat", "Cinematic"]},
                {"topic": "format", "question": "How long should it be?", "options": ["15 s", "30 s"]},
                {"topic": "cta", "question": "No options here"}]})
        return "Final Answer: nothing"


class FakeRawTree:
    def __init__(self):
        self.inserts = []

    def insert(self, table, rows):
        self.inserts.append((table, rows))

    def query(self, sql):
        return []


@pytest.fixture(autouse=True)
def no_env_file(monkeypatch):
    monkeypatch.setattr(agent_config, "load_env", lambda _path: None)


@pytest.fixture
def settings(tmp_path):
    return load_settings(state_db=str(tmp_path / "state.db"), agent_db=str(tmp_path / "agent.db"),
                         openrouter_key="", rawtree_key="", research_interval_s=1, research_max_pages=6,
                         research_max_steps=10, research_max_rounds=2)


def manager_for(settings, llm=True, publish=False, requests=None, rawtree=None):
    requests = [] if requests is None else requests
    fetcher = lambda: WebFetcher(httpx.Client(transport=httpx.MockTransport(site_handler(requests)),  # noqa: E731
                                              headers={"User-Agent": USER_AGENT}))
    outbox = AgentStore(settings.agent_db)
    return ResearchManager(settings, ResearchStore(settings.agent_db), llm_factory=(FakeLiquid if llm else None),
                           outbox=outbox, rawtree=rawtree, publish=publish, fetcher_factory=fetcher), outbox


def wait_done(manager, sid, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if manager.finished(sid):
            return manager.view(sid)
        time.sleep(0.05)
    raise AssertionError("session did not finish: {}".format(manager.view(sid)["status"]))


# --- web ----------------------------------------------------------------------------------------------------------
def test_extract_reads_metadata_links_and_colors():
    page = extract(HOME + "/", PAGES["/"])
    assert page.title == "Acme Cola | Refreshing Springfield"
    assert page.description.startswith("Acme Cola makes cheerful sodas")
    assert page.og_image == HOME + "/img/hero.jpg" and page.logo_url == HOME + "/img/acme-logo.svg"
    assert page.colors[:3] == ["#e41e2b", "#ffcc00"] or page.colors[0] == "#e41e2b"
    assert "#ffcc00" in page.colors
    assert "Open happiness in Springfield" in page.headings
    assert "do not read" not in page.text and "bring people together" in page.text
    assert (HOME + "/about", "About us") in page.links


def test_robots_wildcards_and_groups():
    rules = parse_robots(ROBOTS + "\nUser-agent: otherbot\nDisallow: /\n")
    assert not robots_allows(rules, "/private/x")
    assert not robots_allows(rules, "/us/configuration")
    assert robots_allows(rules, "/about")
    assert not robots_allows(parse_robots("User-agent: LongformResearchBot\nDisallow: /\n"), "/about")
    assert robots_allows(parse_robots("User-agent: *\nDisallow: /a\nAllow: /a/b\n"), "/a/b/c")


def test_slugs_and_fallback_intent():
    assert slugs("Coca-Cola")[:2] == ["coca-cola", "cocacola"]
    intent = fallback_intent("generate a video for my company Coca-Cola")
    assert intent.company_name == "Coca-Cola"
    assert fallback_intent("launch film, site is acme-tools.io").likely_domain == "acme-tools.io"


# --- sessions --------------------------------------------------------------------------------------------------------
def test_session_researches_grounds_and_asks(settings):
    requests = []
    manager, _ = manager_for(settings, requests=requests)
    sid = manager.start("Make a company video for Acme Cola", looping=False)
    view = wait_done(manager, sid)

    assert view["status"] == "done", view["error"]
    assert view["company"] == "Acme Cola" and view["domain"] == "acmecola.com"
    fetched = {p["url"] for p in view["pages"]}
    assert HOME + "/about" in fetched and HOME + "/brands" in fetched and HOME + "/news" in fetched
    assert not any("private" in u or "evil" in u or "login" in u for u in requests)
    pages = manager.store.pages(sid)
    for f in view["findings"]:  # every quote is on the page it cites
        assert f["evidence_url"] in fetched
        assert " ".join(f["quote"].split()).lower() in " ".join(pages[f["evidence_url"]]["text"].split()).lower() \
            or f["quote"] in pages[f["evidence_url"]]["description"]
    quotes = {f["quote"] for f in view["findings"]}
    assert ABOUT_QUOTE in quotes and BRANDS_QUOTE in quotes and NEWS_QUOTE in quotes
    assert not any("largest" in q or "not on the page" in q for q in quotes)

    profile = view["profile"]
    assert profile["one_line"]["evidence_url"] == HOME + "/about"
    assert profile["what_they_do"] is not None  # F99 is not a finding: falls back to a real one
    assert [p["text"] for p in profile["products"]] == ["Acme Classic, Acme Zero, Fizzy Lime"]
    assert profile["brand_voice"]["evidence_url"] == HOME + "/"
    assert profile["visual_identity"]["colors"][0] == "#e41e2b"
    assert profile["visual_identity"]["imagery_style"] == "sunny small-town family moments"
    assert len(profile["proof_points"]) == 1
    assert profile["recent_news"][0]["date"] == "2026-05-04"

    qs = view["questions"]
    assert 3 <= len(qs) <= 8
    assert all(2 <= len(q["options"]) <= 4 for q in qs)
    assert {"product", "audience", "tone", "format"} <= {q["topic"] for q in qs}
    assert view["stats"]["tokens"] > 0 and view["stats"]["pages"] == len(view["pages"])

    tone = next(q for q in qs if q["topic"] == "tone")
    out = manager.answer(sid, tone["id"], "Nostalgic")
    assert out["video_brief"]["tone"] == "Nostalgic"
    after = manager.view(sid)
    assert after["profile"]["version"] == profile["version"] + 1
    assert after["answers"][0]["answer"] == "Nostalgic"
    types = [e["type"] for e in manager.store.events(sid)]
    assert {"status", "page", "finding", "question", "profile", "answer"} <= set(types)
    assert "published" not in types
    with pytest.raises(KeyError):
        manager.answer(sid, "q_missing", "x")


def test_session_without_llm_is_deterministic(settings):
    manager, _ = manager_for(settings, llm=False)
    sid = manager.start("a short video for Acme Cola please", looping=False)
    view = wait_done(manager, sid)
    assert view["status"] == "done" and view["domain"] == "acmecola.com"
    assert view["findings"] and all(f["evidence_url"].startswith(HOME) for f in view["findings"])
    assert len([q for q in view["questions"] if not q["answered"]]) >= 3
    assert view["profile"]["model"] == "deterministic"


def test_unknown_website_is_an_error(settings):
    manager, _ = manager_for(settings, llm=False)
    sid = manager.start("a video for Nonexistent Widgets", looping=False)
    view = wait_done(manager, sid)
    assert view["status"] == "error" and "website" in view["error"]


def test_publish_writes_only_research_table_with_stable_ids(settings):
    rawtree = FakeRawTree()
    manager, outbox = manager_for(settings, publish=True, rawtree=rawtree)
    sid = manager.start("Make a company video for Acme Cola", looping=False, test=True)
    view = wait_done(manager, sid)
    assert sid.startswith("test_research_")
    assert rawtree.inserts and {t for t, _ in rawtree.inserts} == {TABLES["research"]}
    rows = [r for _, rows in rawtree.inserts for r in rows]
    assert len({r["event_id"] for r in rows}) == len(rows)
    assert {r["type"] for r in rows} >= {"page", "finding", "question", "profile"}
    assert all(r["session_id"] == sid and r["is_test"] and json.loads(r["payload"]) for r in rows)
    session = manager.get(sid)
    session.queue_row("finding", view["findings"][0]["finding_id"], {})  # a retry of the same logical event
    assert outbox.undelivered() == []
    q = view["questions"][0]
    manager.answer(sid, q["id"], q["options"][0])
    assert {r["type"] for r in rawtree.inserts[-1][1]} == {"answer", "profile"}
    with pytest.raises(ValueError):
        outbox.enqueue("research", "other_team_table", "x", {})


def test_restart_marks_running_sessions_resumable(settings):
    manager, _ = manager_for(settings)
    sid = manager.start("Make a company video for Acme Cola", looping=True)
    deadline = time.time() + 10
    while manager.view(sid)["stats"]["rounds"] < 1 and time.time() < deadline:
        time.sleep(0.05)
    fresh, _ = manager_for(settings)  # the old threads keep running; the new manager must not trust them
    view = fresh.view(sid)
    assert view["status"] == "done" and view["looping"] is False
    manager.stop(sid)
    wait_done(manager, sid)


# --- HTTP ---------------------------------------------------------------------------------------------------------
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
            raw = r.read().decode()
            return r.status, raw
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def test_http_api(settings):
    settings = load_settings(**{**settings.__dict__, "research_interval_s": 60})
    manager, store = manager_for(settings)
    worker = AgentWorker(settings, CompanyAgent(settings, None, store=store), store, research=manager)
    port = _port()
    server = serve(worker, port)
    try:
        status, raw = _req(port, "POST", "/research", {"prompt": "Make a company video for Acme Cola"})
        assert status == 201
        sid = json.loads(raw)["session_id"]
        status, raw = _req(port, "POST", "/research", {"prompt": "Make a company video for Acme Cola"})
        assert status == 201
        other = json.loads(raw)["session_id"]
        assert MAX_CONCURRENT_SESSIONS == 2
        assert _req(port, "POST", "/research", {"prompt": "third"})[0] == 429
        assert _req(port, "POST", "/research", {"prompt": ""})[0] == 400
        assert _req(port, "POST", "/research", {"prompt": "x", "looping": "yes"})[0] == 400

        deadline = time.time() + 20
        while time.time() < deadline:
            status, raw = _req(port, "GET", "/research/" + sid)
            view = json.loads(raw)
            if view["status"] == "waiting":
                break
            time.sleep(0.1)
        assert view["status"] == "waiting" and view["looping"] is True
        assert view["company"] == "Acme Cola" and view["questions"] and view["stats"]["findings"] > 0

        status, raw = _req(port, "GET", "/research/{}/events?after=0&follow=0".format(sid))
        events = [json.loads(line) for line in raw.splitlines()]
        assert status == 200 and [e["seq"] for e in events] == list(range(1, len(events) + 1))
        status, raw = _req(port, "GET", "/research/{}/events?after={}&follow=0".format(sid, events[-1]["seq"]))
        assert raw.strip() == ""

        q = view["questions"][0]
        status, raw = _req(port, "POST", "/research/{}/answer".format(sid), {"question_id": q["id"],
                                                                              "answer": q["options"][0]})
        assert status == 200 and json.loads(raw)["answered"] is True
        assert _req(port, "POST", "/research/{}/answer".format(sid), {"question_id": "q_nope", "answer": "x"})[0] \
            == 404
        assert _req(port, "POST", "/research/{}/answer".format(sid), {"question_id": q["id"]})[0] == 400

        status, raw = _req(port, "POST", "/research/{}/loop".format(sid), {"looping": False})
        assert status == 200 and json.loads(raw)["looping"] is False
        status, raw = _req(port, "GET", "/research/{}/events?after={}".format(sid, events[-1]["seq"]))  # follows
        tail = [json.loads(line) for line in raw.splitlines()]
        assert tail[-1]["type"] == "status" and tail[-1]["status"] == "done"
        assert any(e["type"] == "answer" for e in tail)

        assert _req(port, "POST", "/research/{}/stop".format(other), {})[0] == 200
        wait_done(manager, other)
        assert json.loads(_req(port, "GET", "/research/" + other)[1])["status"] == "stopped"
        assert _req(port, "POST", "/research/{}/loop".format(other), {"looping": True})[0] == 409
        assert _req(port, "GET", "/research/research_missing")[0] == 404
        assert json.loads(_req(port, "GET", "/health")[1])["research"]["running"] == 0
    finally:
        server.shutdown()
        for s in manager.sessions.values():
            s.stop()
        worker.pool.shutdown(wait=False, cancel_futures=True)


# --- past videos (RawTree slop_human_video_events) ------------------------------------------------------------------
VIDEO_ROWS = [
    {"project_id": "p1", "kind": "storyboard", "title": "Acme Cola summer film", "reason": "edit frame 2",
     "duration_sec": 15, "created_at": "2026-09-25 10:00:00", "research_session_id": "research_x",
     "frames": json.dumps([{"prompt": "a family picnic with red soda bottles", "edits": ["make it golden hour"]}]),
     "chat_summary": "User liked the warm light.", "storyboard": json.dumps({"headline": "Summer"})},
    {"project_id": "p1", "kind": "storyboard", "title": "Acme Cola summer film", "reason": "initial render",
     "duration_sec": 15, "created_at": "2026-09-25 09:00:00"},
    {"project_id": "p2", "kind": "video", "title": "Globex launch", "duration_sec": 10,
     "created_at": "2026-09-24 09:00:00"},
    {"project_id": "p3", "kind": "video", "title": "Acme Cola test", "is_test": True, "created_at": "2026-09-23"},
]


class VideoRawTree(FakeRawTree):
    def __init__(self, rows=None, missing=False):
        super().__init__()
        self.rows, self.missing, self.sql = rows or [], missing, []

    def query(self, sql):
        self.sql.append(sql)
        if self.missing:
            raise RuntimeError("RawTree query failed: HTTP 400 Table not found.")
        return self.rows


def test_recent_videos_summarizes_filters_and_tolerates_missing_table(settings):
    import agent.videos as videos
    from agent.tools import CompanyTools

    rawtree = VideoRawTree(VIDEO_ROWS)
    out = CompanyTools(settings, rawtree).get_recent_videos(limit=5, company="Acme Cola")
    assert rawtree.sql[-1] == "SELECT * FROM slop_human_video_events ORDER BY created_at DESC LIMIT 40"
    assert [v["project_id"] for v in out["videos"]] == ["p1"]
    v = out["videos"][0]
    assert v["frame_prompts"] == ["a family picnic with red soda bottles"] and v["edits"] == ["make it golden hour"]
    assert v["earlier_versions"] == ["initial render"] and v["duration_sec"] == 15.0
    assert v["research_session_id"] == "research_x" and v["chat_summary"].startswith("User liked")
    assert len(CompanyTools(settings, rawtree).get_recent_videos(limit=5)["videos"]) == 2  # test rows skipped

    videos._missing_until.clear()
    missing = VideoRawTree(missing=True)
    assert CompanyTools(settings, missing).get_recent_videos()["videos"] == []
    assert CompanyTools(settings, missing).get_recent_videos()["videos"] == []
    assert len(missing.sql) == 1  # remembered as missing for a while
    videos._missing_until.clear()
    assert "not configured" in CompanyTools(settings, None).get_recent_videos()["note"]


def test_research_session_uses_past_videos(settings):
    import agent.videos as videos
    videos._missing_until.clear()
    llm = FakeLiquid()
    manager, _ = manager_for(settings)
    manager.reader = VideoRawTree(VIDEO_ROWS)
    manager.llm_factory = lambda: llm
    sid = manager.start("Make a company video for Acme Cola", looping=False)
    wait_done(manager, sid)
    events = manager.store.events(sid)
    assert any(e.get("videos") and e["videos"][0]["title"] == "Acme Cola summer film" for e in events)
    session = manager.get(sid)
    assert "Acme Cola summer film" in session.videos_line()
    tool = {t.name: t for t in ResearchTools(session).langchain_tools()}["get_recent_videos"]
    assert json.loads(tool.invoke({}))["videos"][0]["project_id"] == "p1"


# --- the user's own history (RawTree slop_human_user_prompts) ------------------------------------------------------
PROMPT_ROWS = [
    {"event_id": "e1", "user_id": "u_1", "surface": "preset", "prompt": "A nostalgic, warm 15 seconds ad for Acme Cola",
     "action": "generate", "outcome": "ok", "duration_sec": 15, "created_at": "2026-09-25 10:00:00"},
    {"event_id": "e2", "user_id": "u_1", "surface": "chat", "prompt": "make it cinematic with golden hour light",
     "action": "edit", "outcome": "error", "error": "BFL 429", "created_at": "2026-09-25 09:00:00"},
]


class PromptRawTree(VideoRawTree):
    def query(self, sql):
        self.sql.append(sql)
        if "slop_human_user_prompts" in sql:
            if self.missing:
                raise RuntimeError("RawTree query failed: HTTP 400 Table not found.")
            return PROMPT_ROWS
        return VIDEO_ROWS


def test_user_context_summary_sql_and_missing_table(settings):
    import agent.videos as videos
    from agent.tools import CompanyTools
    from agent.user_context import expressed_topics, user_context

    videos._missing_until.clear()
    rawtree = PromptRawTree()
    ctx = user_context(rawtree, "u_1", 15)
    assert rawtree.sql[-1].startswith("SELECT event_id, user_id, project_id, surface, prompt, action")
    assert rawtree.sql[-1].endswith(
        "FROM slop_human_user_prompts WHERE toString(user_id) = 'u_1' ORDER BY created_at DESC LIMIT 15")
    assert ctx["count"] == 2 and {"nostalgic", "warm", "cinematic", "golden hour"} <= set(ctx["style_words"])
    assert ctx["durations"][0] == "15s" and ctx["failures"][0]["error"] == "BFL 429"
    assert set(expressed_topics(ctx)) == {"tone", "format"}
    assert user_context(rawtree, "x'; DROP TABLE t; --")["error"] == "invalid user_id"
    # a run for a known user never sees another user's prompts
    CompanyTools(settings, rawtree, user_id="u_1").get_user_context(user_id="u_2")
    assert "toString(user_id) = 'u_1'" in rawtree.sql[-1]
    missing = PromptRawTree(missing=True)
    assert user_context(missing, "u_1")["prompts"] == []
    videos._missing_until.clear()


def test_research_uses_user_context_and_prior_answers(settings):
    import agent.videos as videos
    videos._missing_until.clear()
    manager, _ = manager_for(settings)
    manager.reader = PromptRawTree()
    sid = manager.start("Make a company video for Acme Cola", looping=False, user_id="u_1")
    view = wait_done(manager, sid)
    assert view["user_id"] == "u_1"
    topics = {q["topic"] for q in view["questions"]}
    assert "tone" not in topics and "format" not in topics  # the user already expressed these in past prompts
    assert any(e.get("user_context") for e in manager.store.events(sid))
    audience = next(q for q in view["questions"] if q["topic"] == "audience")
    manager.answer(sid, audience["id"], "Families")

    again = manager.start("Another video for Acme Cola", looping=False, user_id="u_1")
    view2 = wait_done(manager, again)
    assert view2["profile"]["video_brief"]["audience"] == "Families"  # carried over, not re-asked
    assert "audience" not in {q["topic"] for q in view2["questions"]}


def test_http_accepts_user_header(settings):
    manager, store = manager_for(settings, llm=False)
    worker = AgentWorker(settings, CompanyAgent(settings, None, store=store), store, research=manager)
    port = _port()
    server = serve(worker, port)
    try:
        req = urllib.request.Request("http://127.0.0.1:{}/research".format(port), method="POST",
                                     data=json.dumps({"prompt": "video for Acme Cola", "looping": False}).encode(),
                                     headers={"Content-Type": "application/json", "X-Longform-User": "user-42"})
        with urllib.request.urlopen(req, timeout=10) as r:
            sid = json.loads(r.read())["session_id"]
        assert wait_done(manager, sid)["user_id"] == "user-42"
        assert _req(port, "POST", "/research", {"prompt": "x", "user_id": "bad id!"})[0] == 400
    finally:
        server.shutdown()
        worker.pool.shutdown(wait=False, cancel_futures=True)


def test_link_priorities_and_brand_colors():
    from agent.web import css_colors, link_category, link_score, saturated
    assert link_score(HOME + "/about-us/history", "") > link_score(HOME + "/about-us/contact-us", "")
    assert link_score(HOME + "/about-us/faq", "") < link_score(HOME + "/news", "")
    assert link_category(HOME + "/about-us/brands") == "products" and link_category(HOME + "/newsroom") == "news"
    assert not saturated("#6c6c6c") and not saturated("#ffffff") and saturated("#ea0000")
    css = ":root{--color-text-on_brand-primary: #ffffff; --color-icon-brand-primary-regular: #ea0000} a{color:#1474fc}"
    assert css_colors(css) == ["#ea0000", "#1474fc"]
