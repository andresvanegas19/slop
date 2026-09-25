import json
import os
import socket
import subprocess
import time
import urllib.error
import urllib.request

import pytest

import agent.config as agent_config
from agent.config import load_settings
from agent.react import CompanyAgent
from agent.store import AgentStore
from agent.worker import MAX_BODY_BYTES, AgentWorker, serve
from contracts import TABLES
from core.coordinator import Coordinator
from core.repository import StateRepository

from .helpers import FakeLiquid, ListSource, T0, env


BASE = {"Free": 0, "Plus": 10, "Business": 20, "Enterprise": None}


@pytest.fixture(autouse=True)
def no_env_file(monkeypatch):
    # Worker tests are offline and must not read repository-root .env.
    monkeypatch.setattr(agent_config, "load_env", lambda _path: None)


@pytest.fixture
def settings(tmp_path):
    return load_settings(
        state_db=str(tmp_path / "state.db"),
        agent_db=str(tmp_path / "agent.db"),
        openrouter_key="",
        rawtree_key="",
        max_steps=2,
        observation_chars=500,
        context_chars=2000,
    )


def _coordinator(state_db):
    repo = StateRepository(str(state_db))
    src, liquid = ListSource(), FakeLiquid()
    coord = Coordinator(repo, src, liquid, use_liquid_copy=False)
    return repo, src, liquid, coord


def _context_count(store, trigger="loop"):
    row = store.db.execute("SELECT COUNT(*) FROM contexts WHERE trigger = ?", (trigger,)).fetchone()
    return row[0]


def test_tick_refreshes_on_first_tick_and_state_version_change(settings, tmp_path):
    repo, src, _liquid, coord = _coordinator(tmp_path / "state.db")
    src.add(env("notion", BASE))
    store = AgentStore(str(tmp_path / "agent.db"))
    worker = AgentWorker(settings, CompanyAgent(settings, None, store=store), store, coordinator=coord)

    first = worker.tick()
    assert first["refreshed"] is True
    assert _context_count(store) == 1
    first_context = store.latest_context("loop")
    assert first_context is not None
    assert first_context.state_version == repo.version

    second = worker.tick()
    assert second["refreshed"] is False
    assert _context_count(store) == 1

    src.add(env("notion", dict(BASE, Plus=8), minutes=60), env("notion", dict(BASE, Plus=8), minutes=61))
    third = worker.tick()
    assert third["refreshed"] is True
    assert _context_count(store) == 2
    assert store.latest_context("loop").state_version == repo.version

    class RaisingCoordinator:
        def run_cycle(self):
            raise RuntimeError("boom")

    failing = AgentWorker(settings, CompanyAgent(settings, None, store=store), store, coordinator=RaisingCoordinator())
    summary = failing.tick()
    assert summary["core"]["error"].startswith("RuntimeError")
    repo.db.close()
    worker.pool.shutdown(wait=False, cancel_futures=True)
    failing.pool.shutdown(wait=False, cancel_futures=True)


class RecordingRawTree:
    def __init__(self):
        self.inserts = []
        self.queries = []

    def insert(self, table, rows):
        self.inserts.append((table, rows))

    def query(self, sql):
        self.queries.append(sql)
        return []


def test_publish_delivers_agent_events_to_slop_human_tables(settings, tmp_path):
    store = AgentStore(str(tmp_path / "agent.db"))
    rawtree = RecordingRawTree()
    worker = AgentWorker(
        settings,
        CompanyAgent(settings, None, rawtree=rawtree, store=store),
        store,
        rawtree=rawtree,
        publish=True,
    )

    summary = worker.tick()

    assert summary["published"] >= 2
    assert rawtree.inserts
    assert {table for table, _rows in rawtree.inserts} >= {TABLES["agent_context"], TABLES["agent_run"]}
    assert all(table.startswith("slop_human") for table, _rows in rawtree.inserts)
    assert all(all("event_id" in row for row in rows) for _table, rows in rawtree.inserts)
    assert store.undelivered() == []
    worker.pool.shutdown(wait=False, cancel_futures=True)


def _free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    try:
        return sock.getsockname()[1]
    finally:
        sock.close()


def _request(port, method, path, body=None):
    data = None if body is None else body
    if isinstance(body, (dict, list)):
        data = json.dumps(body).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def test_http_trigger_endpoints(settings, tmp_path):
    store = AgentStore(str(tmp_path / "agent.db"))
    worker = AgentWorker(settings, CompanyAgent(settings, None, store=store), store)
    port = _free_port()
    server = serve(worker, port)
    try:
        status, body = _request(port, "GET", "/health")
        assert status == 200
        assert body["ok"] is True

        status, body = _request(port, "POST", "/context", {"prompt": "pricing launch video", "kind": "video"})
        assert status == 200
        assert body["context"]["trigger"] == "prompt"
        assert body["stale"] is False

        assert _request(port, "POST", "/context", {"prompt": "x", "kind": "bad"})[0] == 400
        assert _request(port, "POST", "/context", {"prompt": " ", "kind": "video"})[0] == 400
        assert _request(port, "POST", "/context", b"{not json")[0] == 400
        assert _request(port, "POST", "/context", b"x" * (MAX_BODY_BYTES + 1))[0] == 413
        assert _request(port, "GET", "/missing")[0] == 404
    finally:
        server.shutdown()
        server.server_close()
        worker.pool.shutdown(wait=False, cancel_futures=True)


class SlowAgent:
    def __init__(self, ctx, delay_s):
        self.ctx = ctx
        self.delay_s = delay_s

    def run(self, trigger="loop", prompt=None, kind=None):
        time.sleep(self.delay_s)
        return self.ctx, None


def test_context_for_prompt_timeout_returns_cached_or_deterministic_context(settings, tmp_path):
    settings = load_settings(
        state_db=str(tmp_path / "state.db"),
        agent_db=str(tmp_path / "agent.db"),
        openrouter_key="",
        rawtree_key="",
        prompt_timeout_s=1,
    )
    store = AgentStore(str(tmp_path / "agent.db"))
    cached, _run = CompanyAgent(settings, None, store=store).run("loop")
    worker = AgentWorker(settings, SlowAgent(cached, delay_s=2), store)

    started = time.monotonic()
    ctx, stale = worker.context_for_prompt("make a video", "video")
    elapsed = time.monotonic() - started

    assert stale is True
    assert ctx.context_id == cached.context_id
    assert elapsed < 1.5
    worker.pool.shutdown(wait=True, cancel_futures=True)

    empty_store = AgentStore(str(tmp_path / "empty-agent.db"))
    fallback_worker = AgentWorker(settings, SlowAgent(cached, delay_s=2), empty_store)
    started = time.monotonic()
    fallback, stale = fallback_worker.context_for_prompt("make a video", "video")
    elapsed = time.monotonic() - started

    assert stale is True
    assert fallback.model == "deterministic"
    assert fallback.trigger == "prompt"
    assert elapsed < 1.5
    fallback_worker.pool.shutdown(wait=True, cancel_futures=True)


def test_cli_once_and_show_smoke(tmp_path):
    env = os.environ.copy()
    env.update(
        {
            "OPENROUTER_API_KEY": "",
            "RAWTREE_API_KEY": "",
            "AGENT_DB": str(tmp_path / "cli-agent.db"),
            "AGENT_STATE_DB": str(tmp_path / "cli-state.db"),
            "AGENT_SKIP_ENV_FILE": "1",
        }
    )

    once = subprocess.run(
        [".venv/bin/python", "-m", "agent", "once", "--no-llm"],
        cwd=os.getcwd(),
        env=env,
        text=True,
        capture_output=True,
        timeout=20,
    )
    assert once.returncode == 0, once.stderr
    assert '"refreshed": true' in once.stdout

    show = subprocess.run(
        [".venv/bin/python", "-m", "agent", "show"],
        cwd=os.getcwd(),
        env=env,
        text=True,
        capture_output=True,
        timeout=20,
    )
    assert show.returncode == 0, show.stderr
    assert '"context"' in show.stdout
