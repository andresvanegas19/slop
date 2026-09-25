"""Nimble Extract client (SPIKE_FINDINGS: POST /v2/extract, Bearer key, 7-18 s per rendered page)."""
import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import httpx

EXTRACT_URL = "https://sdk.nimbleway.com/v2/extract"
RETRY_CODES = {403, 429, 500, 502, 503, 504}   # sites block intermittently; the next attempt often succeeds
MAX_ATTEMPTS = 3
RENDER_WAIT_MS = 3000                          # without it Notion truncates and Jira renders no prices


@dataclass
class NimbleResult:
    """One logical fetch after retries. `http_status` is the target site's status, not Nimble's."""
    url: str
    fetched_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    http_status: Optional[int] = None
    markdown: str = ""
    html: str = ""
    task_id: Optional[str] = None
    driver: Optional[str] = None
    attempts: int = 0
    error: Optional[str] = None
    raw: Optional[dict] = field(default=None, repr=False)


class NimbleClient:
    def __init__(self, api_key: str, concurrency: int = 4, timeout: float = 120.0, backoff: float = 2.0):
        self._client = httpx.AsyncClient(headers={"Authorization": "Bearer " + api_key}, timeout=timeout)
        self._sem = asyncio.Semaphore(concurrency)
        self._backoff = backoff

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self._client.aclose()

    async def extract(self, url: str, render: bool = True, driver: Optional[str] = None,
                      country: Optional[str] = None, locale: Optional[str] = None,
                      wait_ms: int = RENDER_WAIT_MS) -> NimbleResult:
        # Pin country and locale: an unpinned proxy once served Notion in EUR, which looks like a price change.
        body = {"url": url, "render": render, "formats": ["markdown", "html"]}
        for k, v in (("driver", driver), ("country", country), ("locale", locale)):
            if v:
                body[k] = v
        if wait_ms and render:
            body["browser_actions"] = [{"wait": {"duration": wait_ms}}]
        result = NimbleResult(url=url)
        async with self._sem:
            for attempt in range(1, MAX_ATTEMPTS + 1):
                result.attempts = attempt
                result.fetched_at = datetime.now(timezone.utc)
                try:
                    r = await self._client.post(EXTRACT_URL, json=body)
                except httpx.HTTPError as e:
                    result.error = "{}: {}".format(type(e).__name__, e)
                else:
                    if r.status_code == 200:
                        return _parse(result, r.json())
                    result.http_status = r.status_code
                    result.error = "nimble HTTP {}: {}".format(r.status_code, r.text[:200])
                    if r.status_code not in RETRY_CODES:
                        return result
                if attempt < MAX_ATTEMPTS:
                    await asyncio.sleep(self._backoff * attempt)
        return result


def _parse(result: NimbleResult, res: dict) -> NimbleResult:
    data = res.get("data") or {}
    result.raw = res
    result.http_status = res.get("status_code")
    result.markdown = data.get("markdown") or ""
    result.html = data.get("html") or ""
    result.task_id = res.get("task_id")
    result.driver = (res.get("metadata") or {}).get("driver")
    result.error = None if res.get("status") == "success" else "nimble status {!r}".format(res.get("status"))
    return result
