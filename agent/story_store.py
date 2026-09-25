"""StoryStore: competitor research and storylines of research sessions, in agent.db next to research_store.py.

Competitor pages live in their own table so they never mix into the company's page cache (research_pages), which a
research session reloads and extracts findings from.
"""
import json
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Dict, List, Optional

from contracts.story import CompetitiveLandscape, StoryPlan

SCHEMA = """
CREATE TABLE IF NOT EXISTS research_competitors (session_id TEXT PRIMARY KEY, updated_at TEXT NOT NULL,
    status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS research_competitor_pages (session_id TEXT NOT NULL, url TEXT NOT NULL,
    fetched_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, url));
CREATE TABLE IF NOT EXISTS research_storylines (session_id TEXT NOT NULL, version INTEGER NOT NULL,
    created_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, version));
"""


def _now():
    return datetime.now(timezone.utc)


class StoryStore:
    def __init__(self, path="agent.db"):
        self.db = sqlite3.connect(path, isolation_level=None, check_same_thread=False, timeout=30)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        self.lock = threading.Lock()

    # --- competitors ------------------------------------------------------------------------------------------------
    def save_landscape(self, landscape: CompetitiveLandscape):
        landscape.updated_at = _now()
        with self.lock:
            self.db.execute(
                "INSERT INTO research_competitors VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET "
                "updated_at = excluded.updated_at, status = excluded.status, data = excluded.data",
                (landscape.session_id, landscape.updated_at.isoformat(), landscape.status,
                 landscape.model_dump_json()))

    def landscape(self, session_id: str) -> Optional[CompetitiveLandscape]:
        with self.lock:
            row = self.db.execute("SELECT data FROM research_competitors WHERE session_id = ?",
                                  (session_id,)).fetchone()
        return CompetitiveLandscape.model_validate_json(row[0]) if row else None

    def landscape_ids(self) -> List[str]:
        with self.lock:
            return [r[0] for r in self.db.execute("SELECT session_id FROM research_competitors").fetchall()]

    def save_page(self, session_id: str, url: str, page: Dict):
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO research_competitor_pages VALUES (?, ?, ?, ?)",
                            (session_id, url, _now().isoformat(), json.dumps(page, ensure_ascii=False)))

    def pages(self, session_id: str) -> Dict[str, Dict]:
        with self.lock:
            rows = self.db.execute("SELECT url, data FROM research_competitor_pages WHERE session_id = ?",
                                   (session_id,)).fetchall()
        return {url: json.loads(data) for url, data in rows}

    # --- storylines -------------------------------------------------------------------------------------------------
    def save_storyline(self, plan: StoryPlan):
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO research_storylines VALUES (?, ?, ?, ?)",
                            (plan.session_id, plan.version, plan.updated_at.isoformat(), plan.model_dump_json()))

    def storyline(self, session_id: str) -> Optional[StoryPlan]:
        with self.lock:
            row = self.db.execute("SELECT data FROM research_storylines WHERE session_id = ? ORDER BY version DESC "
                                  "LIMIT 1", (session_id,)).fetchone()
        return StoryPlan.model_validate_json(row[0]) if row else None
