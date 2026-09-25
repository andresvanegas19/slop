"""PatchValidator: models propose, code decides (PRD 14). Nothing reaches the Reducer without passing here."""
from contracts import BeliefStatus, OpType, Patch, PatchDecision

MAX_PRICE = 100000
MAX_RATIO = 10  # a >10x jump either way is almost certainly a misreading


class PatchValidator:
    def __init__(self, repo):
        self.repo = repo

    def validate(self, patch: Patch) -> PatchDecision:
        reasons = []
        if self.repo.is_applied(patch.patch_id):
            reasons.append("duplicate: patch already applied")
        if patch.base_state_version != self.repo.version:
            reasons.append("version conflict: patch based on {}, state is {}".format(
                patch.base_state_version, self.repo.version))

        for op in patch.ops:
            where = "{} {}".format(op.op.value, op.belief_key)
            for e in op.evidence_ids:
                if not self.repo.has_observation(e):
                    reasons.append("{}: unknown evidence {}".format(where, e))
            current = self.repo.get_belief(op.belief_key)
            active = current is not None and current.status == BeliefStatus.active

            if op.op == OpType.add and active:
                reasons.append("{}: belief already active".format(where))
            if op.op in (OpType.replace, OpType.confirm, OpType.retract, OpType.expire, OpType.dispute):
                if not active:
                    reasons.append("{}: no active belief".format(where))
                elif current.value != op.before:
                    reasons.append("{}: before={} but current value is {}".format(where, op.before, current.value))
            if op.op == OpType.confirm and op.before != op.after:
                reasons.append("{}: confirm must not change the value".format(where))

            for v in (op.before, op.after):
                if isinstance(v, (int, float)) and not 0 <= v <= MAX_PRICE:
                    reasons.append("{}: value {} out of range".format(where, v))
            if op.op == OpType.replace and isinstance(op.before, (int, float)) and isinstance(op.after, (int, float)):
                lo, hi = sorted([op.before, op.after])
                if lo > 0 and hi / lo > MAX_RATIO:
                    reasons.append("{}: {} -> {} is a >{}x jump, likely a misreading".format(
                        where, op.before, op.after, MAX_RATIO))

        return PatchDecision(patch_id=patch.patch_id, accepted=not reasons, rejected_reasons=reasons)
