"""StoryService: the worker's competitor research, storyline tool and first-prompt company detection.

HTTP (127.0.0.1 only, served by agent/worker.py next to the research routes):
  POST /research/detect {prompt}                     -> {company|null, likely_domain, video_goal, source}
  GET  /research/{id}/competitors                    -> CompetitiveLandscape summary (status waiting until it starts)
  POST /research/{id}/competitors {force?}           -> starts competitor research now (normally automatic)
  GET  /research/{id}/storyline                      -> latest StoryPlan
  POST /research/{id}/storyline {duration_sec, templates, template?, prompt?, wait_s?}  -> writes a new StoryPlan
       (waits up to wait_s for the first profile / a running competitor pass; Liquid gets RESEARCH_STORY_TIMEOUT_S)
  POST /research/{id}/storyline {edits: {...}}       -> the user's edits as a new version (competitor names rejected)

Competitor research starts by itself once a session has its first CompanyProfile (sessions created while this
worker runs; RESEARCH_MAX_COMPETITORS=0 turns it off). Progress is appended to the session's event log.
"""
import logging
import os
import re
import threading
import time
from datetime import datetime, timezone
from typing import Callable, Dict, Optional, Tuple

from pydantic import ValidationError

from contracts.research import ResearchStatus
from contracts.story import CompetitiveLandscape, StoryTemplate

from .competitors import CompetitorResearch
from .nimble_fetch import fetcher_name, make_fetcher
from .story_llm import JsonLlm
from .story_store import StoryStore
from .storyline import edit_storyline, write_storyline

log = logging.getLogger("agent.story")

PATH = re.compile(r"^/research/([A-Za-z0-9_]{1,64})/(competitors|storyline)$")
MAX_PROMPT_CHARS = 32_000
WATCH_INTERVAL_S = 3.0
DOMAIN_RE = re.compile(r"\b((?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|co|app|dev|us|uk|de|fr|es|mx|br|ca|au|in|jp))\b",
                       re.I)
# A prompt names a company either with a domain, or after an ad/video word ("an ad for Acme", "un anuncio para Acme").
RULE_RE = re.compile(r"\b(?:video|short|ad|advert|advertisement|commercial|promo|brand film|spot|campaign|story|"
                     r"anuncio|comercial|publicidad|campa[nñ]a|v[ií]deo|historia)\s+(?:for|about|of|para|de|sobre|del)"
                     r"\s+(?:the\s+|la\s+|el\s+)?(?:company\s+|brand\s+|empresa\s+|marca\s+)?"
                     r"([A-Z0-9][\w&.'’-]*(?:\s+[A-Z0-9][\w&.'’-]*){0,3})")
HINT_RE = re.compile(r"\b(ad|advert|commercial|promo|brand|company|business|startup|product|campaign|for|about|"
                     r"anuncio|comercial|publicidad|marca|empresa|negocio|producto|campa[nñ]a|para|sobre)\b", re.I)
NOT_COMPANIES = {"christmas", "halloween", "easter", "thanksgiving", "valentine", "valentines", "new", "my", "our",
                 "the", "a", "an", "me", "us", "mom", "dad", "instagram", "tiktok", "youtube", "reels", "navidad"}

DETECT_PROMPT = """[task:detect] Does this request for a video name a specific real company or brand (or its website)? The request may be in any language.
Request: \"\"\"{prompt}\"\"\"
Reply with only JSON: {{"company_name": "<the company exactly as written in the request, or null>", "likely_domain": "<its main website domain, or null>", "video_goal": "<what the video is for, one sentence in English>"}}"""


class InvalidInput(Exception):
    """A request body the caller must fix (HTTP 400)."""


def _now():
    return datetime.now(timezone.utc)


def env_int(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(os.environ.get(name, "").strip() or default)
    except ValueError:
        value = default
    return max(low, min(high, value))


def _compact(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def rule_company(prompt: str) -> Tuple[Optional[str], Optional[str]]:
    """(company, domain) from the prompt with rules only, or (None, None)."""
    domain = DOMAIN_RE.search(prompt or "")
    m = RULE_RE.search(prompt or "")
    name = None
    if m:
        name = re.sub(r"[.,;:!?'\"’-]+$", "", m.group(1)).strip()
        if not name or name.split()[0].lower() in NOT_COMPANIES:
            name = None
    if not name and domain:
        name = domain.group(1).lower().removeprefix("www.").split(".")[0].replace("-", " ").title()
    return name, domain.group(1).lower().removeprefix("www.") if domain else None


class StoryService:
    def __init__(self, settings, manager, story_store: Optional[StoryStore] = None,
                 llm_factory: Optional[Callable] = None, detect_llm_factory: Optional[Callable] = None,
                 fetcher_factory: Optional[Callable] = None, auto: Optional[bool] = None):
        self.settings, self.manager = settings, manager
        self.research_store = manager.store
        self.store = story_store or StoryStore(settings.agent_db)
        self.llm_factory = llm_factory or (lambda: None)
        self.detect_llm_factory = detect_llm_factory or self.llm_factory
        self.fetcher_factory = fetcher_factory or make_fetcher
        self.max_competitors = env_int("RESEARCH_MAX_COMPETITORS", 3, 0, 5)
        self.pages_per_competitor = env_int("RESEARCH_COMPETITOR_PAGES", 3, 1, 6)
        self.detect_timeout_s = env_int("RESEARCH_DETECT_TIMEOUT_S", 10, 1, 60)
        self.story_timeout_s = env_int("RESEARCH_STORY_TIMEOUT_S", 90, 5, 300)
        self.auto = self.max_competitors > 0 if auto is None else auto
        self.started_at = _now()
        self.jobs: Dict[str, threading.Thread] = {}
        self.story_locks: Dict[str, threading.Lock] = {}
        self.lock = threading.Lock()

    # --- competitor research ----------------------------------------------------------------------------------------
    def _stopped(self, sid: str) -> bool:
        live = self.manager.sessions.get(sid)
        if live is not None:
            return live.stop_event.is_set()
        st = self.research_store.load(sid)
        return st is None or st.status == ResearchStatus.stopped

    def start_competitors(self, sid: str, force: bool = False) -> dict:
        state = self.research_store.load(sid)
        if state is None:
            raise KeyError(sid)
        if state.profile is None:
            raise ValueError("research session {} has no company profile yet; competitors start after it".format(sid))
        with self.lock:
            job = self.jobs.get(sid)
            if job is not None and job.is_alive():
                return {"session_id": sid, "status": "running", "started": False}
            existing = self.store.landscape(sid)
            if existing is not None and existing.status in ("done", "running") and not force:
                return {"session_id": sid, "status": existing.status, "started": False}
            thread = threading.Thread(target=self._run_competitors, args=(sid,), name="competitors-" + sid[-8:],
                                      daemon=True)
            self.jobs[sid] = thread
            thread.start()
        return {"session_id": sid, "status": "running", "started": True, "fetcher": fetcher_name()}

    def _run_competitors(self, sid: str):
        state = self.research_store.load(sid)
        if state is None:
            return
        try:
            fetcher = self.fetcher_factory()
        except Exception as e:
            landscape = CompetitiveLandscape(session_id=sid, company=state.profile.name if state.profile else "",
                                             status="error", error=str(e)[:300], updated_at=_now())
            self.store.save_landscape(landscape)
            self.research_store.append_event(sid, "competitors", {"status": "error", "message": str(e)[:300]})
            return
        llm = JsonLlm(self.llm_factory(), self.settings.model)
        CompetitorResearch(state, self.research_store, self.store, fetcher, llm, self.settings.watch_file,
                           self.max_competitors, self.pages_per_competitor, stopped=lambda: self._stopped(sid)).run()

    def watch_once(self):
        """Starts competitor research for sessions (created while this worker runs) that now have a profile."""
        if not self.auto:
            return
        done = set(self.store.landscape_ids())
        for st in self.research_store.sessions(limit=20):
            if st.session_id in done or st.session_id in self.jobs or st.profile is None or not self._eligible(st):
                continue
            try:
                self.start_competitors(st.session_id)
            except (KeyError, ValueError):
                continue

    def run_watcher(self, stop: threading.Event):
        def loop():
            while not stop.is_set():
                try:
                    self.watch_once()
                except Exception:
                    log.exception("competitor watcher tick failed")
                stop.wait(WATCH_INTERVAL_S)
        thread = threading.Thread(target=loop, name="competitor-watcher", daemon=True)
        thread.start()
        return thread

    def competitors_view(self, sid: str) -> dict:
        if self.research_store.load(sid) is None:
            raise KeyError(sid)
        landscape = self.store.landscape(sid)
        running = sid in self.jobs and self.jobs[sid].is_alive()
        if landscape is None:
            # "waiting" only when a run will really start (the web app keeps following the session meanwhile)
            state = self.research_store.load(sid)
            waiting = (sid not in self.jobs and state is not None and self._eligible(state) and
                       (state.profile is not None or state.status != ResearchStatus.done))
            status = "running" if running else "waiting" if waiting else "off" if not self.auto else "none"
            message = {"running": "finding competitors", "waiting": "starts after the first research round",
                       "off": "competitor research is off (RESEARCH_MAX_COMPETITORS=0)",
                       "none": "no competitor research for this session"}[status]
            return {"session_id": sid, "status": status, "message": message, "competitors": [],
                    "differentiators": [], "competitor_themes": [], "avoid_terms": [], "running": running}
        out = landscape.model_dump(mode="json")
        if out["status"] == "running" and not running:  # the worker restarted mid-run
            out["status"], out["message"] = "interrupted", "interrupted by a worker restart; POST to run it again"
        for c in out["competitors"]:  # quotes and page lists stay in the agent; the app gets claims
            c["id"] = c.get("competitor_id")
            c["claims"] = [f["claim"] for f in c.pop("findings", [])][:8]
            c["pages"] = len(c.get("pages", []))
        out["differentiators"] = [d["text"] for d in out["differentiators"]]
        out["running"] = running
        return out

    def pending(self, sid: str) -> bool:
        """True while competitor research or a storyline for this session is running or about to start, so the
        worker keeps its event stream open after the company research itself finished."""
        job = self.jobs.get(sid)
        if job is not None and job.is_alive():
            return True
        lock = self.story_locks.get(sid)
        if lock is not None and lock.locked():
            return True
        if sid in self.jobs:
            return False
        st = self.research_store.load(sid)
        return bool(st and st.profile is not None and self._eligible(st) and self.store.landscape(sid) is None)

    def _eligible(self, st) -> bool:
        """Sessions the watcher researches competitors for once they have a profile."""
        return (self.auto and not st.is_test and st.created_at >= self.started_at and
                st.status not in (ResearchStatus.stopped, ResearchStatus.error))

    def extras(self, sid: str) -> dict:
        """Added to GET /research/{id}: competitor summary and the latest storyline."""
        try:
            competitors = self.competitors_view(sid)
        except KeyError:
            return {}
        plan = self.store.storyline(sid)
        return {"competitors": competitors, "storyline": plan.model_dump(mode="json") if plan else None}

    def health(self) -> dict:
        return {"fetcher": fetcher_name(), "competitors": self.auto, "max_competitors": self.max_competitors,
                "pages_per_competitor": self.pages_per_competitor,
                "running": sum(1 for t in self.jobs.values() if t.is_alive())}

    # --- storyline --------------------------------------------------------------------------------------------------
    def storyline_view(self, sid: str) -> dict:
        if self.research_store.load(sid) is None:
            raise KeyError(sid)
        plan = self.store.storyline(sid)
        if plan is None:
            raise LookupError("no storyline yet for {}; POST /research/{}/storyline".format(sid, sid))
        return {"storyline": plan.model_dump(mode="json")}

    def write(self, sid: str, body: dict) -> dict:
        state = self.research_store.load(sid)
        if state is None:
            raise KeyError(sid)
        with self.lock:
            story_lock = self.story_locks.setdefault(sid, threading.Lock())
        if not story_lock.acquire(blocking=False):
            raise BlockingIOError("a storyline is already being written for this session")
        try:
            latest = self.store.storyline(sid)
            if "edits" in body:
                if latest is None:
                    raise LookupError("no storyline to edit yet")
                try:
                    plan = edit_storyline(latest, body["edits"])
                except ValueError as e:
                    raise InvalidInput(str(e))
                self.store.save_storyline(plan)
                self.research_store.append_event(sid, "storyline", {"storyline": plan.model_dump(mode="json"),
                                                                    "reason": "edit"})
                return {"storyline": plan.model_dump(mode="json")}
            duration = body.get("duration_sec")
            if not isinstance(duration, int) or isinstance(duration, bool) or not 3 <= duration <= 120:
                raise InvalidInput("duration_sec must be an integer from 3 to 120")
            try:
                templates = [StoryTemplate.model_validate(t) for t in (body.get("templates") or [])][:6]
            except ValidationError as e:
                raise InvalidInput("templates are invalid: {}".format(str(e)[:300]))
            hint = body.get("template")
            if hint is not None and (not isinstance(hint, str) or (templates and hint not in {t.id for t in
                                                                                              templates})):
                raise InvalidInput("template must be one of the ids in templates")
            prompt = body.get("prompt")
            if prompt is not None and (not isinstance(prompt, str) or len(prompt) > MAX_PROMPT_CHARS):
                raise InvalidInput("prompt must be a string up to 32,000 characters")
            wait_s = body.get("wait_s", 30)
            wait_s = max(0, min(90, wait_s)) if isinstance(wait_s, (int, float)) and not isinstance(wait_s, bool) \
                else 30
            deadline = time.time() + wait_s
            while state.profile is None and time.time() < deadline and not self.manager.finished(sid):
                time.sleep(0.25)  # "create video now" during the first round: wait for the first profile
                state = self.research_store.load(sid) or state
            if state.profile is None:
                raise ValueError("research session {} has no company profile yet (status {}); wait for its first "
                                 "round".format(sid, state.status.value))
            self.research_store.append_event(sid, "storyline", {"stage": "writing",
                                                                "message": "writing the storyline"})
            if self.auto and sid not in self.jobs and self.store.landscape(sid) is None and not state.is_test:
                try:  # the watcher has not picked the session up yet: start now so the storyline can use it
                    self.start_competitors(sid)
                except (KeyError, ValueError):
                    pass
            while time.time() < deadline:  # a running competitor pass adds differentiators and names to avoid
                job = self.jobs.get(sid)
                if job is None or not job.is_alive():
                    break
                job.join(timeout=min(1.0, max(0.05, deadline - time.time())))
            state = self.research_store.load(sid) or state
            landscape = self.store.landscape(sid)
            llm = JsonLlm(self.llm_factory(), self.settings.model, timeout_s=self.story_timeout_s)
            plan = write_storyline(state, landscape, templates, duration, llm, template_hint=hint, prompt=prompt,
                                   version=(latest.version + 1) if latest else 1)
            self.store.save_storyline(plan)
            self.research_store.append_event(sid, "storyline", {"storyline": plan.model_dump(mode="json"),
                                                                "reason": "write"})
            return {"storyline": plan.model_dump(mode="json"),
                    "competitors": landscape.status if landscape else "waiting"}
        finally:
            story_lock.release()

    # --- first-prompt company detection -----------------------------------------------------------------------------
    def detect(self, prompt: str) -> dict:
        started = time.time()
        name, domain = rule_company(prompt)
        result = {"company": name, "likely_domain": domain, "video_goal": None, "source": "rules" if name else "none"}
        if not HINT_RE.search(prompt) and not domain and not re.search(r"\s[A-Z][a-z]", prompt):
            result["elapsed_ms"] = int((time.time() - started) * 1000)
            return result  # "a cat on the moon": nothing that could be a company; skip the model call
        llm = JsonLlm(self.detect_llm_factory(), self.settings.model)
        got = llm.ask(DETECT_PROMPT.format(prompt=prompt[:2000]), timeout_s=self.detect_timeout_s)
        if isinstance(got, dict):
            cand = got.get("company_name")
            cand = cand.strip()[:120] if isinstance(cand, str) and cand.strip().lower() not in ("", "null",
                                                                                               "none") else None
            # the model may name a company the prompt does not contain: keep only names written in the request
            if cand and _compact(cand) and _compact(cand) in _compact(prompt) and \
                    cand.split()[0].lower() not in NOT_COMPANIES:
                result.update(company=cand, source="llm")
                dom = got.get("likely_domain")
                if isinstance(dom, str) and DOMAIN_RE.fullmatch(dom.strip().lower().removeprefix("www.")) and \
                        not domain:
                    result["likely_domain"] = dom.strip().lower().removeprefix("www.")
            elif not domain:
                result.update(company=None, likely_domain=None, source="llm")
            if isinstance(got.get("video_goal"), str) and got["video_goal"].strip():
                result["video_goal"] = got["video_goal"].strip()[:400]
        result["elapsed_ms"] = int((time.time() - started) * 1000)
        return result

    # --- HTTP -------------------------------------------------------------------------------------------------------
    @staticmethod
    def handles(path: str) -> bool:
        return path == "/research/detect" or PATH.match(path) is not None

    def handle(self, method: str, path: str, body: Optional[dict]) -> Optional[Tuple[int, dict]]:
        """(status, body) for the routes above, or None when the path is not one of them."""
        if path == "/research/detect":
            if method != "POST":
                return 405, {"error": "use POST"}
            prompt = (body or {}).get("prompt")
            if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT_CHARS:
                return 400, {"error": "prompt must be a string of 1 to 32,000 characters"}
            return 200, self.detect(prompt.strip())
        m = PATH.match(path)
        if not m:
            return None
        sid, what = m.group(1), m.group(2)
        try:
            if what == "competitors":
                if method == "GET":
                    return 200, self.competitors_view(sid)
                return 202, self.start_competitors(sid, force=(body or {}).get("force") is True)
            if method == "GET":
                return 200, self.storyline_view(sid)
            return 200, self.write(sid, body or {})
        except KeyError:
            return 404, {"error": "no research session {}".format(sid)}
        except LookupError as e:
            return 404, {"error": str(e)}
        except BlockingIOError as e:
            return 429, {"error": str(e)}
        except InvalidInput as e:
            return 400, {"error": str(e)}
        except ValueError as e:
            return 409, {"error": str(e)}
