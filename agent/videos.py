"""Past videos as context: a read-only, bounded summary of RawTree `slop_human_video_events`.

The web app publishes one row per video version (project_id, kind, title, reason, duration_sec, frames JSON with
prompts/edits, storyboard, chat summary, research_session_id, created_at, ...). The SQL here is fixed: one allowlisted
table, ORDER BY created_at, a LIMIT. Columns are read defensively because the schema is owned by another team;
company filtering happens in Python. A missing table ("not published yet") is an empty result, not an error.
"""
import json
import time
from typing import Dict, List, Optional

from contracts import TABLES

MAX_VIDEOS = 10
MISSING_TTL_S = 300
_missing_until: Dict[str, float] = {}


def _json(value):
    if isinstance(value, (list, dict)):
        return value
    if isinstance(value, str) and value.strip()[:1] in ("[", "{"):
        try:
            return json.loads(value)
        except ValueError:
            return None
    return None


def _clip(text, n):
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[: n - 1] + "…"


def _first(row: dict, *keys):
    for k in keys:
        if row.get(k) not in (None, "", "null"):
            return row[k]
    return None


def _truthy(value) -> bool:
    return str(value).lower() in ("true", "1")


def _is_missing(text: str) -> bool:
    text = text.lower()
    return "not found" in text or "unknown table" in text or "unknown_table" in text or "doesn't exist" in text


def query_optional(rawtree, sql: str, table: str) -> List[dict]:
    """One query on a table another team may not have created yet: a missing table returns []. core's
    RawTreeClient retries ~12 s on unknown errors, so for it we send a single request and map the error here."""
    if _missing_until.get(table, 0) > time.time():
        return []
    try:
        if hasattr(rawtree, "key") and hasattr(rawtree, "base"):
            from core.http import request_json
            status, res = request_json("POST", rawtree.base + "/query", rawtree.key, {"sql": sql}, timeout=20)
            if status != 200:
                raise RuntimeError("RawTree query failed: HTTP {} {}".format(status, str(res)[:300]))
            return (res or {}).get("data", [])
        return rawtree.query(sql) or []
    except RuntimeError as e:
        if _is_missing(str(e)) and "column" not in str(e).lower():
            _missing_until[table] = time.time() + MISSING_TTL_S
            return []
        raise


def _frames(value) -> tuple:
    prompts, edits = [], []
    frames = _json(value)
    if isinstance(frames, dict):
        frames = frames.get("frames") or list(frames.values())
    for f in frames if isinstance(frames, list) else []:
        if not isinstance(f, dict):
            continue
        p = _first(f, "prompt", "image_prompt", "imagePrompt", "visual", "description")
        if p:
            prompts.append(_clip(p, 220))
        for key in ("edits", "history", "edit_history", "editHistory", "instructions"):
            for e in f.get(key) or [] if isinstance(f.get(key), list) else []:
                text = _first(e, "instruction", "prompt", "text", "summary") if isinstance(e, dict) else e
                if text:
                    edits.append(_clip(text, 160))
    return prompts, edits


def summarize_row(row: dict) -> dict:
    prompts, edits = _frames(_first(row, "frames", "frames_json"))
    storyboard = _json(_first(row, "storyboard", "storyboard_json"))
    headline = None
    if isinstance(storyboard, dict):
        headline = _first(storyboard, "headline", "title")
    try:
        duration = round(float(_first(row, "duration_sec", "duration_seconds", "durationSeconds") or 0), 1) or None
    except (TypeError, ValueError):
        duration = None
    return {k: v for k, v in {
        "project_id": _first(row, "project_id", "projectId"), "kind": row.get("kind"),
        "title": _clip(_first(row, "title") or headline or "", 160) or None,
        "reason": _clip(row.get("reason") or "", 200) or None,
        "company": _first(row, "company", "company_name", "entity_name"),
        "research_session_id": _first(row, "research_session_id", "researchSessionId"),
        "prompt": _clip(_first(row, "prompt", "user_prompt") or "", 300) or None,
        "duration_sec": duration, "created_at": str(row.get("created_at") or "") or None,
        "frame_prompts": prompts[:6], "edits": edits[:8],
        "chat_summary": _clip(_first(row, "chat_summary", "chat", "summary") or "", 400) or None,
    }.items() if v not in (None, [], "")}


def recent_videos(rawtree, limit: int = 5, company: Optional[str] = None, research_session_ids=()) -> dict:
    """Latest version of up to `limit` projects, newest first, with the reasons of earlier versions (edit history).
    `company` keeps rows whose company / title / prompt / research session mentions it."""
    if rawtree is None:
        return {"videos": [], "note": "RawTree is not configured"}
    limit = max(1, min(int(limit), MAX_VIDEOS))
    rows = query_optional(rawtree, "SELECT * FROM {} ORDER BY created_at DESC LIMIT {}".format(
        TABLES["video"], limit * 8), TABLES["video"])
    needle = "".join(ch for ch in (company or "").lower() if ch.isalnum())
    sessions = set(research_session_ids or ())
    projects: Dict[str, dict] = {}
    for row in rows:
        if _truthy(row.get("is_test")):
            continue
        v = summarize_row(row)
        if needle:
            hay = "".join(ch for ch in " ".join(str(v.get(k, "")) for k in (
                "company", "title", "prompt", "chat_summary")).lower() if ch.isalnum())
            if needle not in hay and v.get("research_session_id") not in sessions:
                continue
        key = str(v.get("project_id") or v.get("title") or len(projects))
        if key in projects:
            if v.get("reason"):
                projects[key].setdefault("earlier_versions", []).append(v["reason"])
            continue
        if len(projects) >= limit:
            continue
        projects[key] = v
    out = list(projects.values())
    for v in out:
        if "earlier_versions" in v:
            v["earlier_versions"] = v["earlier_versions"][:6]
    return {"videos": out, "count": len(out)} if out else {"videos": [], "note": "no videos published yet"}
