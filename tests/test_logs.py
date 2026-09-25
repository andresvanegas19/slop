import json
import logging
import socket
import urllib.request

import pytest

import agent.config as agent_config
from agent.config import load_settings
from agent.react import CompanyAgent
from agent.store import AgentStore
from agent.worker import AgentWorker, serve
from core.logs import NdjsonHandler, _ContextFilter, event, log_context, span


@pytest.fixture
def ndjson(tmp_path):
    handler = NdjsonHandler(tmp_path)
    handler.addFilter(_ContextFilter())
    root = logging.getLogger()
    previous = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)

    def lines():
        return [json.loads(line) for f in sorted(tmp_path.glob("agent-*.ndjson")) for line in f.read_text().splitlines()]

    yield lines
    root.removeHandler(handler)
    root.setLevel(previous)


def test_events_carry_context_and_hide_secrets(ndjson):
    log = logging.getLogger("agent.test")
    with log_context(traceId="abc123def456", sessionId="rch_1"):
        event(log, "llm_call_done", model="m", api_key="sk-or-v1-secretsecret", prompt="x" * 1000, durationMs=12)
        with span(log, "fetch_page", url="https://example.com") as extra:
            extra["bytes"] = 3
    rows = ndjson()
    done = next(r for r in rows if r["event"] == "llm_call_done")
    assert done["source"] == "agent" and done["traceId"] == "abc123def456" and done["sessionId"] == "rch_1"
    assert done["api_key"] == "[redacted]"
    assert len(done["prompt"]) < 260
    assert "sk-or" not in json.dumps(rows)
    fetched = next(r for r in rows if r["event"] == "fetch_page_done")
    assert fetched["bytes"] == 3 and isinstance(fetched["durationMs"], int)


def test_http_requests_are_traced(ndjson, tmp_path, monkeypatch):
    monkeypatch.setattr(agent_config, "load_env", lambda _path: None)
    settings = load_settings(state_db=str(tmp_path / "state.db"), agent_db=str(tmp_path / "agent.db"),
                             openrouter_key="", rawtree_key="", max_steps=2, observation_chars=500,
                             context_chars=2000)
    store = AgentStore(str(tmp_path / "agent.db"))
    worker = AgentWorker(settings, CompanyAgent(settings, None, store=store), store)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = serve(worker, port)
    try:
        req = urllib.request.Request("http://127.0.0.1:{}/health".format(port), headers={"X-Trace-Id": "trace_web_123"})
        with urllib.request.urlopen(req, timeout=5) as response:
            assert response.headers["X-Trace-Id"] == "trace_web_123"
    finally:
        server.shutdown()
        server.server_close()
        worker.pool.shutdown(wait=False, cancel_futures=True)
    done = [r for r in ndjson() if r["event"] == "http_request_done"]
    assert done and done[-1]["traceId"] == "trace_web_123" and done[-1]["status"] == 200 and done[-1]["path"] == "/health"
