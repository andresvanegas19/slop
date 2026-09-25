"""Where evidence comes from: RawTree `slop_human` (A's rows) or a local folder of envelope JSON files."""
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Tuple

from contracts import TABLES, EvidenceEnvelope

from .http import request_json

RAWTREE_BASE = "https://api.rawtree.com/v1"

# Rows written while spiking. RawTree can't delete them, so every reader skips them.
SPIKE_TEST_RUNS = ("run_20260925T194641Z", "run_20260925T194801Z")
TEST_RUN_PREFIXES = ("test_",)


class RawTreeClient:
    def __init__(self, key, base=RAWTREE_BASE):
        self.key, self.base = key, base

    def query(self, sql, retries=3):
        for attempt in range(retries):
            status, res = request_json("POST", self.base + "/query", self.key, {"sql": sql})
            if status == 200:
                return res.get("data", [])
            if "UNKNOWN_TABLE" in str(res) or "Unknown table" in str(res):
                return []
            time.sleep(2 * (attempt + 1))  # a just-created table takes a few seconds to become queryable
        raise RuntimeError("RawTree query failed: HTTP {} {}".format(status, res))

    def insert(self, table, rows):
        status, res = request_json("POST", "{}/tables/{}".format(self.base, table), self.key, rows)
        if status != 200:
            raise RuntimeError("RawTree insert into {} failed: HTTP {} {}".format(table, status, res))


def parse_ts(value):
    """RawTree returns '2026-09-25 20:27:50.291301000'; files hold ISO strings. Always returns aware UTC."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    s = str(value).replace("T", " ").replace("Z", "").split("+")[0]
    if "." in s:
        head, frac = s.split(".", 1)
        s = head + "." + frac[:6]
        dt = datetime.strptime(s, "%Y-%m-%d %H:%M:%S.%f")
    else:
        dt = datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
    return dt.replace(tzinfo=timezone.utc)


def row_to_envelope(row):
    """RawTree flattens nested dicts (section_hashes.pricing); fold them back."""
    d = {k: v for k, v in row.items() if "." not in k and not k.startswith("_") and v is not None}
    d["section_hashes"] = {k.split(".", 1)[1]: v for k, v in row.items()
                           if k.startswith("section_hashes.") and v}
    d["fetched_at"] = parse_ts(row["fetched_at"])
    return EvidenceEnvelope(**d)


def is_test_run(run_id):
    return run_id in SPIKE_TEST_RUNS or str(run_id).startswith(TEST_RUN_PREFIXES)


class RawTreeSource:
    name = "rawtree"

    def __init__(self, client, table=TABLES["observation"]):
        self.client, self.table = client, table

    def fetch_new(self, cursor) -> List[Tuple[EvidenceEnvelope, str]]:
        excluded = ", ".join("'{}'".format(r) for r in SPIKE_TEST_RUNS)
        sql = ("SELECT *, toString(fetched_at) AS _ts FROM {} "
               "WHERE toString(fetched_at) > '{}' AND toString(run_id) NOT IN ({}) "
               "ORDER BY fetched_at").format(self.table, cursor or "1970-01-01 00:00:00", excluded)
        out = []
        for row in self.client.query(sql):
            if is_test_run(row.get("run_id", "")):
                continue
            out.append((row_to_envelope(row), row["_ts"]))
        return out


class LocalSource:
    """A folder of EvidenceEnvelope JSON files. Used by tests and offline demos."""
    name = "local"

    def __init__(self, folder):
        self.folder = Path(folder)

    def fetch_new(self, cursor):
        envs = [EvidenceEnvelope(**json.loads(p.read_text())) for p in sorted(self.folder.glob("*.json"))]
        envs = [e for e in envs if not is_test_run(e.run_id)]
        envs.sort(key=lambda e: e.fetched_at)
        return [(e, e.fetched_at.isoformat()) for e in envs if e.fetched_at.isoformat() > (cursor or "")]
