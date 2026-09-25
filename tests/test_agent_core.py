import json
from datetime import timedelta

import pytest
from langchain_core.language_models.fake_chat_models import FakeListChatModel

import agent.config as agent_config
from agent.config import load_settings
from agent.react import CompanyAgent, parse_step
from agent.store import AgentStore
from agent.tools import CompanyTools
from contracts import Claim, Scene, SceneType, Storyboard, StyleGuide, TABLES, belief_key
from core.coordinator import Coordinator
from core.repository import StateRepository

from .helpers import FakeLiquid, ListSource, T0, env


BASE = {"Free": 0, "Plus": 10, "Business": 20, "Enterprise": None}


@pytest.fixture(autouse=True)
def no_env_file(monkeypatch):
    # Tests must stay offline and must not read repository-root .env.
    monkeypatch.setattr(agent_config, "load_env", lambda _path: None)


@pytest.fixture
def settings(tmp_path):
    return load_settings(
        state_db=str(tmp_path / "state.db"),
        agent_db=str(tmp_path / "agent.db"),
        openrouter_key="",
        rawtree_key="",
        max_steps=3,
        observation_chars=500,
        context_chars=2000,
    )


def populate_state(state_db):
    repo = StateRepository(str(state_db))
    src, liquid = ListSource(), FakeLiquid()
    coord = Coordinator(repo, src, liquid, use_liquid_copy=False)
    src.add(env("notion", BASE), env("linear", {"Free": 0, "Basic": 10}))
    coord.run_cycle(T0)
    repo.db.close()


def test_parse_step_variants():
    assert parse_step('Thought: x\nAction: get_current_beliefs\nAction Input: {"entity_id": "notion"}') == (
        "action",
        "get_current_beliefs",
        {"entity_id": "notion"},
    )
    assert parse_step('Thought: x\n**Action:** get_watch_brief\n**Action Input:** {"entity_id": "notion"}') == (
        "action",
        "get_watch_brief",
        {"entity_id": "notion"},
    )
    assert parse_step('Thought: x\nFinal Answer: {"brief": "ok", "entities": ["notion"]}') == (
        "final",
        {"brief": "ok", "entities": ["notion"]},
    )
    assert parse_step("Final Answer: Notion still has Plus at $10.") == (
        "final",
        {"brief": "Notion still has Plus at $10."},
    )
    assert parse_step("Thought: still thinking") == ("none",)


class RecordingRawTree:
    def __init__(self):
        self.sql = []

    def query(self, sql):
        self.sql.append(sql)
        if TABLES["storyboard"] in sql:
            sb = Storyboard(
                storyboard_id="sb1",
                patch_ids=["p_real"],
                title="Update",
                total_duration_sec=3,
                style=StyleGuide(prompt_prefix="editorial", palette=["navy"], seed=1),
                scenes=[Scene(scene=0, start_sec=0, duration_sec=3, type=SceneType.title, narration="Hi", image_prompt="abstract")],
                claims=[Claim(claim_id="c1", text="Fact", belief_key="notion:pricing.plus.monthly_usd", patch_id="p_real", evidence_ids=["e_real"])],
                voiceover_full="Hi",
            )
            return [
                {"storyboard_id": "sb_test", "run_id": "test_run", "is_test": True, "created_at": "t", "storyboard_json": sb.model_dump_json()},
                {"storyboard_id": "sb1", "run_id": "run_real", "is_test": False, "created_at": "t", "storyboard_json": sb.model_dump_json()},
            ]
        if TABLES["run"] in sql:
            return [
                {"run_id": "test_run", "started_at": "t", "pages_fetched": 1},
                {"run_id": "run_real", "started_at": "t", "pages_fetched": 2},
            ]
        if TABLES["patch"] in sql:
            return [
                {
                    "patch_id": "p_test",
                    "run_id": "test_run",
                    "origin": "diff",
                    "accepted": True,
                    "observed_at": "2026-09-25T12:00:00Z",
                    "entities": "notion",
                    "patch_json": json.dumps({"ops": [{"op": "replace", "belief_key": "x", "evidence_ids": ["e_test"]}]}),
                },
                {
                    "patch_id": "p_real",
                    "run_id": "run_real",
                    "origin": "diff",
                    "accepted": True,
                    "observed_at": "2026-09-25T12:01:00Z",
                    "entities": "notion",
                    "patch_json": json.dumps({"ops": [{"op": "replace", "belief_key": "x", "evidence_ids": ["e_real"]}]}),
                },
            ]
        if TABLES["observation"] in sql and TABLES["patch"] not in sql:
            return [
                {"obs_id": "e_test", "run_id": "test_run", "entity_id": "notion", "entity_name": "Notion", "source_type": "pricing", "url": "u", "fetched_at": "t", "status": "ok", "markdown": "test"},
                {"obs_id": "e_real", "run_id": "run_real", "entity_id": "notion", "entity_name": "Notion", "source_type": "pricing", "url": "u", "fetched_at": "t", "status": "ok", "markdown": "Real markdown " * 80},
            ]
        return []


def test_company_tools_offline_state_rawtree_sql_and_truncation(settings, tmp_path):
    populate_state(tmp_path / "state.db")
    rawtree = RecordingRawTree()
    tools = CompanyTools(settings, rawtree=rawtree)

    brief = tools.get_watch_brief()
    assert brief["watch"]["watch_id"] == "competitive-intel"

    lc_beliefs = {t.name: t for t in tools.langchain_tools()}["get_current_beliefs"]
    unknown = json.loads(lc_beliefs.invoke({"entity_id": "unknown"}))
    assert "error" in unknown

    beliefs = tools.get_current_beliefs()
    assert {s["entity_id"] for s in beliefs["slices"]} >= {"notion", "linear"}
    plus_key = belief_key("notion", "pricing.plus.monthly_usd")
    assert plus_key in tools.seen_beliefs

    assert tools.get_recent_patches(limit=1)["patches"][0]["patch_id"] == "p_real"
    evidence = tools.get_recent_evidence(entity_id="notion", limit=1)["evidence"]
    assert [r["obs_id"] for r in evidence] == ["e_real"]
    assert tools.get_storyboards(limit=1)["storyboards"][0]["storyboard_id"] == "sb1"
    assert [r["run_id"] for r in tools.get_run_metrics(limit=1)["runs"]] == ["run_real"]

    assert rawtree.sql
    assert all("LIMIT" in sql.upper() for sql in rawtree.sql)
    assert all("FROM slop_human" in sql for sql in rawtree.sql)
    assert all("FROM slop_human" in sql and "FROM slop_humanx" not in sql for sql in rawtree.sql)

    tiny = load_settings(
        state_db=str(tmp_path / "state.db"),
        agent_db=str(tmp_path / "agent.db"),
        openrouter_key="",
        rawtree_key="",
        observation_chars=80,
    )
    tiny_tools = CompanyTools(tiny, rawtree=rawtree)
    obs = {t.name: t for t in tiny_tools.langchain_tools()}["get_recent_evidence"].invoke({"limit": 1})
    assert len(obs) <= len("…[truncated]") + 80
    assert obs.endswith("…[truncated]")


def test_company_agent_react_grounding_and_outbox(settings, tmp_path):
    populate_state(tmp_path / "state.db")
    store = AgentStore(str(tmp_path / "agent.db"))
    real_key = belief_key("notion", "pricing.plus.monthly_usd")
    real_evidence = StateRepository(str(tmp_path / "state.db")).get_belief(real_key).evidence_ids[-1]
    final = {
        "brief": "Notion Plus remains $10 while a fake claim is ignored.",
        "entities": ["notion", "fakeco"],
        "claims": [
            {"text": "Notion Plus is $10.", "belief_key": real_key, "evidence_ids": [real_evidence, "fake_ev"]},
            {"text": "FakeCo launched.", "belief_key": "fake:belief", "evidence_ids": ["fake_ev"]},
        ],
    }
    llm = FakeListChatModel(responses=[
        'Thought: inspect beliefs\nAction: get_current_beliefs\nAction Input: {"entity_id": "notion"}',
        "Thought: I can answer.\nFinal Answer: " + json.dumps(final),
    ])

    ctx, run = CompanyAgent(settings, llm, store=store).run(is_test=True)

    assert run.ok is True
    assert ctx.tools_used == ["get_current_beliefs"]
    assert ctx.entities == ["notion"]
    assert ctx.claims[0].belief_key == real_key
    assert ctx.claims[0].evidence_ids == [real_evidence]
    assert all("fake" not in json.dumps(c.model_dump()) for c in ctx.claims)
    assert store.latest_context().context_id == ctx.context_id
    tables = [e.table for e in store.undelivered()]
    assert {TABLES["agent_context"], TABLES["agent_run"], TABLES["model_call"]}.issubset(set(tables))
    assert all(t.startswith("slop_human") for t in tables)


def test_fallback_without_llm_and_when_llm_raises(settings, tmp_path):
    populate_state(tmp_path / "state.db")
    ctx, run = CompanyAgent(settings, None).run(is_test=True)
    assert run.ok is True
    assert "Notion" in ctx.brief and "Plus" in ctx.brief
    assert ctx.model == "deterministic"

    class RaisingLLM:
        def invoke(self, messages, stop=None):
            raise RuntimeError("offline")

    ctx2, run2 = CompanyAgent(settings, RaisingLLM()).run(is_test=True)
    assert run2.ok is False
    assert "RuntimeError" in run2.error
    assert "Notion" in ctx2.brief


def test_max_steps_respected_when_model_keeps_calling_tools(settings, tmp_path):
    populate_state(tmp_path / "state.db")
    settings = load_settings(
        state_db=str(tmp_path / "state.db"),
        agent_db=str(tmp_path / "agent.db"),
        openrouter_key="",
        rawtree_key="",
        max_steps=2,
        context_chars=2000,
    )
    llm = FakeListChatModel(responses=[
        'Thought: again\nAction: get_current_beliefs\nAction Input: {}',
        'Thought: again\nAction: get_current_beliefs\nAction Input: {}',
        'Thought: again\nAction: get_current_beliefs\nAction Input: {}',
        'Thought: again\nAction: get_current_beliefs\nAction Input: {}',
    ])
    ctx, run = CompanyAgent(settings, llm).run(is_test=True)
    assert len([c for c in run.tool_calls if c.step > 0]) == 2
    assert run.steps <= settings.max_steps
    assert ctx.model == "deterministic"


class InsertClient:
    def __init__(self):
        self.calls = []

    def insert(self, table, rows):
        self.calls.append((table, rows))


def test_agent_store_deliver_groups_by_table_and_marks_delivered(tmp_path):
    store = AgentStore(str(tmp_path / "agent.db"))
    ctx = CompanyAgent(load_settings(state_db=str(tmp_path / "state.db"), agent_db=str(tmp_path / "agent.db"), openrouter_key="", rawtree_key=""), None).run(is_test=True)[0]
    store.save_context(ctx)
    store.record_run(CompanyAgent(load_settings(state_db=str(tmp_path / "state.db"), agent_db=str(tmp_path / "agent.db"), openrouter_key="", rawtree_key=""), None).run(is_test=True)[1])

    client = InsertClient()
    sent = store.deliver(client)
    assert sent == 2
    assert [table for table, _rows in client.calls] == [TABLES["agent_context"], TABLES["agent_run"]]
    assert all(all("event_id" in row for row in rows) for _table, rows in client.calls)
    assert store.deliver(client) == 0


def test_parse_step_lfm_native_tool_call_and_unsafe_calls():
    from agent.react import parse_step
    assert parse_step('<|tool_call_start|>[get_recent_patches(entity_id="notion", limit=3)]<|tool_call_end|>') == (
        "action", "get_recent_patches", {"entity_id": "notion", "limit": 3})
    assert parse_step("<|tool_call_start|>[get_watch_brief()]<|tool_call_end|>") == ("action", "get_watch_brief", {})
    assert parse_step('<|tool_call_start|>[os.system("rm")]<|tool_call_end|>') == ("none",)


def test_loose_json_repairs_small_model_output():
    from agent.react import loose_json
    assert loose_json('{"brief": "a (b)", "claims": [{"text": "x"}])') == {"brief": "a (b)", "claims": [{"text": "x"}]}
    assert loose_json('{"brief": "cut off') == {"brief": "cut off"}
    assert loose_json("no json") is None
