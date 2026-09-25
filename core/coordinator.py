"""Coordinator: one monitoring cycle (PRD 8). The only component that sequences the others.

    expiry -> for each new evidence row: record, gate, (Liquid), build, validate, reduce
           -> meaningful ops -> storyboard -> outbox -> (optional) deliver to RawTree
"""
import logging
from datetime import datetime, timezone
from typing import List, Optional, Tuple

from contracts import (TABLES, EventType, OutboxEvent, Patch, PatchDecision, PatchOrigin, RunRecord, Storyboard,
                       StoryboardRecord)

from .logs import event
from .reducer import ExpiryWorker, Reducer, patch_event
from .repository import StateRepository
from .state_machine import PatchBuilder
from .storyboard import StoryboardComposer, is_meaningful
from .validator import PatchValidator

log = logging.getLogger("core.coordinator")


def _event(kind, table, key, payload):
    return OutboxEvent(event_id="{}:{}".format(kind.value, key), event_type=kind, table=table,
                       created_at=datetime.now(timezone.utc), payload=payload)


class Coordinator:
    def __init__(self, repo: StateRepository, source, liquid, watch_id="competitor-pricing",
                 market="Competitor pricing", use_liquid_copy=True, is_test=False):
        self.repo, self.source, self.liquid = repo, source, liquid
        self.watch_id, self.market, self.is_test = watch_id, market, is_test
        self.builder, self.validator = PatchBuilder(), PatchValidator(repo)
        self.reducer, self.expiry = Reducer(repo), ExpiryWorker(repo)
        self.use_liquid_copy = use_liquid_copy

    def _submit(self, patch: Patch, run: RunRecord, source_id="", extra=None) -> PatchDecision:
        """Validate, then apply (accepted) or record (rejected). `extra` runs in the same transaction."""
        decision = self.validator.validate(patch)
        run.ops_proposed += len(patch.ops)
        with self.repo.tx():
            if extra:
                extra()
            if decision.accepted:
                decision = self.reducer.apply(patch, decision, source_id)
                run.ops_accepted += len(patch.ops)
            else:
                self.repo.enqueue(patch_event(patch, decision))
                run.ops_rejected += len(patch.ops)
        return decision

    def run_cycle(self, now: Optional[datetime] = None) -> Tuple[RunRecord, Optional[Storyboard], List[PatchDecision]]:
        now = now or datetime.now(timezone.utc)
        prefix = "test_" if self.is_test else "run_"
        run = RunRecord(run_id=prefix + now.strftime("%Y%m%dT%H%M%S%fZ"), watch_id=self.watch_id, started_at=now)
        decisions, accepted = [], []

        # 1. Expiry: beliefs not confirmed within their TTL.
        ops = self.expiry.due_ops(now)
        if ops:
            patch = Patch(patch_id=Patch.make_id(self.repo.version, [], ops), run_id=run.run_id,
                          base_state_version=self.repo.version, origin=PatchOrigin.expiry, ops=ops, observed_at=now)
            decisions.append(self._submit(patch, run))

        # 2. New evidence.
        cursor_key = self.source.name
        for env, cursor_value in self.source.fetch_new(self.repo.cursor(cursor_key)):
            run.pages_fetched += 1
            with self.repo.tx():
                self.repo.upsert_entity(env.entity_id, env.entity_name)
                self.repo.record_observation(env)
                self.repo.set_cursor(cursor_key, cursor_value)
            if not env.usable:
                run.pages_invalid += 1  # absence is not retraction: no state change at all
                continue

            section_hash = env.section_hashes.get("pricing")
            last_hash, last_facts = self.repo.reading(env.entity_id)
            if section_hash and last_hash == section_hash:
                facts = last_facts
                run.skipped_unchanged += 1
            else:
                facts, call = self.liquid.extract_pricing(env, run.run_id)
                run.liquid_calls += 1
                run.input_tokens += call.input_tokens
                run.output_tokens += call.output_tokens
                self.repo.enqueue(_event(EventType.model_call, TABLES["model_call"], call.call_id,
                                         call.model_dump(mode="json")))
                if not call.ok:
                    continue  # model failure: keep prior beliefs, don't save a reading
                with self.repo.tx():
                    self.repo.save_reading(env.entity_id, section_hash, facts)

            baselined = self.repo.is_baselined(env.entity_id)
            beliefs = {b.attribute: b for b in self.repo.active_beliefs(env.entity_id)}
            result = self.builder.build(env, facts, beliefs, self.repo.pending(env.entity_id), baselined)

            def persist_pending(env=env, result=result):
                for p in result.pending_upserts:
                    self.repo.upsert_pending(p)
                for attr in result.pending_deletes:
                    self.repo.delete_pending(env.entity_id, attr)
                self.repo.mark_baselined(env.entity_id)

            if not result.ops:
                with self.repo.tx():
                    persist_pending()
                continue
            patch = Patch(patch_id=Patch.make_id(self.repo.version, [env.obs_id], result.ops), run_id=run.run_id,
                          base_state_version=self.repo.version, origin=PatchOrigin.diff, ops=result.ops,
                          observed_at=env.fetched_at)
            decision = self._submit(patch, run, env.source_id, extra=persist_pending)
            decisions.append(decision)
            if decision.accepted:
                accepted += [(patch, op) for op in patch.ops]

        # 3. Storyboard for meaningful changes.
        storyboard = None
        if any(is_meaningful(op) for _, op in accepted):
            def liquid_copy(text):
                got, call = self.liquid.write_copy(text, run.run_id)
                run.liquid_calls += 1
                self.repo.enqueue(_event(EventType.model_call, TABLES["model_call"], call.call_id,
                                         call.model_dump(mode="json")))
                return got
            copywriter = liquid_copy if self.use_liquid_copy and self.liquid is not None else None
            names = self.repo.entity_names()
            storyboard = StoryboardComposer(copywriter).compose(accepted, names, tracked=len(names),
                                                                market=self.market)
            if storyboard:
                record = StoryboardRecord.from_storyboard(storyboard, run.run_id, now, is_test=self.is_test)
                self.repo.enqueue(_event(EventType.media, TABLES["storyboard"], storyboard.storyboard_id,
                                         record.model_dump(mode="json")))
                run.media_generated += 1

        # 4. Run metrics.
        run = run.model_copy(update={"finished_at": datetime.now(timezone.utc),
                                     "active_beliefs": len(self.repo.active_beliefs()),
                                     "state_tokens": self.repo.state_tokens()})
        self.repo.enqueue(_event(EventType.run, TABLES["run"], run.run_id, run.model_dump(mode="json")))
        event(log, "core_cycle_done", runId=run.run_id, pages=run.pages_fetched, opsProposed=run.ops_proposed,
              opsAccepted=run.ops_accepted, opsRejected=run.ops_rejected, storyboard=bool(storyboard),
              durationMs=int((run.finished_at - now).total_seconds() * 1000) if run.finished_at else None)
        return run, storyboard, decisions


class OutboxDeliverer:
    """Sends undelivered events to RawTree, grouped by table. Safe to re-run: delivery is per event."""

    def __init__(self, repo: StateRepository, client):
        self.repo, self.client = repo, client

    def deliver(self) -> int:
        by_table = {}
        for e in self.repo.undelivered():
            by_table.setdefault(e.table, []).append(e)
        sent = 0
        for table, events in by_table.items():
            self.client.insert(table, [dict(e.payload, event_id=e.event_id) for e in events])
            with self.repo.tx():
                self.repo.mark_delivered([e.event_id for e in events])
            sent += len(events)
        return sent
