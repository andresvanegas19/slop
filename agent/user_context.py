"""The user's own history as context: a read-only, bounded summary of RawTree `slop_human_user_prompts`.

The web app logs every user prompt (surface, action, outcome, duration, errors, ...). The research agent uses it to
focus research and to avoid asking what the user already expressed (durations, style words, companies).
SQL is fixed: fixed columns, one allowlisted table, a validated user_id, ORDER BY created_at, a LIMIT.
"""
import re
from typing import Dict, List, Optional

from contracts import TABLES

from .videos import query_optional

COLUMNS = ["event_id", "user_id", "project_id", "surface", "prompt", "action", "detected_by", "range_start_sec",
           "range_end_sec", "at_sec", "at_end", "enhanced_prompt", "outcome", "error", "result_summary",
           "video_sha256", "duration_sec", "created_at"]
USER_ID_RE = re.compile(r"^[A-Za-z0-9_.@:+\-]{1,128}$")
MAX_LIMIT = 50
STYLE_WORDS = ["warm", "cinematic", "nostalgic", "upbeat", "energetic", "calm", "minimal", "minimalist", "bold",
               "documentary", "premium", "luxury", "playful", "fun", "serious", "retro", "vintage", "modern",
               "futuristic", "dark", "moody", "bright", "colorful", "pastel", "golden hour", "slow motion",
               "handheld", "aerial", "drone", "close-up", "black and white", "anime", "3d", "realistic",
               "photorealistic", "emotional", "inspiring", "funny", "elegant", "clean", "gritty"]
FAIL_OUTCOMES = ("error", "failed", "failure", "rejected", "cancelled", "canceled")


def valid_user_id(user_id) -> Optional[str]:
    """The web app sends a UUID (X-Longform-User) or "anonymous"; anonymous means no user."""
    if isinstance(user_id, str) and USER_ID_RE.fullmatch(user_id.strip()) and user_id.strip() != "anonymous":
        return user_id.strip()
    return None


def _clip(text, n):
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[: n - 1] + "…"


def _num(value):
    try:
        return round(float(value), 1)
    except (TypeError, ValueError):
        return None


def user_context(rawtree, user_id: Optional[str] = None, limit: int = 15) -> dict:
    """Recent prompts (newest first) plus what they reveal: style words, durations, failures, surfaces."""
    if rawtree is None:
        return {"prompts": [], "note": "RawTree is not configured"}
    limit = max(1, min(int(limit), MAX_LIMIT))
    uid = valid_user_id(user_id)
    if user_id and uid is None:
        return {"error": "invalid user_id"}
    where = " WHERE toString(user_id) = '{}'".format(uid) if uid else ""  # user_id may be a UUID column
    table = TABLES["user_prompts"]
    rows = query_optional(rawtree, "SELECT {} FROM {}{} ORDER BY created_at DESC LIMIT {}".format(
        ", ".join(COLUMNS), table, where, limit), table)
    prompts: List[Dict] = []
    styles: Dict[str, int] = {}
    durations: Dict[str, int] = {}
    surfaces: Dict[str, int] = {}
    failures: List[Dict] = []
    for r in rows:
        text = _clip(r.get("prompt"), 300)
        if not text:
            continue
        outcome = str(r.get("outcome") or "").lower()
        item = {k: v for k, v in {
            "prompt": text, "surface": r.get("surface"), "action": r.get("action"), "outcome": outcome or None,
            "duration_sec": _num(r.get("duration_sec")), "project_id": r.get("project_id"),
            "result": _clip(r.get("result_summary"), 200) or None, "error": _clip(r.get("error"), 160) or None,
            "created_at": str(r.get("created_at") or "") or None}.items() if v not in (None, "")}
        prompts.append(item)
        low = text.lower()
        for w in STYLE_WORDS:
            if re.search(r"\b{}\b".format(re.escape(w)), low):
                styles[w] = styles.get(w, 0) + 1
        for m in re.findall(r"\b(\d{1,3})\s*(?:s|sec|secs|seconds?)\b", low):
            durations[m + "s"] = durations.get(m + "s", 0) + 1
        if item.get("duration_sec"):
            key = "{:g}s".format(item["duration_sec"])
            durations[key] = durations.get(key, 0) + 1
        if r.get("surface"):
            surfaces[str(r["surface"])] = surfaces.get(str(r["surface"]), 0) + 1
        if outcome in FAIL_OUTCOMES or r.get("error"):
            failures.append({"prompt": _clip(text, 160), "error": item.get("error") or outcome})
    if not prompts:
        return {"prompts": [], "note": "no prompts logged for this user yet"}
    top = lambda d: [k for k, _ in sorted(d.items(), key=lambda kv: -kv[1])][:8]  # noqa: E731
    return {"user_id": uid, "count": len(prompts), "prompts": prompts, "style_words": top(styles),
            "durations": top(durations), "surfaces": top(surfaces), "failures": failures[:5]}


def expressed_topics(ctx: dict) -> Dict[str, str]:
    """Question topics the user already expressed in past prompts -> what they said (for 'do not re-ask')."""
    out = {}
    if ctx.get("style_words"):
        out["tone"] = ", ".join(ctx["style_words"][:4])
    if ctx.get("durations"):
        out["format"] = ", ".join(ctx["durations"][:3])
    return out


def summary_line(ctx: dict, max_prompts: int = 6) -> str:
    if not ctx.get("prompts"):
        return "none"
    parts = ["recent requests: " + " | ".join(p["prompt"][:140] for p in ctx["prompts"][:max_prompts])]
    if ctx.get("style_words"):
        parts.append("style words they use: " + ", ".join(ctx["style_words"]))
    if ctx.get("durations"):
        parts.append("durations: " + ", ".join(ctx["durations"]))
    if ctx.get("failures"):
        parts.append("failed before: " + " | ".join("{} ({})".format(f["prompt"][:80], f["error"])
                                                   for f in ctx["failures"][:3]))
    return "; ".join(parts)
