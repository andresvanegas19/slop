"""Reducer: the only writer of beliefs. Applies an accepted patch and enqueues its event in one transaction."""
from datetime import datetime, timedelta, timezone

from contracts import TABLES, Belief, BeliefStatus, EventType, OpType, OutboxEvent, Patch, PatchDecision, PatchOp

# PRD 12.3 default TTLs, by attribute prefix
TTL = {"pricing.": timedelta(hours=48), "jobs.": timedelta(days=7), "features.": timedelta(days=30)}
DEFAULT_TTL = timedelta(days=30)
EVIDENCE_KEPT = 5


def ttl_for(attribute):
    return next((t for prefix, t in TTL.items() if attribute.startswith(prefix)), DEFAULT_TTL)


def patch_event(patch: Patch, decision: PatchDecision) -> OutboxEvent:
    """Flat row for RawTree: nested ops travel as one JSON string (RawTree flattens nested objects)."""
    return OutboxEvent(
        event_id="patch:" + patch.patch_id, event_type=EventType.patch, table=TABLES["patch"],
        created_at=datetime.now(timezone.utc),
        payload={"patch_id": patch.patch_id, "run_id": patch.run_id, "origin": patch.origin.value,
                 "base_state_version": patch.base_state_version,
                 "new_state_version": decision.new_state_version, "accepted": decision.accepted,
                 "rejected_reasons": "; ".join(decision.rejected_reasons), "op_count": len(patch.ops),
                 "ops": ",".join(sorted({o.op.value for o in patch.ops})),
                 "entities": ",".join(sorted({o.entity_id for o in patch.ops})),
                 "observed_at": patch.observed_at.isoformat(), "patch_json": patch.model_dump_json()})


class Reducer:
    def __init__(self, repo):
        self.repo = repo

    def apply(self, patch: Patch, decision: PatchDecision, source_id: str = "") -> PatchDecision:
        assert decision.accepted, "Reducer only applies accepted patches"
        at = patch.observed_at
        with self.repo.tx():
            for op in patch.ops:
                self._apply_op(op, at, source_id)
            decision = decision.model_copy(update={"new_state_version": self.repo.bump_version()})
            self.repo.mark_applied(patch.patch_id)
            self.repo.enqueue(patch_event(patch, decision))
        return decision

    def _apply_op(self, op, at, source_id):
        b = self.repo.get_belief(op.belief_key)
        if op.op == OpType.add:
            self.repo.put_belief(Belief(
                belief_key=op.belief_key, entity_id=op.entity_id, attribute=op.attribute, value=op.after,
                unit=op.unit, confidence=op.confidence, first_seen_at=at, last_confirmed_at=at, valid_from=at,
                expires_at=at + ttl_for(op.attribute), evidence_ids=op.evidence_ids[-EVIDENCE_KEPT:],
                source_ids=[source_id] if source_id else [], version=(b.version + 1) if b else 1))
            return
        updates = {}
        if op.op == OpType.confirm:
            updates = {"last_confirmed_at": at, "expires_at": at + ttl_for(op.attribute),
                       "confidence": max(b.confidence, op.confidence)}
        elif op.op == OpType.replace:
            updates = {"value": op.after, "unit": op.unit or b.unit, "valid_from": at, "last_confirmed_at": at,
                       "expires_at": at + ttl_for(op.attribute), "confidence": op.confidence, "version": b.version + 1}
        elif op.op == OpType.retract:
            updates = {"status": BeliefStatus.retracted, "version": b.version + 1}
        elif op.op == OpType.expire:
            updates = {"status": BeliefStatus.expired, "version": b.version + 1}
        elif op.op == OpType.dispute:
            updates = {"status": BeliefStatus.disputed, "version": b.version + 1}
        evidence = [e for e in b.evidence_ids if e not in op.evidence_ids] + op.evidence_ids
        updates["evidence_ids"] = evidence[-EVIDENCE_KEPT:]
        if source_id and source_id not in b.source_ids:
            updates["source_ids"] = b.source_ids + [source_id]
        self.repo.put_belief(b.model_copy(update=updates))


class ExpiryWorker:
    """Beliefs not confirmed within their TTL expire (PRD 12.3). Emits an ordinary patch."""

    def __init__(self, repo):
        self.repo = repo

    def due_ops(self, now):
        ops = []
        for b in self.repo.active_beliefs():
            if b.expires_at and b.expires_at < now:
                ops.append(PatchOp(op=OpType.expire, belief_key=b.belief_key, entity_id=b.entity_id,
                                   attribute=b.attribute, before=b.value, after=None, unit=b.unit,
                                   confidence=1.0, significance=0.3,
                                   reason="not confirmed since {}".format(b.last_confirmed_at.isoformat())))
        return ops
