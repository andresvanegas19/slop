"""Nimble-backed page fetching for research sessions (company and competitor websites).

`NimbleFetcher` has the same `fetch(url, allowed) -> Page` API as `agent.web.WebFetcher`, so research sessions and
competitor research use it unchanged. Pages are rendered by Nimble Extract (acquisition/nimble.py, JavaScript
rendered, retries on intermittent blocks); the same code-side rules still apply before anything is requested:
the session's host allowlist and robots.txt. Stylesheets (brand colors) are static files and are read directly.

`make_fetcher()` picks the fetcher from RESEARCH_FETCHER (auto | nimble | direct, default auto): Nimble when
NIMBLE_API_KEY is set, otherwise the direct fetcher, so research keeps working without a Nimble key.
"""
import asyncio
import logging
import os
import re
import socket
from typing import Callable, Optional
from urllib.parse import urlparse

from acquisition.nimble import NimbleClient, NimbleResult

from .web import MAX_TEXT_CHARS, FetchError, Page, WebFetcher, extract, host_of, normalize_url

log = logging.getLogger("agent.nimble")

COUNTRY = "US"
LOCALE = "en-US"
MIN_MARKDOWN_CHARS = 1000        # SPIKE_FINDINGS: shorter markdown is often a half-rendered page (nav only)
MD_LINK = re.compile(r"\[([^\]]{0,120})\]\((https?://[^)\s]+)\)")
STATIC_EXT = re.compile(r"\.css(\?|$)", re.I)


def _markdown_page(url: str, markdown: str, status: int) -> Page:
    """A Page from Nimble markdown when no HTML came back: text, headings and links from the markdown itself."""
    text = markdown[:MAX_TEXT_CHARS]
    headings = [h.strip("# ").strip()[:200] for h in re.findall(r"^#{1,4} .+$", text, re.M)][:60]
    links = []
    for anchor, href in MD_LINK.findall(text):
        target = normalize_url(href, url)
        if target and len(links) < 400:
            links.append((target, anchor.strip()[:120]))
    title = headings[0] if headings else ""
    return Page(url=url, status=status, title=title, text=text, headings=headings, links=links,
                content_type="text/markdown")


def dns_resolves(host: str) -> bool:
    try:
        socket.getaddrinfo(host, 443)
        return True
    except (socket.gaierror, UnicodeError, OSError):
        return False


def page_from_result(url: str, result: NimbleResult) -> Page:
    """Nimble result -> Page. HTML is preferred (links, meta, colors); markdown fills in thin or missing text."""
    status = result.http_status or 200
    if result.html:
        page = extract(url, result.html, "text/html", status)
        if result.markdown and len(page.text) < MIN_MARKDOWN_CHARS <= len(result.markdown):
            page.text = result.markdown[:MAX_TEXT_CHARS]
        return page
    if result.markdown:
        return _markdown_page(url, result.markdown, status)
    raise FetchError(result.error or "nimble returned no content")


class NimbleFetcher(WebFetcher):
    """One per session. `extractor(url) -> NimbleResult` and `resolver(host) -> bool` are injectable (tests);
    robots.txt is read with the direct client."""

    def __init__(self, api_key: str, client=None, extractor: Optional[Callable[[str], NimbleResult]] = None,
                 resolver: Optional[Callable[[str], bool]] = None, country: str = COUNTRY, locale: str = LOCALE):
        super().__init__(client=client)
        self.api_key = api_key
        self.country, self.locale = country, locale
        self.extractor = extractor or self._extract
        self.resolver = resolver or dns_resolves
        self.dns = {}

    def _extract(self, url: str) -> NimbleResult:
        async def run():
            async with NimbleClient(self.api_key, concurrency=1) as nimble:
                return await nimble.extract(url, render=True, country=self.country, locale=self.locale)
        return asyncio.run(run())  # each research thread gets its own short-lived event loop

    def resolves(self, host: str) -> bool:
        """Guessed domains ("acme.io") are checked with DNS first so they do not cost a 7-18 s Nimble render."""
        if host not in self.dns:
            self.dns[host] = self.resolver(host)
        return self.dns[host]

    def fetch(self, url: str, allowed=None, max_redirects=5) -> Page:
        target = normalize_url(url)
        if target is None:
            raise FetchError("invalid URL")
        if STATIC_EXT.search(urlparse(target).path):
            return super().fetch(target, allowed=allowed, max_redirects=max_redirects)
        if allowed is not None and not allowed(target):
            raise FetchError("host not allowed for this company: {}".format(host_of(target)))
        if not self.resolves(host_of(target)):
            raise FetchError("{} does not resolve".format(host_of(target)))
        if not self.allowed_by_robots(target):
            raise FetchError("robots.txt disallows {}".format(urlparse(target).path or "/"))
        result = self.extractor(target)
        if result.error and not (result.html or result.markdown):
            raise FetchError("nimble: {}".format(result.error)[:300])
        return page_from_result(target, result)


def fetcher_mode() -> str:
    mode = os.environ.get("RESEARCH_FETCHER", "").strip().lower() or "auto"
    return mode if mode in ("auto", "nimble", "direct") else "auto"


def make_fetcher() -> WebFetcher:
    """Factory for ResearchManager(fetcher_factory=...) and competitor research. Call after the .env is loaded."""
    key = os.environ.get("NIMBLE_API_KEY", "").strip()
    mode = fetcher_mode()
    if mode == "direct" or (mode == "auto" and not key):
        return WebFetcher()
    if not key:
        raise FetchError("RESEARCH_FETCHER=nimble but NIMBLE_API_KEY is not set in .env")
    return NimbleFetcher(key)


def fetcher_name() -> str:
    key = bool(os.environ.get("NIMBLE_API_KEY", "").strip())
    mode = fetcher_mode()
    if mode == "direct" or (mode == "auto" and not key):
        return "direct"
    return "nimble" if key else "missing-nimble-key"
