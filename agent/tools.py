"""The agent's tools. Each one reads a contracts/ model from RawTree, core's state.db, config, or agent memory.

Rules:
- SQL is built here from fixed column lists, allowlisted `slop_human*` tables and validated entity ids.
  Liquid only chooses a tool and its typed arguments; it never writes SQL.
- Every result is JSON, bounded in rows and characters.
- Tools never raise into the agent: failures come back as {"error": ...} observations.
"""
import json
from pathlib import Path
from typing import Callable, Dict, List, Optional

import yaml
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from contracts import TABLES, Belief, SourceRecipe, StateSlice, Storyboard, WatchBrief
from core.liquid import pricing_window
from core.repository import StateRepository
from core.sources import is_test_run

from .user_context import user_context, valid_user_id
from .videos import recent_videos

MAX_LIMIT = 20


class EntityArgs(BaseModel):
    entity_id: Optional[str] = Field(None, description="entity id from get_watch_brief, e.g. 'notion'; omit for all")


class EntityLimitArgs(EntityArgs):
    limit: int = Field(5, ge=1, le=MAX_LIMIT, description="how many rows, newest first")


class LimitArgs(BaseModel):
    limit: int = Field(3, ge=1, le=MAX_LIMIT, description="how many rows, newest first")


class NoArgs(BaseModel):
    pass


class UserArgs(BaseModel):
    user_id: Optional[str] = Field(None, description="omit: the current user (or all users when none)")
    limit: int = Field(15, ge=1, le=50, description="how many recent prompts, newest first")


class VideoArgs(BaseModel):
    limit: int = Field(5, ge=1, le=10, description="how many past videos, newest first")
    company: Optional[str] = Field(None, description="only videos about this company; omit for all")


def _dump(value) -> str:
    return json.dumps(value, default=str, ensure_ascii=False)


def _quote(value: str) -> str:
    return "'{}'".format(value.replace("\\", "").replace("'", ""))


class CompanyTools:
    """One instance per agent run: it remembers which beliefs and evidence the run has seen (for grounding)."""

    def __init__(self, settings, rawtree=None, store=None, user_id=None):
        self.settings, self.rawtree, self.store = settings, rawtree, store
        self.user_id = valid_user_id(user_id)
        self.seen_beliefs: Dict[str, Belief] = {}
        self.seen_evidence: set = set()
        self.state_version: Optional[int] = None
        self._watch = None

    # --- config -------------------------------------------------------------
    def watch(self):
        if self._watch is None:
            raw = yaml.safe_load(Path(self.settings.watch_file).read_text())
            brief = WatchBrief(**raw["watch"])
            recipes = [SourceRecipe(watch_id=brief.watch_id, **s) for s in raw.get("sources", [])]
            self._watch = (brief, recipes)
        return self._watch

    def entity_ids(self) -> List[str]:
        return list(self.watch()[0].entities)

    def entity_names(self) -> Dict[str, str]:
        return {r.entity_id: r.entity_name for r in self.watch()[1]}

    def _entity(self, entity_id):
        if entity_id in (None, ""):
            return None
        entity_id = str(entity_id).strip().lower()
        if entity_id not in self.entity_ids():
            raise ValueError("unknown entity_id {!r}; use one of {}".format(entity_id, self.entity_ids()))
        return entity_id

    def _query(self, sql):
        if self.rawtree is None:
            raise RuntimeError("RawTree is not configured (RAWTREE_API_KEY is missing)")
        return self.rawtree.query(sql)

    # --- tools --------------------------------------------------------------
    def get_watch_brief(self):
        brief, recipes = self.watch()
        return {"watch": brief.model_dump(mode="json"),
                "sources": [r.model_dump(mode="json", include={"source_id", "entity_id", "entity_name",
                                                               "source_type", "seed_url"}) for r in recipes]}

    def get_current_beliefs(self, entity_id=None):
        entity = self._entity(entity_id)
        if not Path(self.settings.state_db).exists():
            return {"slices": [], "note": "no state.db yet; run `python -m core` or the worker with --run-core"}
        repo = StateRepository(self.settings.state_db)
        try:
            slices = []
            self.state_version = repo.version
            for eid in [entity] if entity else self.entity_ids():
                beliefs = repo.active_beliefs(eid)
                for b in beliefs:
                    self.seen_beliefs[b.belief_key] = b
                    self.seen_evidence.update(b.evidence_ids)
                slices.append(StateSlice(entity_id=eid, state_version=repo.version, beliefs=beliefs)
                              .model_dump(mode="json", include={"entity_id": True, "state_version": True,
                                                                "beliefs": {"__all__": {
                                                                    "belief_key", "attribute", "value", "unit",
                                                                    "confidence", "last_confirmed_at",
                                                                    "evidence_ids"}}}))
            return {"slices": slices}
        finally:
            repo.db.close()

    def get_recent_patches(self, entity_id=None, limit=5):
        entity = self._entity(entity_id)
        rows = self._query(
            "SELECT patch_id, run_id, origin, accepted, ops, entities, toString(observed_at) AS observed_at, "
            "patch_json FROM {} ORDER BY observed_at DESC LIMIT {}".format(TABLES["patch"], int(limit) * 4))
        out = []
        for row in rows:
            if is_test_run(row.get("run_id", "")) or str(row.get("accepted")).lower() not in ("true", "1"):
                continue
            if entity and entity not in str(row.get("entities", "")).split(","):
                continue
            try:
                ops = json.loads(row.get("patch_json") or "{}").get("ops", [])
            except ValueError:
                ops = []
            ops = [{k: o.get(k) for k in ("op", "belief_key", "before", "after", "unit", "significance",
                                          "evidence_ids", "reason")} for o in ops]
            for o in ops:
                self.seen_evidence.update(o.get("evidence_ids") or [])
            out.append({"patch_id": row.get("patch_id"), "origin": row.get("origin"),
                        "observed_at": row.get("observed_at"), "ops": ops})
            if len(out) >= limit:
                break
        return {"patches": out}

    def get_recent_evidence(self, entity_id=None, limit=3):
        entity = self._entity(entity_id)
        where = "WHERE entity_id = {} ".format(_quote(entity)) if entity else ""
        rows = self._query(
            "SELECT obs_id, run_id, entity_id, entity_name, source_type, url, toString(fetched_at) AS fetched_at, "
            "status, markdown FROM {} {}ORDER BY fetched_at DESC LIMIT {}".format(
                TABLES["observation"], where, int(limit) * 3))
        rows = [r for r in rows if not is_test_run(r.get("run_id", ""))][:limit]
        per_item = max(300, self.settings.observation_chars // max(1, len(rows)) - 400)
        out = []
        for r in rows:
            self.seen_evidence.add(r.get("obs_id"))
            out.append({k: r.get(k) for k in ("obs_id", "entity_id", "entity_name", "source_type", "url",
                                              "fetched_at", "status")}
                       | {"excerpt": pricing_window(r.get("markdown") or "")[:per_item]})
        return {"evidence": out}

    def get_storyboards(self, limit=3):
        rows = self._query(
            "SELECT storyboard_id, run_id, is_test, toString(created_at) AS created_at, storyboard_json "
            "FROM {} ORDER BY created_at DESC LIMIT {}".format(TABLES["storyboard"], int(limit) * 3))
        out = []
        for r in rows:
            if is_test_run(r.get("run_id", "")) or str(r.get("is_test")).lower() in ("true", "1"):
                continue
            try:
                sb = Storyboard.model_validate_json(r.get("storyboard_json") or "")
            except ValueError:
                continue
            for c in sb.claims:
                self.seen_evidence.update(c.evidence_ids)
            out.append({"storyboard_id": sb.storyboard_id, "created_at": r.get("created_at"), "title": sb.title,
                        "voiceover": sb.voiceover_full,
                        "claims": [c.model_dump(include={"text", "belief_key", "evidence_ids"}) for c in sb.claims]})
            if len(out) >= limit:
                break
        return {"storyboards": out}

    def get_run_metrics(self, limit=3):
        rows = self._query(
            "SELECT run_id, toString(started_at) AS started_at, pages_fetched, pages_invalid, skipped_unchanged, "
            "liquid_calls, ops_accepted, ops_rejected, active_beliefs, media_generated FROM {} "
            "ORDER BY started_at DESC LIMIT {}".format(TABLES["run"], int(limit) * 3))
        return {"runs": [r for r in rows if not is_test_run(r.get("run_id", ""))][:limit]}

    def get_recent_videos(self, limit=5, company=None):
        return recent_videos(self.rawtree, limit, company)

    def get_user_context(self, user_id=None, limit=15):
        # a run for a known user only ever sees that user's prompts
        return user_context(self.rawtree, self.user_id or user_id, limit)

    def get_previous_context(self, limit=2):
        if self.store is None:
            return {"contexts": []}
        return {"contexts": [c.model_dump(mode="json", include={"generated_at", "trigger", "brief", "claims"})
                             for c in self.store.recent_contexts(min(int(limit), 5))]}

    # --- LangChain wiring -----------------------------------------------------
    def _wrap(self, fn: Callable) -> Callable:
        def run(**kwargs):
            try:
                text = _dump(fn(**kwargs))
            except Exception as e:  # observations, never crashes
                text = _dump({"error": "{}: {}".format(type(e).__name__, str(e)[:300])})
            cap = self.settings.observation_chars
            return text if len(text) <= cap else text[:cap] + "…[truncated]"
        return run

    def langchain_tools(self) -> List[StructuredTool]:
        spec = [
            ("get_watch_brief", self.get_watch_brief, NoArgs,
             "The company watch brief (WatchBrief + SourceRecipes): objective, tracked entities and sources."),
            ("get_current_beliefs", self.get_current_beliefs, EntityArgs,
             "What the agent currently believes (StateSlice of active Beliefs with evidence ids). Start here."),
            ("get_recent_patches", self.get_recent_patches, EntityLimitArgs,
             "Recent accepted state changes (PatchOps: before/after, significance, reason) from RawTree."),
            ("get_recent_evidence", self.get_recent_evidence, EntityLimitArgs,
             "Recent raw observations (EvidenceEnvelope excerpts) from RawTree `slop_human`."),
            ("get_storyboards", self.get_storyboards, LimitArgs,
             "Recent briefing storyboards (title, voiceover, Claims) from RawTree."),
            ("get_run_metrics", self.get_run_metrics, LimitArgs,
             "Recent monitoring cycle metrics (RunRecords) from RawTree."),
            ("get_recent_videos", self.get_recent_videos, VideoArgs,
             "Videos the studio already made (RawTree slop_human_video_events): titles, prompts, edits that worked, "
             "durations, company and research session."),
            ("get_user_context", self.get_user_context, UserArgs,
             "The user's past prompts (RawTree slop_human_user_prompts): companies, style words, durations, "
             "what failed."),
            ("get_previous_context", self.get_previous_context, LimitArgs,
             "The agent's own previous company briefs (long-term memory)."),
        ]
        return [StructuredTool.from_function(func=self._wrap(fn), name=name, description=desc, args_schema=schema)
                for name, fn, schema, desc in spec]
