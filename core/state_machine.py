"""PatchBuilder: the belief state machine. Pure: no I/O, no model calls.

Per attribute, given one usable observation of an entity:

    baseline (entity never seen)       -> add (low significance)
    active + same value                -> confirm
    active + different value           -> pending replace; same new value seen CONFIRMATIONS times -> replace
    unknown attribute (after baseline) -> pending add; seen CONFIRMATIONS times -> add
    pending add, then missing          -> forgotten (a one-off misreading, never reported)
    active + missing                   -> pending missing; MISSING_TO_RETRACT times in a row -> retract

Unusable observations (status != ok) never reach this class: absence is not retraction.
"""
from datetime import datetime
from typing import Dict, List, Optional

from pydantic import BaseModel

from contracts import Belief, EvidenceEnvelope, OpType, PatchOp, belief_key

CONFIRMATIONS = 2
MISSING_TO_RETRACT = 2


class Pending(BaseModel):
    """A change seen but not yet confirmed. Lives only in B's SQLite, never in a Patch."""
    entity_id: str
    attribute: str
    kind: str                          # "add" | "replace" | "missing"
    value: Optional[float] = None
    unit: Optional[str] = None
    seen: int = 1
    evidence_ids: List[str] = []
    first_seen_at: datetime


class BuildResult(BaseModel):
    ops: List[PatchOp] = []
    pending_upserts: List[Pending] = []
    pending_deletes: List[str] = []    # attributes


def same(a, b):
    if a is None or b is None:
        return a == b
    return abs(float(a) - float(b)) < 0.005


def price_significance(old, new):
    if old in (None, 0) or new is None:
        return 0.7
    pct = abs(new - old) / old * 100
    return round(min(0.95, 0.5 + pct / 50), 2)


class PatchBuilder:
    def __init__(self, confirmations=CONFIRMATIONS, missing_to_retract=MISSING_TO_RETRACT):
        self.confirmations, self.missing_to_retract = confirmations, missing_to_retract

    def _op(self, env, op, attr, before, after, unit, evidence, confidence, significance, reason):
        return PatchOp(op=op, belief_key=belief_key(env.entity_id, attr), entity_id=env.entity_id, attribute=attr,
                       before=before, after=after, unit=unit, evidence_ids=evidence,
                       confidence=confidence, significance=significance, reason=reason[:280])

    def build(self, env: EvidenceEnvelope, facts: Dict[str, dict], beliefs: Dict[str, Belief],
              pending: Dict[str, Pending], baselined: bool) -> BuildResult:
        """beliefs / pending are keyed by attribute; beliefs holds active beliefs only."""
        r = BuildResult()
        obs = env.obs_id

        if not baselined:
            for attr, f in facts.items():
                r.ops.append(self._op(env, OpType.add, attr, None, f["value"], f.get("unit"), [obs],
                                      0.7, 0.1, "baseline: first observation of {}".format(env.entity_name)))
            return r

        def bump(attr, kind, value, unit):
            p = pending.get(attr)
            if p and p.kind == kind and same(p.value, value):
                p = p.model_copy(update={"seen": p.seen + 1, "evidence_ids": (p.evidence_ids + [obs])[-5:]})
            else:
                p = Pending(entity_id=env.entity_id, attribute=attr, kind=kind, value=value, unit=unit,
                            evidence_ids=[obs], first_seen_at=env.fetched_at)
            return p

        for attr, f in facts.items():
            value, unit = f["value"], f.get("unit")
            b = beliefs.get(attr)
            if b is not None:
                if same(b.value, value):
                    r.ops.append(self._op(env, OpType.confirm, attr, b.value, b.value, b.unit, [obs],
                                          max(b.confidence, 0.9), 0.0, "same value observed again"))
                    if attr in pending:
                        r.pending_deletes.append(attr)
                    continue
                p = bump(attr, "replace", value, unit)
                if p.seen >= self.confirmations:
                    r.ops.append(self._op(env, OpType.replace, attr, b.value, value, unit, p.evidence_ids, 0.9,
                                          price_significance(b.value, value),
                                          "{} -> {}, seen in {} fetches".format(b.value, value, p.seen)))
                    r.pending_deletes.append(attr)
                else:
                    r.pending_upserts.append(p)
            else:
                p = bump(attr, "add", value, unit)
                if p.seen >= self.confirmations:
                    r.ops.append(self._op(env, OpType.add, attr, None, value, unit, p.evidence_ids, 0.9, 0.8,
                                          "new plan, seen in {} fetches".format(p.seen)))
                    r.pending_deletes.append(attr)
                else:
                    r.pending_upserts.append(p)

        for attr, b in beliefs.items():
            if attr in facts:
                continue
            p = bump(attr, "missing", None, None)
            if p.seen >= self.missing_to_retract:
                r.ops.append(self._op(env, OpType.retract, attr, b.value, None, b.unit, p.evidence_ids, 0.85, 0.85,
                                      "missing from {} consecutive fetches".format(p.seen)))
                r.pending_deletes.append(attr)
            else:
                r.pending_upserts.append(p)

        for attr, p in pending.items():
            if p.kind == "add" and attr not in facts:
                r.pending_deletes.append(attr)  # unconfirmed new plan vanished: forget it
        return r
