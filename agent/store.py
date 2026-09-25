"""AgentStore: the agent's own SQLite (agent.db). Cached CompanyContexts, loop meta, and an outbox for RawTree.

Kept separate from core's state.db so the agent never writes beliefs; it only reads them.
"""
import json
import sqlite3
import threading
from datetime import datetime, timezone
from typing import List, Optional

from contracts import TABLES, AgentRunRecord, CompanyContext, EventType, ModelCallRecord, OutboxEvent

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contexts (context_id TEXT PRIMARY KEY, trigger TEXT NOT NULL, generated_at TEXT NOT NULL,
                                     data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (event_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, delivered_at TEXT,
                                   data TEXT NOT NULL);
"""


def _now():
    return datetime.now(timezone.utc)


class AgentStore:
    def __init__(self, path="agent.db"):
        self.db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        self.lock = threading.Lock()  # the HTTP trigger and the loop share one connection
        self.deliver_lock = threading.Lock()  # the loop and research sessions both deliver; never send a row twice

    def get(self, key, default=None):
        with self.lock:
            row = self.db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else default

    def set(self, key, value):
        with self.lock:
            self.db.execute("INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                            (key, str(value)))

    def save_context(self, ctx: CompanyContext):
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO contexts VALUES (?, ?, ?, ?)",
                            (ctx.context_id, ctx.trigger, ctx.generated_at.isoformat(), ctx.model_dump_json()))
        self._enqueue(EventType.evaluation, TABLES["agent_context"], "agent_context:" + ctx.context_id,
                      ctx.model_dump(mode="json") | {"claims": json.dumps([c.model_dump() for c in ctx.claims]),
                                                     "entities": ",".join(ctx.entities),
                                                     "tools_used": ",".join(ctx.tools_used)})

    def latest_context(self, trigger: Optional[str] = None) -> Optional[CompanyContext]:
        sql, args = "SELECT data FROM contexts", []
        if trigger:
            sql, args = sql + " WHERE trigger = ?", [trigger]
        with self.lock:
            row = self.db.execute(sql + " ORDER BY generated_at DESC LIMIT 1", args).fetchone()
        return CompanyContext.model_validate_json(row[0]) if row else None

    def recent_contexts(self, limit=3) -> List[CompanyContext]:
        with self.lock:
            rows = self.db.execute("SELECT data FROM contexts ORDER BY generated_at DESC LIMIT ?", (limit,)).fetchall()
        return [CompanyContext.model_validate_json(r[0]) for r in rows]

    def record_run(self, run: AgentRunRecord):
        payload = run.model_dump(mode="json")
        payload["tool_calls"] = json.dumps([t.model_dump() for t in run.tool_calls])  # RawTree flattens nested objects
        self._enqueue(EventType.run, TABLES["agent_run"], "agent_run:" + run.agent_run_id, payload)

    def record_model_call(self, call: ModelCallRecord):
        self._enqueue(EventType.model_call, TABLES["model_call"], "model_call:" + call.call_id,
                      call.model_dump(mode="json"))

    def enqueue(self, kind, table, event_id, payload):
        """Queues one row for RawTree. Only slop_human* tables; the same event_id is queued once."""
        if not table.startswith(TABLES["observation"]):
            raise ValueError("refusing to queue {!r}: only slop_human* tables are ours".format(table))
        self._enqueue(kind, table, event_id, payload)

    def _enqueue(self, kind, table, event_id, payload):
        event = OutboxEvent(event_id=event_id, event_type=kind, table=table, payload=payload, created_at=_now())
        with self.lock:
            self.db.execute("INSERT OR IGNORE INTO outbox (event_id, created_at, data) VALUES (?, ?, ?)",
                            (event.event_id, event.created_at.isoformat(), event.model_dump_json()))

    def undelivered(self) -> List[OutboxEvent]:
        with self.lock:
            rows = self.db.execute("SELECT data FROM outbox WHERE delivered_at IS NULL ORDER BY created_at").fetchall()
        return [OutboxEvent.model_validate_json(r[0]) for r in rows]

    def deliver(self, client) -> int:
        """Sends undelivered events to RawTree grouped by table. Rows are permanent; event IDs are deterministic."""
        with self.deliver_lock:
            return self._deliver(client)

    def _deliver(self, client) -> int:
        by_table = {}
        for e in self.undelivered():
            if not e.table.startswith(TABLES["observation"]):
                continue
            by_table.setdefault(e.table, []).append(e)
        sent = 0
        for table, events in by_table.items():
            client.insert(table, [dict(e.payload, event_id=e.event_id) for e in events])
            now = _now().isoformat()
            with self.lock:
                self.db.executemany("UPDATE outbox SET delivered_at = ? WHERE event_id = ?",
                                    [(now, e.event_id) for e in events])
            sent += len(events)
        return sent
