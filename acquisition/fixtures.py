"""Recorded Nimble responses, so normalization and status tests run without the network."""
import gzip
import json
from datetime import datetime, timezone
from pathlib import Path

from .env import ROOT
from .nimble import NimbleResult

FIXTURE_DIR = ROOT / "tests" / "fixtures" / "nimble"
NOWAIT_DIR = ROOT / "tests" / "fixtures" / "nimble_nowait"   # first batch: no country pin, no render wait


def save(source_id: str, result: NimbleResult, root: Path = FIXTURE_DIR) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = root / source_id / "{}.json.gz".format(stamp)
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = {"source_id": source_id, "url": result.url, "attempts": result.attempts,
           "error": result.error, "http_status": result.http_status, "response": result.raw}
    with gzip.open(path, "wt") as f:
        json.dump(doc, f)
    return path


def load(path: Path) -> NimbleResult:
    with gzip.open(path, "rt") as f:
        doc = json.load(f)
    res = doc.get("response") or {}
    data = res.get("data") or {}
    query_time = (res.get("metadata") or {}).get("query_time")
    fetched_at = (datetime.fromisoformat(query_time.replace("Z", "+00:00")) if query_time
                  else datetime.strptime(path.name.split(".")[0], "%Y%m%dT%H%M%S%fZ").replace(tzinfo=timezone.utc))
    return NimbleResult(
        url=doc["url"],
        fetched_at=fetched_at,
        http_status=res.get("status_code", doc.get("http_status")),
        markdown=data.get("markdown") or "",
        html=data.get("html") or "",
        task_id=res.get("task_id"),
        driver=(res.get("metadata") or {}).get("driver"),
        attempts=doc.get("attempts", 1),
        error=doc.get("error"),
        raw=res or None,
    )


def all_for(source_id: str, root: Path = FIXTURE_DIR) -> list[Path]:
    return sorted((root / source_id).glob("*.json.gz"))
