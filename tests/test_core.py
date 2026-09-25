"""State core tests. Offline: no Nimble, Liquid or RawTree calls (PRD 19: reducer/validator tests need no network)."""
import sqlite3
from datetime import timedelta

import pytest

from contracts import BeliefStatus, OpType, Patch, PatchOp, PatchOrigin, Storyboard, StoryboardRecord, belief_key
from core.coordinator import Coordinator
from core.reducer import Reducer
from core.repository import StateRepository
from core.validator import PatchValidator

from .helpers import T0, FakeLiquid, ListSource, env

BASE = {"Free": 0, "Plus": 10, "Business": 20, "Enterprise": None}


@pytest.fixture
def world(tmp_path):
    repo = StateRepository(str(tmp_path / "state.db"))
    src, liquid = ListSource(), FakeLiquid()
    coord = Coordinator(repo, src, liquid, use_liquid_copy=False)
    return repo, src, liquid, coord


def value(repo, attr, entity="notion"):
    b = repo.get_belief(belief_key(entity, "pricing.{}.monthly_usd".format(attr)))
    return b.value if b and b.status == BeliefStatus.active else "absent"


# --- state machine through the coordinator -----------------------------------

def test_baseline_adds_beliefs_but_no_storyboard(world):
    repo, src, _, coord = world
    src.add(env("notion", BASE), env("linear", {"Free": 0, "Basic": 10}))
    run, sb, decisions = coord.run_cycle(T0)
    assert all(d.accepted for d in decisions)
    assert value(repo, "plus") == 10 and value(repo, "basic", "linear") == 10
    assert run.ops_accepted == 6 and sb is None  # baseline adds are not meaningful


def test_one_off_price_is_held_then_confirmed_replace(world):
    repo, src, _, coord = world
    src.add(env("notion", BASE))
    coord.run_cycle(T0)
    src.add(env("notion", dict(BASE, Plus=8), minutes=60))
    run, sb, _ = coord.run_cycle(T0 + timedelta(hours=1))
    assert value(repo, "plus") == 10 and sb is None          # seen once: pending only
    assert repo.pending("notion")["pricing.plus.monthly_usd"].seen == 1
    src.add(env("notion", dict(BASE, Plus=8), minutes=120))
    run, sb, _ = coord.run_cycle(T0 + timedelta(hours=2))
    assert value(repo, "plus") == 8                           # seen twice: replaced
    assert sb is not None and sb.claims[0].text == "Notion changed Plus from $10 to $8 per month."
    assert len(sb.claims[0].evidence_ids) == 2                # both fetches cited
    assert "pricing.plus.monthly_usd" not in repo.pending("notion")


def test_flip_flop_does_not_change_belief(world):
    repo, src, _, coord = world
    src.add(env("notion", BASE), env("notion", dict(BASE, Plus=8), minutes=60),
            env("notion", BASE, minutes=120), env("notion", dict(BASE, Plus=8), minutes=180))
    coord.run_cycle(T0 + timedelta(hours=4))
    assert value(repo, "plus") == 10


def test_blocked_fetch_changes_nothing(world):
    repo, src, liquid, coord = world
    src.add(env("notion", BASE))
    coord.run_cycle(T0)
    v = repo.version
    src.add(env("notion", {}, minutes=60, status="blocked"), env("notion", {}, minutes=120, status="blocked"))
    run, _, _ = coord.run_cycle(T0 + timedelta(hours=2))
    assert run.pages_invalid == 2 and repo.version == v and value(repo, "business") == 20
    assert liquid.extract_calls == 1


def test_unchanged_section_hash_skips_liquid_but_confirms(world):
    repo, src, liquid, coord = world
    src.add(env("notion", BASE))
    coord.run_cycle(T0)
    src.add(env("notion", BASE, minutes=60))
    run, _, _ = coord.run_cycle(T0 + timedelta(hours=1))
    assert liquid.extract_calls == 1 and run.skipped_unchanged == 1
    b = repo.get_belief(belief_key("notion", "pricing.plus.monthly_usd"))
    assert b.last_confirmed_at == T0 + timedelta(minutes=60)


def test_new_plan_needs_two_sightings_and_one_off_is_forgotten(world):
    repo, src, _, coord = world
    src.add(env("notion", BASE))
    coord.run_cycle(T0)
    src.add(env("notion", dict(BASE, Team=15), minutes=60), env("notion", BASE, minutes=120))
    coord.run_cycle(T0 + timedelta(hours=2))
    assert value(repo, "team") == "absent" and "pricing.team.monthly_usd" not in repo.pending("notion")
    src.add(env("notion", dict(BASE, Team=15), minutes=180), env("notion", dict(BASE, Team=15), minutes=240))
    _, sb, _ = coord.run_cycle(T0 + timedelta(hours=4))
    assert value(repo, "team") == 15 and "added a Team plan" in sb.claims[0].text


def test_plan_missing_twice_is_retracted(world):
    repo, src, _, coord = world
    no_business = {k: v for k, v in BASE.items() if k != "Business"}
    src.add(env("notion", BASE), env("notion", no_business, minutes=60))
    coord.run_cycle(T0 + timedelta(hours=1))
    assert value(repo, "business") == 20                      # missing once: kept
    src.add(env("notion", no_business, minutes=120))
    _, sb, _ = coord.run_cycle(T0 + timedelta(hours=2))
    assert repo.get_belief(belief_key("notion", "pricing.business.monthly_usd")).status == BeliefStatus.retracted
    assert sb.scenes[-1].narration.startswith("Biggest opening")  # a competitor dropping a plan is an opening


def test_unconfirmed_beliefs_expire_after_ttl(world):
    repo, src, _, coord = world
    src.add(env("notion", BASE))
    coord.run_cycle(T0)
    run, _, _ = coord.run_cycle(T0 + timedelta(hours=49))
    assert run.active_beliefs == 0
    assert repo.get_belief(belief_key("notion", "pricing.plus.monthly_usd")).status == BeliefStatus.expired


def test_storyboard_is_contract_valid_and_round_trips(world):
    repo, src, _, coord = world
    src.add(env("notion", BASE), env("linear", {"Free": 0, "Basic": 10}), env("jira", {"Standard": 7.91}))
    coord.run_cycle(T0)
    src.add(env("notion", dict(BASE, Plus=8), minutes=60), env("notion", dict(BASE, Plus=8), minutes=61),
            env("linear", {"Free": 0, "Basic": 12}, minutes=60), env("linear", {"Free": 0, "Basic": 12}, minutes=61))
    _, sb, _ = coord.run_cycle(T0 + timedelta(hours=1))
    assert [s.type.value for s in sb.scenes] == ["title", "change", "change", "quiet", "outro"]
    assert sb.total_duration_sec == 18
    assert Storyboard.model_validate_json(sb.model_dump_json()) == sb
    rec = StoryboardRecord.from_storyboard(sb, "run_x", T0)
    assert rec.storyboard() == sb
    queued = [e.table for e in repo.undelivered()]
    assert "slop_human_build" in queued and "slop_human_patch_events" in queued and "slop_human_run_events" in queued


def test_state_stays_flat_over_many_unchanged_cycles(world):
    repo, src, liquid, coord = world
    sizes = []
    for i in range(50):
        src.add(env("notion", BASE, minutes=i), env("linear", {"Free": 0, "Basic": 10}, minutes=i))
        run, _, _ = coord.run_cycle(T0 + timedelta(minutes=i))
        sizes.append(run.state_tokens)
    assert liquid.extract_calls == 2                          # only the first fetch of each entity
    # Grows only while each belief's evidence list fills to its cap (5), then stays exactly flat.
    assert len(set(sizes[5:])) == 1, sizes


# --- validator ------------------------------------------------------------------

def _patch(repo, ops, obs=()):
    return Patch(patch_id=Patch.make_id(repo.version, list(obs), ops), run_id="r", base_state_version=repo.version,
                 origin=PatchOrigin.diff, ops=ops, observed_at=T0)


def _op(**kw):
    base = dict(op=OpType.replace, belief_key="notion:pricing.plus.monthly_usd", entity_id="notion",
                attribute="pricing.plus.monthly_usd", before=10, after=8, confidence=0.9, significance=0.9,
                evidence_ids=["o1"], reason="test")
    base.update(kw)
    return PatchOp(**base)


def test_validator_rejections(world):
    repo, src, _, coord = world
    src.add(env("notion", BASE))
    coord.run_cycle(T0)
    known = repo.get_belief("notion:pricing.plus.monthly_usd").evidence_ids
    v = PatchValidator(repo)

    def reasons(op, **patch_kw):
        p = _patch(repo, [op])
        if patch_kw:
            p = p.model_copy(update=patch_kw)
        return " | ".join(v.validate(p).rejected_reasons)

    assert "unknown evidence" in reasons(_op(evidence_ids=["nope"]))
    assert "before=9" in reasons(_op(before=9, evidence_ids=known))
    assert ">10x jump" in reasons(_op(after=0.5, evidence_ids=known))
    assert "version conflict" in reasons(_op(evidence_ids=known), base_state_version=0)
    assert "already active" in reasons(_op(op=OpType.add, before=None, after=5, evidence_ids=known))
    assert reasons(_op(evidence_ids=known)) == ""               # a correct replace passes

    good = _patch(repo, [_op(evidence_ids=known)])
    Reducer(repo).apply(good, v.validate(good))
    assert "duplicate" in " | ".join(v.validate(good).rejected_reasons)


def test_reducer_is_atomic(world, monkeypatch):
    repo, src, _, coord = world
    src.add(env("notion", BASE))
    coord.run_cycle(T0)
    known = repo.get_belief("notion:pricing.plus.monthly_usd").evidence_ids
    p = _patch(repo, [_op(evidence_ids=known)])
    d = PatchValidator(repo).validate(p)
    v0 = repo.version

    def boom(*a, **k):
        raise sqlite3.OperationalError("disk full")
    monkeypatch.setattr(repo, "mark_applied", boom)
    with pytest.raises(sqlite3.OperationalError):
        Reducer(repo).apply(p, d)
    assert repo.version == v0 and value(repo, "plus") == 10    # nothing half-applied
