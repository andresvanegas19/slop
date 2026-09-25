"""Nimble Search client (POST /v2/search, ~1-2 s per call). Finds competitors and recent content to fetch.

Quirks (verified live): search_depth="standard" is only accepted with focus="general" (else HTTP 422);
results carry no published date and `content` is empty unless full_content=true, which took >60 s, so we
never ask for it: pages are fetched with Nimble Extract instead.
"""
import asyncio
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

import httpx

SEARCH_URL = "https://sdk.nimbleway.com/v2/search"
RETRY_CODES = {429, 500, 502, 503, 504}
MAX_ATTEMPTS = 3

# Hosts that rarely carry a company's own news: review aggregators, social, and stock quote/filing pages.
# Their titles and descriptions still name competitors, so discovery reads them; we just never fetch them
# or take them as a company's domain.
LOW_VALUE_HOSTS = {
    "g2.com", "capterra.com", "getapp.com", "trustradius.com", "alternativeto.net", "softwaresuggest.com",
    "sourceforge.net", "producthunt.com", "trustpilot.com", "saasworthy.com", "crozdesk.com",
    "reddit.com", "youtube.com", "linkedin.com", "x.com", "twitter.com", "facebook.com", "instagram.com",
    "medium.com", "quora.com", "tiktok.com", "wikipedia.org",
    "finance.yahoo.com", "stocktitan.net", "marketbeat.com", "simplywall.st", "sec.gov", "tradingview.com",
    "zacks.com", "nasdaq.com", "stockanalysis.com", "macrotrends.net", "seekingalpha.com", "fool.com",
}
LOW_VALUE_PATH_PREFIXES = {"investing.com": ("/equities/", "/quote"), "cnbc.com": ("/quotes/",),
                           "marketwatch.com": ("/investing/stock/",), "google.com": ("/finance",)}
TWO_LEVEL_SUFFIXES = {"co.uk", "com.au", "co.jp", "com.br", "co.in", "co.nz", "com.mx", "com.sg", "co.za"}


@dataclass(frozen=True)
class SearchHit:
    title: str
    url: str
    description: str
    position: int
    entity_type: str        # OrganicResult | NewsResult | SearchResult
    query: str


def host_of(url: str) -> str:
    """'https://www.Monday.com/blog' -> 'monday.com'. Subdomains other than www are kept."""
    host = (urlsplit(url if "//" in url else "//" + url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def registered_domain(url_or_host: str) -> str:
    """'blog.hubspot.com' -> 'hubspot.com'; 'shop.acme.co.uk' -> 'acme.co.uk'."""
    parts = host_of(url_or_host).split(".")
    n = 3 if ".".join(parts[-2:]) in TWO_LEVEL_SUFFIXES else 2
    return ".".join(parts[-n:])


def domain_label(url_or_host: str) -> str:
    """'blog.hubspot.com' -> 'hubspot'. What a company name is compared against."""
    return registered_domain(url_or_host).split(".")[0]


def is_low_value(url: str) -> bool:
    host = host_of(url)
    if host in LOW_VALUE_HOSTS or registered_domain(host) in LOW_VALUE_HOSTS:
        return True
    prefixes = LOW_VALUE_PATH_PREFIXES.get(registered_domain(host), ())
    return bool(prefixes) and (urlsplit(url).path or "/").startswith(prefixes)


def normalize_url(url: str) -> str:
    """Dedup key: no scheme, www, query, fragment or trailing slash (tracking params make one article many URLs)."""
    p = urlsplit(url)
    return urlunsplit(("", host_of(url), p.path.rstrip("/"), "", "")).lstrip("/")


class NimbleSearch:
    def __init__(self, api_key: str, concurrency: int = 4, timeout: float = 45.0, backoff: float = 2.0,
                 country: Optional[str] = "US", locale: Optional[str] = "en-US"):
        self._client = httpx.AsyncClient(headers={"Authorization": "Bearer " + api_key}, timeout=timeout)
        self._sem = asyncio.Semaphore(concurrency)
        self._backoff = backoff
        self.country, self.locale = country, locale
        self.calls = 0
        self.errors: list[str] = []      # a failed search returns [] so one bad query can't sink a run

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self._client.aclose()

    async def search(self, query: str, focus: str = "general", max_results: int = 10,
                     time_range: Optional[str] = None, include_domains: Optional[list[str]] = None,
                     exclude_domains: Optional[list[str]] = None) -> list[SearchHit]:
        body = {"query": query, "max_results": max_results, "focus": focus}
        if focus == "general":
            body["search_depth"] = "lite"
        for k, v in (("time_range", time_range), ("include_domains", include_domains),
                     ("exclude_domains", exclude_domains), ("country", self.country), ("locale", self.locale)):
            if v:
                body[k] = v
        async with self._sem:
            for attempt in range(1, MAX_ATTEMPTS + 1):
                self.calls += 1
                try:
                    r = await self._client.post(SEARCH_URL, json=body)
                except httpx.HTTPError as e:
                    error = "{}: {}".format(type(e).__name__, e)
                else:
                    if r.status_code == 200:
                        return parse_results(r.json(), query)
                    error = "HTTP {}: {}".format(r.status_code, r.text[:200])
                    if r.status_code not in RETRY_CODES:
                        break
                if attempt < MAX_ATTEMPTS:
                    await asyncio.sleep(self._backoff * attempt)
        self.errors.append("{!r}: {}".format(query, error))
        return []


def parse_results(res: dict, query: str) -> list[SearchHit]:
    hits = []
    for i, r in enumerate(res.get("results") or []):
        meta = r.get("metadata") or {}
        if not r.get("url"):
            continue
        hits.append(SearchHit(title=(r.get("title") or "").strip(), url=r["url"],
                              description=(r.get("description") or "").strip(),
                              position=int(meta.get("position") or i + 1),
                              entity_type=meta.get("entity_type") or "", query=query))
    return hits
