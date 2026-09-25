"""RawTree client. The database is shared by every hackathon team and has no delete (DECISIONS D5)."""
import asyncio

import httpx

from contracts import EvidenceEnvelope
from contracts.common import TABLES

BASE_URL = "https://api.rawtree.com/v1"
OBSERVATION_TABLE = TABLES["observation"]
MAX_ATTEMPTS = 3


class RawTreeClient:
    def __init__(self, api_key: str, timeout: float = 30.0):
        self._client = httpx.AsyncClient(base_url=BASE_URL, headers={"Authorization": "Bearer " + api_key},
                                         timeout=timeout)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self._client.aclose()

    async def insert(self, envelopes: list[EvidenceEnvelope], table: str = OBSERVATION_TABLE) -> None:
        if not table.startswith(OBSERVATION_TABLE):
            raise ValueError("refusing to write {!r}: only slop_human* tables are ours".format(table))
        rows = [e.model_dump(mode="json") for e in envelopes]
        await self._post("/tables/{}".format(table), rows)

    async def query(self, sql: str) -> dict:
        return await self._post("/query", {"sql": sql})

    async def _post(self, path: str, body) -> dict:
        last = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                r = await self._client.post(path, json=body)
                if r.status_code == 200:
                    return r.json()
                last = "HTTP {}: {}".format(r.status_code, r.text[:300])
                if r.status_code < 500 and r.status_code != 429:
                    break
            except httpx.HTTPError as e:
                last = "{}: {}".format(type(e).__name__, e)
            if attempt < MAX_ATTEMPTS:
                await asyncio.sleep(2 * attempt)
        raise RuntimeError("RawTree {} failed: {}".format(path, last))
