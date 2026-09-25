"""ResearchStore: research sessions in agent.db (state, an append-only event log, and fetched page text).

The web app polls / streams from here, and a restarted worker finds its sessions again. Page text is kept so a
resumed session can still verify that finding quotes appear on the page.
"""
import json
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Dict, List, Optional

from contracts import ResearchSessionState

SCHEMA = """
CREATE TABLE IF NOT EXISTS research_sessions (session_id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS research_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
    at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, seq));
CREATE TABLE IF NOT EXISTS research_pages (session_id TEXT NOT NULL, url TEXT NOT NULL, fetched_at TEXT NOT NULL,
    data TEXT NOT NULL, PRIMARY KEY (session_id, url));
"""


def _now():
    return datetime.now(timezone.utc)


class ResearchStore:
    def __init__(self, path="agent.db"):
        self.db = sqlite3.connect(path, isolation_level=None, check_same_thread=False, timeout=30)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        self.lock = threading.Lock()

    # --- sessions ---------------------------------------------------------------------------------------------
    def save(self, state: ResearchSessionState):
        state.updated_at = _now()
        with self.lock:
            self.db.execute(
                "INSERT INTO research_sessions VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET "
                "updated_at = excluded.updated_at, status = excluded.status, data = excluded.data",
                (state.session_id, state.created_at.isoformat(), state.updated_at.isoformat(), state.status.value,
                 state.model_dump_json()))

    def load(self, session_id: str) -> Optional[ResearchSessionState]:
        with self.lock:
            row = self.db.execute("SELECT data FROM research_sessions WHERE session_id = ?", (session_id,)).fetchone()
        return ResearchSessionState.model_validate_json(row[0]) if row else None

    def sessions(self, statuses=None, limit=50) -> List[ResearchSessionState]:
        sql, args = "SELECT data FROM research_sessions", []
        if statuses:
            sql += " WHERE status IN ({})".format(",".join("?" * len(statuses)))
            args = list(statuses)
        with self.lock:
            rows = self.db.execute(sql + " ORDER BY updated_at DESC LIMIT ?", args + [limit]).fetchall()
        return [ResearchSessionState.model_validate_json(r[0]) for r in rows]

    # --- events -----------------------------------------------------------------------------------------------
    def append_event(self, session_id: str, type_: str, data: Dict) -> Dict:
        at = _now().isoformat()
        with self.lock:
            row = self.db.execute("SELECT COALESCE(MAX(seq), 0) FROM research_events WHERE session_id = ?",
                                  (session_id,)).fetchone()
            seq = row[0] + 1
            event = {"seq": seq, "type": type_, "at": at, **data}
            self.db.execute("INSERT INTO research_events VALUES (?, ?, ?, ?, ?)",
                            (session_id, seq, type_, at, json.dumps(event, default=str, ensure_ascii=False)))
        return event

    def events(self, session_id: str, after: int = 0, limit: int = 500) -> List[Dict]:
        with self.lock:
            rows = self.db.execute("SELECT data FROM research_events WHERE session_id = ? AND seq > ? ORDER BY seq "
                                   "LIMIT ?", (session_id, int(after), int(limit))).fetchall()
        return [json.loads(r[0]) for r in rows]

    # --- pages ------------------------------------------------------------------------------------------------
    def save_page(self, session_id: str, url: str, page: Dict):
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO research_pages VALUES (?, ?, ?, ?)",
                            (session_id, url, _now().isoformat(), json.dumps(page, ensure_ascii=False)))

    def pages(self, session_id: str) -> Dict[str, Dict]:
        with self.lock:
            rows = self.db.execute("SELECT url, data FROM research_pages WHERE session_id = ?",
                                   (session_id,)).fetchall()
        return {url: json.loads(data) for url, data in rows}
