"""StateRepository: B's SQLite. Current beliefs, pending changes, readings, outbox, idempotency.

Everything a cycle writes happens inside one `with repo.tx():` block, so a crash leaves
either the whole step or none of it. The state can be rebuilt by replaying patch events.
"""
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Dict, List, Optional

from contracts import Belief, BeliefStatus, EvidenceRef, OutboxEvent, VideoStoryboardRecord

from .state_machine import Pending

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entities (entity_id TEXT PRIMARY KEY, entity_name TEXT NOT NULL, baselined INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS observations (obs_id TEXT PRIMARY KEY, entity_id TEXT, fetched_at TEXT, status TEXT);
CREATE TABLE IF NOT EXISTS beliefs (belief_key TEXT PRIMARY KEY, entity_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pending (entity_id TEXT, attribute TEXT, data TEXT NOT NULL, PRIMARY KEY (entity_id, attribute));
CREATE TABLE IF NOT EXISTS readings (entity_id TEXT PRIMARY KEY, section_hash TEXT, facts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS applied_patches (patch_id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (event_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, delivered_at TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS article_readings (entity_id TEXT, section_hash TEXT, developments TEXT NOT NULL, processed_at TEXT NOT NULL, PRIMARY KEY (entity_id, section_hash));
CREATE TABLE IF NOT EXISTS evidence_refs (obs_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS video_storyboards (storyboard_id TEXT PRIMARY KEY, watch_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS video_storyboards_by_watch ON video_storyboards (watch_id, created_at);
"""


class StateRepository:
    def __init__(self, path="state.db"):
        self.db = sqlite3.connect(path, isolation_level=None)  # explicit transactions only
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        self._depth = 0

    @contextmanager
    def tx(self):
        """Nested-safe transaction: only the outermost block commits or rolls back."""
        if self._depth == 0:
            self.db.execute("BEGIN IMMEDIATE")
        self._depth += 1
        try:
            yield self
            self._depth -= 1
            if self._depth == 0:
                self.db.execute("COMMIT")
        except BaseException:
            self._depth -= 1
            if self._depth == 0:
                self.db.execute("ROLLBACK")
            raise

    # --- meta -------------------------------------------------------------
    def _get(self, key, default=None):
        row = self.db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else default

    def _set(self, key, value):
        self.db.execute("INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        (key, str(value)))

    @property
    def version(self) -> int:
        return int(self._get("state_version", 0))

    def bump_version(self) -> int:
        v = self.version + 1
        self._set("state_version", v)
        return v

    def cursor(self, source):
        return self._get("cursor:" + source)

    def set_cursor(self, source, value):
        self._set("cursor:" + source, value)

    # --- entities & observations -------------------------------------------
    def upsert_entity(self, entity_id, entity_name):
        self.db.execute("INSERT INTO entities (entity_id, entity_name) VALUES (?, ?) "
                        "ON CONFLICT(entity_id) DO UPDATE SET entity_name = excluded.entity_name",
                        (entity_id, entity_name))

    def entity_names(self) -> Dict[str, str]:
        return dict(self.db.execute("SELECT entity_id, entity_name FROM entities").fetchall())

    def is_baselined(self, entity_id) -> bool:
        row = self.db.execute("SELECT baselined FROM entities WHERE entity_id = ?", (entity_id,)).fetchone()
        return bool(row and row[0])

    def mark_baselined(self, entity_id):
        self.db.execute("UPDATE entities SET baselined = 1 WHERE entity_id = ?", (entity_id,))

    def record_observation(self, env):
        self.db.execute("INSERT OR IGNORE INTO observations VALUES (?, ?, ?, ?)",
                        (env.obs_id, env.entity_id, env.fetched_at.isoformat(), env.status.value))

    def has_observation(self, obs_id) -> bool:
        return self.db.execute("SELECT 1 FROM observations WHERE obs_id = ?", (obs_id,)).fetchone() is not None

    # --- beliefs -------------------------------------------------------------
    def get_belief(self, key) -> Optional[Belief]:
        row = self.db.execute("SELECT data FROM beliefs WHERE belief_key = ?", (key,)).fetchone()
        return Belief.model_validate_json(row[0]) if row else None

    def put_belief(self, b: Belief):
        self.db.execute("INSERT INTO beliefs VALUES (?, ?, ?, ?) ON CONFLICT(belief_key) DO UPDATE SET "
                        "status = excluded.status, data = excluded.data",
                        (b.belief_key, b.entity_id, b.status.value, b.model_dump_json()))

    def active_beliefs(self, entity_id=None) -> List[Belief]:
        sql, args = "SELECT data FROM beliefs WHERE status = ?", [BeliefStatus.active.value]
        if entity_id:
            sql += " AND entity_id = ?"
            args.append(entity_id)
        return [Belief.model_validate_json(r[0]) for r in self.db.execute(sql + " ORDER BY belief_key", args)]

    # --- pending & readings --------------------------------------------------
    def pending(self, entity_id) -> Dict[str, Pending]:
        rows = self.db.execute("SELECT attribute, data FROM pending WHERE entity_id = ?", (entity_id,))
        return {a: Pending.model_validate_json(d) for a, d in rows}

    def upsert_pending(self, p: Pending):
        self.db.execute("INSERT INTO pending VALUES (?, ?, ?) ON CONFLICT(entity_id, attribute) DO UPDATE SET "
                        "data = excluded.data", (p.entity_id, p.attribute, p.model_dump_json()))

    def delete_pending(self, entity_id, attribute):
        self.db.execute("DELETE FROM pending WHERE entity_id = ? AND attribute = ?", (entity_id, attribute))

    def reading(self, entity_id):
        row = self.db.execute("SELECT section_hash, facts FROM readings WHERE entity_id = ?", (entity_id,)).fetchone()
        return (row[0], json.loads(row[1])) if row else (None, None)

    def save_reading(self, entity_id, section_hash, facts):
        self.db.execute("INSERT INTO readings VALUES (?, ?, ?) ON CONFLICT(entity_id) DO UPDATE SET "
                        "section_hash = excluded.section_hash, facts = excluded.facts",
                        (entity_id, section_hash, json.dumps(facts)))

    # --- market path: processed articles, evidence refs, video storyboards ------
    def article_reading(self, entity_id, section_hash) -> Optional[list]:
        """Developments (JSON dicts) already extracted from this article content, or None if never processed."""
        row = self.db.execute("SELECT developments FROM article_readings WHERE entity_id = ? AND section_hash = ?",
                              (entity_id, section_hash)).fetchone()
        return json.loads(row[0]) if row else None

    def save_article_reading(self, entity_id, section_hash, developments: list):
        self.db.execute("INSERT INTO article_readings VALUES (?, ?, ?, ?) ON CONFLICT(entity_id, section_hash) "
                        "DO UPDATE SET developments = excluded.developments, processed_at = excluded.processed_at",
                        (entity_id, section_hash, json.dumps(developments), datetime.now(timezone.utc).isoformat()))

    def save_evidence_ref(self, ref: EvidenceRef):
        self.db.execute("INSERT INTO evidence_refs VALUES (?, ?) ON CONFLICT(obs_id) DO UPDATE SET data = excluded.data",
                        (ref.obs_id, ref.model_dump_json()))

    def evidence_ref(self, obs_id) -> Optional[EvidenceRef]:
        row = self.db.execute("SELECT data FROM evidence_refs WHERE obs_id = ?", (obs_id,)).fetchone()
        return EvidenceRef.model_validate_json(row[0]) if row else None

    def save_video_storyboard(self, record: VideoStoryboardRecord):
        """Keyed by storyboard_id (a content hash): the same storyboard composed twice is stored once."""
        self.db.execute("INSERT OR IGNORE INTO video_storyboards VALUES (?, ?, ?, ?)",
                        (record.storyboard_id, record.watch_id, record.created_at.isoformat(),
                         record.model_dump_json()))

    def get_video_storyboard(self, storyboard_id) -> Optional[VideoStoryboardRecord]:
        row = self.db.execute("SELECT data FROM video_storyboards WHERE storyboard_id = ?",
                              (storyboard_id,)).fetchone()
        return VideoStoryboardRecord.model_validate_json(row[0]) if row else None

    def latest_video_storyboard(self, watch_id) -> Optional[VideoStoryboardRecord]:
        row = self.db.execute("SELECT data FROM video_storyboards WHERE watch_id = ? "
                              "ORDER BY created_at DESC, rowid DESC LIMIT 1", (watch_id,)).fetchone()
        return VideoStoryboardRecord.model_validate_json(row[0]) if row else None

    # --- idempotency & outbox --------------------------------------------------
    def is_applied(self, patch_id) -> bool:
        return self.db.execute("SELECT 1 FROM applied_patches WHERE patch_id = ?", (patch_id,)).fetchone() is not None

    def mark_applied(self, patch_id):
        self.db.execute("INSERT INTO applied_patches VALUES (?, ?)",
                        (patch_id, datetime.now(timezone.utc).isoformat()))

    def enqueue(self, event: OutboxEvent):
        """Deterministic event_id: re-enqueueing the same logical event is a no-op."""
        self.db.execute("INSERT OR IGNORE INTO outbox (event_id, created_at, data) VALUES (?, ?, ?)",
                        (event.event_id, event.created_at.isoformat(), event.model_dump_json()))

    def undelivered(self) -> List[OutboxEvent]:
        rows = self.db.execute("SELECT data FROM outbox WHERE delivered_at IS NULL ORDER BY created_at")
        return [OutboxEvent.model_validate_json(r[0]) for r in rows]

    def mark_delivered(self, event_ids):
        now = datetime.now(timezone.utc).isoformat()
        self.db.executemany("UPDATE outbox SET delivered_at = ? WHERE event_id = ?", [(now, e) for e in event_ids])

    def state_tokens(self) -> int:
        """Rough size of what Liquid could ever be shown: all active beliefs, ~4 chars per token."""
        return sum(len(b.model_dump_json()) for b in self.active_beliefs()) // 4
