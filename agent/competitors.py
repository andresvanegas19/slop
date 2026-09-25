"""Competitor research for a research session: the agent names the company's competitors and scrapes their sites.

  CompanyProfile ──► candidates: config/watch.yaml peers (when the company is tracked) + Liquid's proposals
                ──► verify: fetch the homepage (Nimble), keep it only if it mentions the competitor's name
                ──► 1-N pages per competitor (home, pricing, products, about), each page's facts extracted by
                    Liquid and kept only when the quote is on the page (checked in code)
                ──► CompetitiveLandscape: the company's differentiators (citing the company's own findings), what
                    competitors emphasise, and `avoid_terms` (competitor names) that never reach the video

Competitor pages are fetched with the same fetcher as the session (agent/nimble_fetch.py) under a per-competitor
host allowlist. Events are appended to the session's event log (`competitor`, `competitors`) so the web app streams
them with the rest of the research.
"""
import logging
import re
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, List, Optional

import yaml

from contracts.research import Finding, PageVisit, ResearchSessionState, SourcedText
from contracts.story import COMPETITOR_TOPICS, CompetitiveLandscape, Competitor
from core.logs import event, in_context

from .research_tools import MAX_QUOTE_CHARS, MIN_QUOTE_CHARS, clean_quote, norm, quote_in_page
from .story_llm import JsonLlm
from .web import (EXPECTED_FETCH_ERRORS, HostNotAllowed, Page, compact, fetch_error_reason, home_guard, home_problem,
                  host_of, link_category, normalize_url,
                  prioritized_links, site_of, slugs)

log = logging.getLogger("agent.competitors")

MAX_CANDIDATES = 6
MAX_FINDINGS_PER_PAGE = 6
EXTRACT_PAGE_CHARS = 20000
CATEGORY_BOOST = {"pricing": 6, "products": 5, "about": 3}
DOMAIN_RE = re.compile(r"^(?:[a-z0-9-]+\.)+[a-z]{2,}$")
GENERIC_WORDS = {"the", "your", "open", "global", "united", "general", "american", "national", "international",
                 "first", "best", "smart", "digital", "cloud", "software", "group", "company", "brand", "world"}

COMPETITORS_PROMPT = """[task:competitors] {name} ({domain}): {one_line}
What they do: {what}
Products: {products}
Name up to {n} direct competitors of {name}: other companies that sell a similar product to the same customers. Use their real, commonly known names and main website domains. Do not include {name} itself, its own brands, or its parent company.
Reply with only JSON: {{"competitors": [{{"name": "<company>", "domain": "<example.com>", "reason": "<why it competes, one sentence>"}}]}}"""

EXTRACT_PROMPT = """[task:competitor_extract] Page of {competitor}'s website (a competitor of {company}): {url}
Title: {title}
---
{text}
---
List up to {n} facts about how {competitor} positions itself: what it offers, who it is for, its pricing or plans, the main benefits it claims, and proof it shows.
Each quote MUST be copied exactly from the page text above (12-250 characters).
Reply with only JSON: {{"summary": "<one sentence: how {competitor} positions itself>", "findings": [{{"topic": "<one of {topics}>", "claim": "<the fact in your words>", "quote": "<exact text from the page>"}}]}}"""

LANDSCAPE_PROMPT = """[task:landscape] Company: {name}. {one_line}
Video goal: {goal}
Company findings (cite by id):
{findings}
Competitors (internal research notes, never shown in the video):
{competitors}
Write how {name} stands apart from these competitors, using ONLY the company findings as evidence. Never mention competitor names.
Reply with only JSON: {{"differentiators": [{{"text": "<a strength of {name}, one sentence, no competitor names>", "findings": ["F1"]}}], "competitor_themes": ["<what competitors commonly emphasise, no names>"]}}"""


def _now():
    return datetime.now(timezone.utc)


def _clip(text, n):
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def name_terms(name: str, domain: Optional[str] = None) -> List[str]:
    """Words that identify a competitor in text: its name, name variants and its domain label."""
    terms = [name.strip()]
    terms += [s for s in slugs(name) if len(s) >= 3]
    first = re.split(r"[\s\-]+", name.strip())[0]
    if len(first) >= 4 and first.lower() not in GENERIC_WORDS:
        terms.append(first)
    if domain:
        terms += [domain, domain.split(".")[0]]
    out, seen = [], set()
    for t in terms:
        key = t.lower()
        if len(key) >= 3 and key not in seen:
            seen.add(key)
            out.append(t)
    return out


def mentions(text: str, terms: List[str]) -> List[str]:
    """Terms that appear in `text` as whole words (case-insensitive; '-', '.' and spaces are interchangeable)."""
    squashed = " " + re.sub(r"[^a-z0-9]+", " ", (text or "").lower()) + " "
    joined = squashed.replace(" ", "")
    found = []
    for term in terms:
        t = re.sub(r"[^a-z0-9]+", " ", term.lower()).strip()
        if t and (" {} ".format(t) in squashed or (" " in t and t.replace(" ", "") in joined)):
            found.append(term)
    return found


def watch_peers(watch_file: str, company: str) -> List[dict]:
    """Other tracked entities of config/watch.yaml when the company is one of them (e.g. Notion -> Linear, Jira)."""
    try:
        data = yaml.safe_load(Path(watch_file).read_text()) or {}
    except FileNotFoundError:
        return []
    except (OSError, yaml.YAMLError) as e:  # a broken config should be visible, but never block research
        event(log, "watch_file_unreadable", logging.WARNING, path=watch_file, error="{}: {}".format(
            type(e).__name__, str(e)[:200]))
        return []
    sources = data.get("sources") or []
    names: Dict[str, dict] = {}
    for s in sources:
        eid = str(s.get("entity_id") or "")
        if eid and eid not in names:
            url = normalize_url(str(s.get("seed_url") or ""))
            names[eid] = {"name": str(s.get("entity_name") or eid), "domain": site_of(host_of(url)) if url else None}
    key = compact(company)
    if not key or not any(key in (compact(eid), compact(v["name"])) for eid, v in names.items()):
        return []
    return [dict(v, reason="tracked competitor in config/watch.yaml") for eid, v in names.items()
            if key not in (compact(eid), compact(v["name"]))]


class CompetitorResearch:
    """Researches one session's competitors. `run()` never raises; progress goes to the session's event log."""

    def __init__(self, state: ResearchSessionState, research_store, story_store, fetcher, llm: JsonLlm,
                 watch_file: str, max_competitors: int = 3, pages_per_competitor: int = 3,
                 stopped: Optional[Callable[[], bool]] = None, parallel: int = 1):
        self.state, self.research_store, self.story_store = state, research_store, story_store
        self.fetcher, self.llm, self.watch_file = fetcher, llm, watch_file
        self.max_competitors, self.pages_per_competitor = max_competitors, pages_per_competitor
        self.stopped = stopped or (lambda: False)
        self.parallel = max(1, parallel)  # competitors verified / researched at the same time
        self.sid = state.session_id
        self.company = state.profile.name if state.profile else (state.intent.company_name if state.intent else "")
        self.pages: Dict[str, dict] = story_store.pages(self.sid)
        self.landscape = story_store.landscape(self.sid) or CompetitiveLandscape(
            session_id=self.sid, company=self.company, updated_at=_now())
        self.lock = threading.Lock()

    # --- bookkeeping ------------------------------------------------------------------------------------------------
    def emit(self, type_, **data):
        event(log, "competitors_" + type_, logging.INFO,
              **{k: v for k, v in data.items() if isinstance(v, (str, int, float, bool))})
        return self.research_store.append_event(self.sid, type_, data)

    def save(self):
        with self.lock:
            self.landscape.llm_calls, self.landscape.tokens = self.llm.calls, self.llm.tokens
            self.landscape.pages = sum(len(c.pages) for c in self.landscape.competitors)
            self.story_store.save_landscape(self.landscape)

    def set_status(self, status: str, message: str = ""):
        with self.lock:
            self.landscape.status, self.landscape.message = status, _clip(message, 300)
        self.save()
        self.emit("competitors", status=status, message=self.landscape.message, landscape=self.summary())

    def summary(self) -> dict:
        l = self.landscape
        return {"status": l.status, "message": l.message, "version": l.version,
                "competitors": [{"id": c.competitor_id, "name": c.name, "domain": c.domain, "home_url": c.home_url,
                                 "verified": c.verified, "source": c.source, "reason": c.reason, "summary": c.summary,
                                 "pages": len(c.pages), "findings": len(c.findings), "error": c.error}
                                for c in l.competitors],
                "differentiators": [d.text for d in l.differentiators],
                "competitor_themes": l.competitor_themes, "avoid_terms": l.avoid_terms,
                "stats": {"pages": l.pages, "llm_calls": l.llm_calls, "tokens": l.tokens}}

    # --- the run ----------------------------------------------------------------------------------------------------
    def run(self) -> CompetitiveLandscape:
        try:
            if self.max_competitors <= 0:
                self.set_status("skipped", "competitor research is off (RESEARCH_MAX_COMPETITORS=0)")
                return self.landscape
            self.set_status("running", "finding {}'s competitors".format(self.company or "the company"))
            verified = [c for c in self.landscape.competitors if c.verified]
            queue = self.candidates()
            while queue and len(verified) < self.max_competitors and not self.stopped():
                # verify just enough candidates at once to fill the open slots; earlier candidates win
                slots = self.max_competitors - len(verified)
                batch, queue = queue[:slots], queue[slots:]
                verified += [c for c in self.each(self.verify, batch) if c is not None][:slots]
            if not self.stopped():
                self.each(self.research, verified)
            if self.stopped():
                self.set_status("skipped", "research was stopped")
                return self.landscape
            self.build_landscape()
            names = ", ".join(c.name for c in verified) or "none verified"
            self.set_status("done", "competitors researched: {}".format(names))
        except Exception as e:
            log.exception("competitor research %s failed", self.sid)
            with self.lock:
                self.landscape.error = "{}: {}".format(type(e).__name__, str(e)[:300])
            self.set_status("error", self.landscape.error)
        return self.landscape

    def each(self, fn, items: list) -> list:
        """fn(item) for every item, up to `parallel` at a time (each is a few fetches plus 5-20 s Liquid calls);
        results keep the order of `items`."""
        workers = min(self.parallel, len(items))
        if workers <= 1:
            return [fn(item) for item in items]
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="competitors-" + self.sid[-8:]) as pool:
            return [f.result() for f in [pool.submit(in_context(fn), item) for item in items]]

    # --- step 1: candidates -----------------------------------------------------------------------------------------
    def candidates(self) -> List[dict]:
        st, profile = self.state, self.state.profile
        own = {compact(self.company)} | {compact(s) for s in slugs(self.company or "x")}
        own_site = st.domain or ""
        out, seen = [], set()

        def add(name, domain, reason, source):
            name = _clip(name, 120)
            domain = (domain or "").strip().lower().removeprefix("https://").removeprefix("http://")
            domain = domain.removeprefix("www.").split("/")[0] or None
            if domain and not DOMAIN_RE.match(domain):
                domain = None
            key = compact(name)
            if not key or key in seen or key in own or any(o and (o in key or key in o) for o in own if len(o) >= 4):
                return
            if domain and own_site and site_of(domain) == site_of(own_site):
                return
            seen.add(key)
            out.append({"name": name, "domain": domain, "reason": _clip(reason, 300), "source": source})

        for peer in watch_peers(self.watch_file, self.company):
            add(peer["name"], peer.get("domain"), peer["reason"], "watch")
        got = self.llm.ask(COMPETITORS_PROMPT.format(
            name=self.company, domain=own_site or "unknown",
            one_line=profile.one_line.text if profile and profile.one_line else "",
            what=profile.what_they_do.text if profile and profile.what_they_do else "unknown",
            products="; ".join(p.text for p in (profile.products if profile else [])[:6]) or "unknown",
            n=self.max_competitors + 2))
        for item in (got or {}).get("competitors", []) if isinstance(got, dict) else []:
            if isinstance(item, dict) and isinstance(item.get("name"), str):
                add(item["name"], item.get("domain") if isinstance(item.get("domain"), str) else None,
                    str(item.get("reason") or ""), "llm")
        self.emit("competitors", status=self.landscape.status, message="competitor candidates: {}".format(
            ", ".join(c["name"] for c in out[:MAX_CANDIDATES]) or "none"))
        return out[:MAX_CANDIDATES]

    # --- step 2: verify the website ---------------------------------------------------------------------------------
    def verify(self, cand: dict) -> Optional[Competitor]:
        comp = Competitor(competitor_id=Competitor.make_id(self.sid, cand["name"]), name=cand["name"],
                          domain=cand.get("domain"), reason=cand.get("reason", ""), source=cand.get("source", "llm"))
        urls = []
        if comp.domain:
            urls += ["https://www.{}/".format(comp.domain), "https://{}/".format(comp.domain)]
        for s in slugs(comp.name)[:2]:
            urls += ["https://www.{}.com/".format(s), "https://{}.com/".format(s)]
        names = {compact(comp.name)} | {compact(s) for s in slugs(comp.name)}
        tried, rejected, misses = set(), set(), []
        for url in urls:
            if url in tried or len(tried) >= 4 or self.stopped() or site_of(host_of(url)) in rejected:
                continue
            tried.add(url)
            try:
                page = self.fetcher.fetch(url, allowed=home_guard(url, names))
            except HostNotAllowed as e:  # redirected to a parking page or another company's site
                rejected.add(site_of(host_of(url)))
                misses.append("{}: redirects to {}".format(site_of(host_of(url)), str(e).rsplit(": ", 1)[-1][:80]))
                continue
            except EXPECTED_FETCH_ERRORS as e:
                misses.append("{}: {}".format(host_of(url), fetch_error_reason(e)))
                continue
            except Exception as e:
                log.exception("verifying %s at %s failed", comp.name, url)
                misses.append("{}: unexpected {}".format(host_of(url), fetch_error_reason(e)))
                continue
            body = compact(" ".join([page.title, page.description, page.text[:30000]]))
            found = page.status == 200 and any(n and n in body for n in names)
            if not found:
                misses.append("{}: {}".format(host_of(url), "HTTP {}".format(page.status) if page.status != 200
                                              else "page does not mention {}".format(comp.name[:60])))
                continue
            problem = home_problem(url, page, names)
            if problem:  # parked, or someone else's site
                rejected.add(site_of(host_of(url)))
                misses.append("{}: {}".format(site_of(host_of(url)), problem))
                continue
            if found:
                comp.verified, comp.home_url = True, page.url
                comp.domain = site_of(host_of(page.url))
                if self.state.domain and comp.domain == site_of(self.state.domain):
                    return None
                self.remember(comp, url, page)
                with self.lock:
                    self.landscape.competitors = [c for c in self.landscape.competitors
                                                  if c.competitor_id != comp.competitor_id] + [comp]
                self.save()
                self.emit("competitor", competitor=self.competitor_view(comp), stage="verified")
                return comp
        why = "; ".join(misses[:3])
        comp.error = "website not found (tried {}{})".format(len(tried), ": " + why if why else "")
        self.emit("competitors", status=self.landscape.status,
                  message="could not verify {}'s website{}".format(comp.name, ": " + why if why else ""))
        return None

    def allowed_for(self, comp: Competitor):
        sites = {site_of(host_of(comp.home_url or ""))} | ({site_of(comp.domain)} if comp.domain else set())
        return lambda url: bool(host_of(url)) and site_of(host_of(url)) in sites

    def remember(self, comp: Competitor, requested: str, page: Page) -> dict:
        data = {"url": page.url, "status": page.status, "title": page.title, "description": page.description,
                "text": page.text, "headings": page.headings, "links": page.links[:400],
                "competitor_id": comp.competitor_id}
        self.pages[requested] = self.pages[page.url] = data
        self.story_store.save_page(self.sid, page.url, data)
        if all(v.url != page.url for v in comp.pages):
            comp.pages.append(PageVisit(url=page.url, title=page.title, description=page.description,
                                        status=page.status, chars=len(page.text), fetched_at=_now()))
        self.emit("competitor_page", url=page.url, title=page.title, status=page.status, chars=len(page.text),
                  competitor=comp.name)
        return data

    # --- step 3: pages + findings -----------------------------------------------------------------------------------
    def research(self, comp: Competitor):
        allowed = self.allowed_for(comp)
        home = self.pages.get(comp.home_url or "")
        if home is None:
            return
        visited = {v.url for v in comp.pages}
        links = prioritized_links(Page(url=home["url"], status=200, links=[tuple(x) for x in home.get("links", [])]),
                                  allowed, visited, limit=40)
        links.sort(key=lambda d: (-(d["score"] + CATEGORY_BOOST.get(link_category(d["url"], d["text"]), 0)),
                                  len(d["url"])))
        chosen, cats = [], set()
        for d in links:
            cat = link_category(d["url"], d["text"])
            if cat in cats and len(links) > self.pages_per_competitor:
                continue
            cats.add(cat)
            chosen.append(d["url"])
            if len(chosen) >= self.pages_per_competitor - 1:
                break
        self.extract(comp, home)
        for url in chosen:
            if self.stopped():
                return
            try:
                page = self.fetcher.fetch(url, allowed=allowed)
            except Exception as e:
                if not isinstance(e, EXPECTED_FETCH_ERRORS):
                    log.exception("reading %s for %s failed", url, comp.name)
                self.emit("competitors", status=self.landscape.status,
                          message="could not read {}: {}".format(url, fetch_error_reason(e)))
                continue
            if page.status == 200:
                self.extract(comp, self.remember(comp, url, page))
        self.save()
        self.emit("competitor", competitor=self.competitor_view(comp), stage="researched")

    def add_finding(self, comp: Competitor, page: dict, topic, claim, quote) -> bool:
        quote = clean_quote(str(quote or ""))
        if not (MIN_QUOTE_CHARS <= len(quote) <= MAX_QUOTE_CHARS) or not quote_in_page(quote, page):
            return False
        fid = Finding.make_id(self.sid, page["url"], quote)
        if any(f.finding_id == fid or norm(f.quote) == norm(quote) for f in comp.findings):
            return False
        comp.findings.append(Finding(finding_id=fid, topic=topic if topic in COMPETITOR_TOPICS else "other",
                                     claim=_clip(claim or quote, 400), evidence_url=page["url"], quote=quote,
                                     found_at=_now()))
        return True

    def extract(self, comp: Competitor, page: dict):
        got = self.llm.ask(EXTRACT_PROMPT.format(
            competitor=comp.name, company=self.company, url=page["url"], title=page.get("title", ""),
            text=page.get("text", "")[:EXTRACT_PAGE_CHARS], n=MAX_FINDINGS_PER_PAGE,
            topics=", ".join(COMPETITOR_TOPICS)))
        added = 0
        if isinstance(got, dict):
            for item in (got.get("findings") or [])[:MAX_FINDINGS_PER_PAGE]:
                if isinstance(item, dict) and self.add_finding(comp, page, item.get("topic"), item.get("claim"),
                                                               item.get("quote")):
                    added += 1
            if not comp.summary and isinstance(got.get("summary"), str):
                comp.summary = _clip(got["summary"], 600)
        if added == 0:  # deterministic: the meta description and the first substantial lines
            lines = [page.get("description", "")] + [
                ln for ln in page.get("text", "").split("\n")
                if 40 <= len(ln) <= MAX_QUOTE_CHARS and " " in ln and not ln.startswith("#")]
            for text in lines[:2]:
                if text:
                    self.add_finding(comp, page, "positioning", text, text[:MAX_QUOTE_CHARS])
        if not comp.summary:
            comp.summary = _clip(page.get("description") or (comp.findings[0].claim if comp.findings else ""), 600)

    # --- step 4: landscape ------------------------------------------------------------------------------------------
    def build_landscape(self):
        st, profile = self.state, self.state.profile
        comps = [c for c in self.landscape.competitors if c.verified]
        avoid: List[str] = []
        for c in comps:
            for t in name_terms(c.name, c.domain):
                if t.lower() not in (a.lower() for a in avoid) and not mentions(self.company, [t]):
                    avoid.append(t)
        findings = [f for f in st.findings][-60:]
        ids = {"F{}".format(i + 1): f for i, f in enumerate(findings)}
        diffs: List[SourcedText] = []
        themes: List[str] = []
        got = None
        if comps and findings:
            comp_lines = ["C{} {}: {}; claims: {}".format(i + 1, c.name, c.summary or "?", "; ".join(
                f.claim for f in c.findings[:5])) for i, c in enumerate(comps)]
            got = self.llm.ask(LANDSCAPE_PROMPT.format(
                name=self.company, one_line=profile.one_line.text if profile and profile.one_line else "",
                goal=st.intent.video_goal if st.intent else "",
                findings="\n".join("F{} [{}] {}".format(i + 1, f.topic, f.claim) for i, f in enumerate(findings)),
                competitors="\n".join(comp_lines)))
        if isinstance(got, dict):
            for d in (got.get("differentiators") or [])[:6]:
                if not isinstance(d, dict) or not str(d.get("text", "")).strip():
                    continue
                refs = [ids[r] for r in (d.get("findings") or []) if isinstance(r, str) and r in ids]
                text = _clip(d["text"], 300)
                if refs and not mentions(text, avoid):
                    diffs.append(SourcedText(text=text, evidence_url=refs[0].evidence_url,
                                             finding_ids=[f.finding_id for f in refs][:6]))
            themes = [_clip(t, 200) for t in (got.get("competitor_themes") or [])
                      if isinstance(t, str) and t.strip() and not mentions(t, avoid)][:5]
        if not diffs and profile is not None:  # the company's own key messages / products / proof, verbatim claims
            pool = list(profile.key_messages) + list(profile.products[:2])
            pool += [SourcedText(text=f.claim[:500], evidence_url=f.evidence_url, finding_ids=[f.finding_id])
                     for f in profile.proof_points[:2]]
            diffs = [p for p in pool if p and not mentions(p.text, avoid)][:3]
        if not themes:
            counts = Counter(f.topic for c in comps for f in c.findings)
            labels = {"pricing": "pricing and plans", "product": "product features", "audience": "who it is for",
                      "proof": "customer proof", "positioning": "broad positioning"}
            themes = ["Competitors emphasise {}".format(labels.get(t, t)) for t, _ in counts.most_common(3)]
        with self.lock:
            self.landscape.differentiators, self.landscape.competitor_themes = diffs, themes
            self.landscape.avoid_terms = avoid
            self.landscape.version += 1
            self.landscape.model = self.llm.model if got else "deterministic"

    @staticmethod
    def competitor_view(c: Competitor) -> dict:
        return {"id": c.competitor_id, "name": c.name, "domain": c.domain, "home_url": c.home_url,
                "verified": c.verified, "source": c.source, "reason": c.reason, "summary": c.summary,
                "pages": len(c.pages), "findings": len(c.findings),
                "claims": [f.claim for f in c.findings[:6]]}
