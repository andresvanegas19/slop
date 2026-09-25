"""Company research sessions: "make a video for Coca-Cola" -> website research + follow-up questions + CompanyProfile.

  prompt ──Liquid──► {company_name, likely_domain, video_goal} ──verify candidates──► https://www.coca-cola.com
     round N:  ReAct loop (fetch_page / list_links / record_finding / ask_user ...)      [Liquid chooses]
               + extraction pass: Liquid reads each fetched page, quotes are verified in code
               + crawl fill: prioritized same-site links until RESEARCH_MAX_PAGES pages this round
               -> CompanyProfile (grounded: every item cites findings, i.e. quotes on fetched pages)
               -> 3-5 follow-up questions with options (Liquid, templates as fallback)
               -> RawTree `slop_human_research_events` (only when the worker runs with --publish)
     while looping: wait RESEARCH_INTERVAL_S, next round (stops on /stop, looping=false, or nothing new)

Answers arrive any time through the worker API and are merged into profile.video_brief immediately.
Everything is persisted in agent.db (agent/research_store.py) so the web app can poll/stream and restarts resume.
"""
import json
import logging
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Dict, List, Optional

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from contracts import TABLES, EventType
from core.logs import event, in_context
from contracts.research import (FINAL_STATUSES, FINDING_TOPICS, QUESTION_TOPICS, CompanyProfile, Finding,
                                FollowUpQuestion, NewsItem, PageVisit, ResearchEventRow, ResearchIntent,
                                ResearchSessionState, ResearchStatus, SourcedText, VideoBrief, VisualIdentity,
                                stable_id)

from .react import SPECIAL_TOKEN_RE, _text, describe_tools, loose_json, parse_step
from .research_tools import (MAX_OPEN_QUESTIONS, MAX_OPTIONS, MAX_QUOTE_CHARS, MIN_QUOTE_CHARS, ResearchTools,
                             clean_quote, norm, quote_in_page)
from .user_context import expressed_topics, summary_line, user_context, valid_user_id
from .videos import recent_videos
from .web import (EXPECTED_FETCH_ERRORS, FetchError, HostNotAllowed, Page, WebFetcher, compact, css_colors,
                  fetch_error_reason, find_dates, home_guard, home_problem, host_of, link_category, normalize_url,
                  prioritized_links, site_of, slugs)

log = logging.getLogger("agent.research")

MAX_CONCURRENT_SESSIONS = 2
MAX_QUESTIONS = 15
MAX_FINDINGS = 200
MAX_FINDINGS_PER_PAGE = 8
EXTRACT_PAGE_CHARS = 24000   # page text shown to Liquid in one extraction call (~6-7k tokens)
STOP = ["\nObservation:", "\nObservation :"]
ELIDED = "Observation: [elided to fit the context window; call get_findings or fetch_page again if needed]"
DOMAIN_RE = re.compile(r"\b((?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|co|app|dev|us|uk|de|fr|es|mx|br|ca|au|in|jp))\b",
                       re.I)
COMPANY_RE = re.compile(r"(?:for|about|of|from|at)\s+(?:my|our|the)?\s*(?:company|brand|business|startup)?\s*,?\s*"
                        r"([A-Z0-9][\w&.'\-]*(?:\s+[A-Z0-9][\w&.'\-]*){0,3})")
TOPIC_FIELD = {"goal": "goal", "audience": "audience", "product": "featured_product", "tone": "tone",
               "format": "length_format", "cta": "call_to_action", "avoid": "avoid"}

INTENT_PROMPT = """[task:intent] Read the user's request for a company video and extract the company.
Request: \"\"\"{prompt}\"\"\"
Reply with only JSON: {{"company_name": "<the company's usual name>", "likely_domain": "<its main website domain, e.g. example.com, or null if unsure>", "video_goal": "<what the video is for, one sentence>"}}"""

RESEARCH_SYSTEM = """[task:research] You are the research agent of a video studio. You research ONE company on its own website so a short, truthful company video can be made. Collect grounded facts: what the company does, its products or brands, its audience, how it talks (brand voice), recent news with dates, proof points (numbers, awards, sustainability, people).

Tools:
{tools}

Answer in this exact format, one tool per turn:
Thought: <one short sentence>
Action: <tool name>
Action Input: <JSON object with the arguments>

Then STOP and wait for the Observation. Rules:
- Only use URLs from observations (list_links, top_links) on the company's site.
- After reading a page, call record_finding for each useful fact. The quote must be copied EXACTLY from that page's text.
- If something about the VIDEO itself is unclear (audience, product to feature, tone, length, call to action, what to avoid), call ask_user with 2-4 options. Do not wait for answers.
- When the page budget is used up or you have covered the site, write:
Final Answer: <two sentences on what you found and what is still missing>"""

RESEARCH_TASK = """Company: {name}
Website: {home}
Video goal: {goal}
Round {round}. Page budget this round: {pages_left} pages, {steps} tool steps.
Pages already fetched ({n_pages}): {pages}
Findings so far: {n_findings} ({topics})
User answers: {answers}
Still missing: {gaps}
Videos already made for this company: {videos}
This user's history (focus on what they care about): {user}
{start}"""

EXTRACT_PROMPT = """[task:extract] Page of {name}'s website: {url}
Title: {title}
---
{text}
---
List up to {n} facts from this page that would help make a truthful video about {name} (what they do, products or brands, audience, brand voice, news with dates, proof points like numbers, awards, sustainability, people).
Each quote MUST be copied exactly from the page text above (12-250 characters). Keep numbers and dates in the claim exactly as the quote says them.
Reply with only JSON: {{"findings": [{{"topic": "<one of {topics}>", "claim": "<the fact in your words>", "quote": "<exact text from the page>"}}]}}"""

PROFILE_PROMPT = """[task:profile] Build the company profile of {name} ({domain}) for a video writer, using ONLY the numbered findings below. Cite findings by id.
Video goal: {goal}
User answers: {answers}
Pages: {pages}
Findings:
{findings}

Reply with only JSON:
{{"one_line": {{"text": "<who they are in one sentence>", "findings": ["F1"]}},
 "what_they_do": {{"text": "<2-3 sentences>", "findings": ["F2"]}},
 "products": [{{"text": "<product or brand and what it is>", "findings": ["F3"]}}],
 "audience": {{"text": "<who they serve>", "findings": ["F4"]}},
 "brand_voice": {{"text": "<tone of their own copy, e.g. warm, optimistic, inclusive>", "findings": ["F5"]}},
 "imagery_style": "<photography style suited to the brand, visual words only, no text or logos>",
 "key_messages": [{{"text": "<a message the company repeats>", "findings": ["F6"]}}],
 "proof_points": ["F7"],
 "open_questions": ["<what is still unknown and matters for the video>"]}}"""

QUESTIONS_PROMPT = """[task:questions] We are making a short video for {name}. {one_line}
Video goal from the user: {goal}
Products seen: {products}
Already asked (do not repeat): {asked}
Already answered: {answers}
Unknowns: {gaps}
Videos already made for this company (ask what should be different or kept): {videos}
This user's history: {user}
The user already told us (do NOT ask about these topics again): {expressed}
Write {n} short follow-up questions for the user that would most improve the video (for example target audience, which product to feature, tone, length and format, call to action, things to avoid). Each question gets 2-4 short suggested answers.
Reply with only JSON: {{"questions": [{{"topic": "<one of {topics}>", "question": "<question?>", "options": ["<option>", "<option>"]}}]}}"""

TEMPLATES = {
    "goal": ("What should this video achieve for {name}?",
             ["Build brand awareness", "Promote a product or launch", "Recruit talent", "Share our impact story"]),
    "audience": ("Who should this video speak to?",
                 ["Consumers and fans", "Retail and business partners", "Future employees", "Investors"]),
    "product": ("Which product or brand should the video feature?", []),
    "tone": ("What tone should the video have?",
             ["Warm and nostalgic", "Energetic and upbeat", "Premium and cinematic", "Calm and informative"]),
    "format": ("How long should the video be?",
               ["5 s bumper", "10 s teaser", "15 s social spot", "30 s brand film"]),
    "cta": ("What should viewers do at the end?",
            ["Visit the website", "Try or buy the product", "Follow on social media", "No call to action"]),
    "avoid": ("Is there anything the video must avoid?",
              ["No health or nutrition claims", "No competitor mentions", "No close-up faces", "Nothing specific"]),
}
TEMPLATE_ORDER = ["audience", "product", "tone", "format", "cta", "avoid", "goal"]


def _now():
    return datetime.now(timezone.utc)


def _clip(text, n):
    text = re.sub(r"\s+", " ", SPECIAL_TOKEN_RE.sub("", str(text or ""))).strip()
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def fallback_intent(prompt: str) -> ResearchIntent:
    domain = DOMAIN_RE.search(prompt)
    name = None
    m = COMPANY_RE.search(prompt)
    if m:
        name = re.sub(r"[.,;:!?'\"]+$", "", m.group(1)).strip()
    if not name and domain:
        name = domain.group(1).split(".")[-2].replace("-", " ").title()
    if not name:
        caps = re.findall(r"\b[A-Z][\w&\-]+(?:\s+[A-Z][\w&\-]+)*", prompt[1:])
        name = caps[0] if caps else prompt.strip().split()[-1]
    return ResearchIntent(company_name=name[:120], likely_domain=domain.group(1).lower() if domain else None,
                          video_goal=_clip(prompt, 400))


def topic_for_url(url: str) -> str:
    path = url.lower()
    for topic, pat in (("news", r"news|press|stories|media|blog"), ("product", r"product|brand|drink|shop|menu"),
                       ("sustainability", r"sustainab|esg|impact|planet|community"),
                       ("people", r"career|job|people|culture|leadership"), ("about", r"about|company|history")):
        if re.search(pat, path):
            return topic
    return "about"


class ResearchSession:
    """One company research session. Runs rounds on its own thread; the HTTP thread calls answer/loop/stop."""

    def __init__(self, settings, state: ResearchSessionState, store, llm=None, outbox=None, rawtree=None,
                 fetcher: Optional[WebFetcher] = None, reader=None):
        self.settings, self.state, self.store = settings, state, store
        self.llm, self.outbox, self.rawtree = llm, outbox, rawtree  # rawtree: publishing (None = never write)
        self.reader = reader  # RawTree for reads only (past videos); may be set while publishing is off
        self._videos = None
        self._user_ctx = None
        self.fetcher = fetcher or WebFetcher()
        self.lock = threading.RLock()
        self.stop_event, self.wake = threading.Event(), threading.Event()
        self.pages: Dict[str, dict] = store.pages(state.session_id)
        self.round_pages = 0
        self.extracted: set = {f.evidence_url for f in state.findings}
        self.thread: Optional[threading.Thread] = None

    # --- bookkeeping ------------------------------------------------------------------------------------------------
    @property
    def sid(self):
        return self.state.session_id

    @property
    def company(self):
        return self.state.intent.company_name if self.state.intent else ""

    def emit(self, type_, **data):
        # Mirror the session's event log into the structured log (status / finding / question / error …).
        event(log, "research_" + type_, logging.WARNING if type_ == "error" else logging.INFO if type_ in (
            "status", "question", "profile") else logging.DEBUG,
              **{k: v for k, v in data.items() if isinstance(v, (str, int, float, bool)) and k != "quote"})
        return self.store.append_event(self.sid, type_, data)

    def save(self):
        with self.lock:
            self.store.save(self.state)

    def set_status(self, status: ResearchStatus, message: str = ""):
        with self.lock:
            self.state.status = status
            self.save()
        self.emit("status", status=status.value, message=message)

    def alive(self):
        return self.thread is not None and self.thread.is_alive()

    def start(self):
        # The session thread keeps the trace of the request that started it, plus the session id.
        self.thread = threading.Thread(target=in_context(self.run, sessionId=self.sid), name="research-" + self.sid[-8:],
                                       daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.wake.set()
        with self.lock:
            self.state.looping = False
        if not self.alive():
            self.set_status(ResearchStatus.stopped, "stopped by the user")

    def set_looping(self, looping: bool):
        with self.lock:
            self.state.looping = looping
            self.save()
        self.wake.set()
        self.emit("status", status=self.state.status.value, message="looping {}".format("on" if looping else "off"),
                  looping=looping)

    def pages_left(self):
        return max(0, self.settings.research_max_pages - self.round_pages)

    # --- publishing -------------------------------------------------------------------------------------------------
    def queue_row(self, type_, key, payload, evidence_url=""):
        """One row for RawTree `slop_human_research_events`; queued only when this session publishes."""
        if not (self.state.publish and self.outbox is not None):
            return
        table = TABLES["research"]
        assert table.startswith("slop_human")
        event_id = "research:" + stable_id(self.sid, type_, key, size=24)
        row = ResearchEventRow(event_id=event_id, session_id=self.sid, company=self.company, type=type_,
                               payload=json.dumps(payload, default=str, ensure_ascii=False)[:60000],
                               evidence_url=evidence_url or "", created_at=_now(), is_test=self.state.is_test)
        self.outbox.enqueue(EventType.research, table, event_id, row.model_dump(mode="json"))

    def flush(self):
        if not (self.state.publish and self.outbox is not None and self.rawtree is not None):
            return 0
        try:
            sent = self.outbox.deliver(self.rawtree)
        except Exception as e:
            self.emit("error", where="publish", message="{}: {}".format(type(e).__name__, str(e)[:200]))
            return 0
        if sent:
            self.emit("published", rows=sent, table=TABLES["research"])
        return sent

    # --- LLM --------------------------------------------------------------------------------------------------------
    def call_llm(self, messages, stop=None) -> str:
        message = self.llm.invoke(messages, stop=stop) if stop else self.llm.invoke(messages)
        usage = getattr(message, "usage_metadata", None) or {}
        with self.lock:
            s = self.state.stats
            s.llm_calls += 1
            s.input_tokens += usage.get("input_tokens", 0) or 0
            s.output_tokens += usage.get("output_tokens", 0) or 0
        return _text(message)

    def ask_json(self, prompt: str) -> Optional[dict]:
        if self.llm is None:
            return None
        try:
            text = self.call_llm([HumanMessage(prompt)])
        except Exception as e:
            self.emit("error", where="llm", message="{}: {}".format(type(e).__name__, str(e)[:200]))
            return None
        return loose_json(SPECIAL_TOKEN_RE.sub("", text))

    # --- web --------------------------------------------------------------------------------------------------------
    def allowed(self, url: str) -> bool:
        host = host_of(url)
        if not host:
            return False
        site = site_of(host)
        if site in self.state.allowed_hosts:
            return True
        label = compact(site.split(".")[0])
        return any(len(compact(s)) >= 5 and compact(s) in label for s in slugs(self.company or "x"))

    def get_page(self, url: str) -> Optional[dict]:
        """Cached page dict, or fetch it (counts against the round's page budget). Errors come back as dicts."""
        target = normalize_url(url)
        if target is None:
            return None
        if target in self.pages:
            return self.pages[target]
        if self.stop_event.is_set():
            return {"error": "session stopped"}
        if self.pages_left() <= 0:
            return {"error": "page budget for this round is used up; record findings and write the Final Answer"}
        if not self.allowed(target):
            return {"error": "{} is not the company's site; only use links from list_links".format(host_of(target))}
        self.round_pages += 1
        try:
            page = self.fetcher.fetch(target, allowed=self.allowed)
        except FetchError as e:
            self.emit("error", where="fetch", url=target, message=str(e)[:200])
            return {"error": str(e)[:300]}
        except Exception as e:
            self.emit("error", where="fetch", url=target, message="{}: {}".format(type(e).__name__, str(e)[:160]))
            return {"error": "fetch failed: {}".format(type(e).__name__)}
        return self._remember(target, page)

    def _remember(self, requested: str, page) -> dict:
        data = {"url": page.url, "status": page.status, "title": page.title, "description": page.description,
                "text": page.text, "headings": page.headings, "links": page.links[:400], "og_image": page.og_image,
                "theme_color": page.theme_color, "colors": page.colors, "logo_url": page.logo_url}
        visit = PageVisit(url=page.url, title=page.title, description=page.description, status=page.status,
                          chars=len(page.text), fetched_at=_now())
        if page.url in self.pages and page.url != requested:  # a redirect to a page we already have
            with self.lock:
                self.pages[requested] = self.pages[page.url]
            return self.pages[page.url]
        with self.lock:
            self.pages[requested] = data
            self.pages[page.url] = data
            if all(v.url != page.url for v in self.state.visited):
                self.state.visited.append(visit)
            self.state.stats.pages = len(self.state.visited)
            self.save()
        self.store.save_page(self.sid, page.url, data)
        if requested != page.url:
            self.store.save_page(self.sid, requested, data)
        if page.status != 200:
            data["error"] = "HTTP {}".format(page.status)
        self.emit("page", url=page.url, title=page.title, status=page.status, chars=len(page.text))
        self.queue_row("page", page.url, visit.model_dump(mode="json"), page.url)
        return data

    def links_for(self, url: str, limit=40) -> List[dict]:
        page = self.pages.get(url)
        if not page:
            return []
        visited = {v.url for v in self.state.visited}
        return prioritized_links(Page(url=url, status=200, links=[tuple(x) for x in page.get("links", [])]),
                                 self.allowed, visited, limit)

    def recent_videos(self, limit=5, company=None) -> dict:
        """Past videos for this company (RawTree slop_human_video_events), cached for the round."""
        if company or limit != 5 or self._videos is None:
            try:
                got = recent_videos(self.reader, limit, company or self.company, [self.sid])
            except Exception as e:  # optional context: the round goes on, the tool reports it, and it is logged
                got = {"videos": [], "error": "{}: {}".format(type(e).__name__, str(e)[:200])}
                event(log, "research_recent_videos_failed", logging.WARNING, error=got["error"])
            if company or limit != 5:
                return got
            self._videos = got
        return self._videos

    def user_context(self, limit=15) -> dict:
        """This session's user's past prompts (RawTree slop_human_user_prompts), cached for the round."""
        if limit != 15 or self._user_ctx is None:
            if self.reader is None:
                got = {"prompts": [], "note": "RawTree is not configured"}
            else:
                try:
                    got = user_context(self.reader, self.state.user_id, limit)
                except Exception as e:  # optional context, as above
                    got = {"prompts": [], "error": "{}: {}".format(type(e).__name__, str(e)[:200])}
                    event(log, "research_user_context_failed", logging.WARNING, error=got["error"])
            if limit != 15:
                return got
            self._user_ctx = got
        return self._user_ctx

    def expressed(self) -> dict:
        """Topics the user already settled: earlier answers for this company, then style/durations they use."""
        out = {q.topic: q.answer for q in self.state.prior_answers if q.topic != "other" and q.answer}
        for topic, said in expressed_topics(self.user_context()).items():
            out.setdefault(topic, "from past prompts: " + said)
        return out

    def videos_line(self) -> str:
        vids = self.recent_videos().get("videos", [])
        return "; ".join("{} ({}s{}){}".format(v.get("title") or v.get("prompt") or "untitled",
                                               v.get("duration_sec", "?"), ", " + v["kind"] if v.get("kind") else "",
                                               " edits: " + " / ".join(v["edits"][:3]) if v.get("edits") else "")
                         for v in vids[:5]) or "none yet"

    # --- findings & questions ---------------------------------------------------------------------------------------
    def add_finding(self, topic, claim, evidence_url, quote, source="agent"):
        url = normalize_url(evidence_url or "")
        page = self.pages.get(url) if url else None
        if page is None:
            return {"error": "evidence_url must be a page you fetched this session"}
        quote = clean_quote(quote)
        if not (MIN_QUOTE_CHARS <= len(quote) <= MAX_QUOTE_CHARS):
            return {"error": "quote must be {}-{} characters copied from the page".format(MIN_QUOTE_CHARS,
                                                                                         MAX_QUOTE_CHARS)}
        if not quote_in_page(quote, page):
            return {"error": "quote not found on {}; copy it exactly from the page text".format(page["url"])}
        claim = _clip(claim or quote, 400)
        topic = topic if topic in FINDING_TOPICS else "other"
        fid = Finding.make_id(self.sid, page["url"], quote)
        with self.lock:
            same = next((f for f in self.state.findings if f.finding_id == fid or norm(f.quote) == norm(quote)), None)
            if same is not None:  # the same sentence on another page is the same fact
                return {"ok": True, "finding_id": same.finding_id, "note": "already recorded"}
            if len(self.state.findings) >= MAX_FINDINGS:
                return {"error": "finding limit reached"}
            finding = Finding(finding_id=fid, topic=topic, claim=claim, evidence_url=page["url"], quote=quote,
                              found_at=_now())
            self.state.findings.append(finding)
            self.state.stats.findings = len(self.state.findings)
            self.save()
        self.emit("finding", source=source, finding=finding.model_dump(mode="json"))
        self.queue_row("finding", fid, finding.model_dump(mode="json"), finding.evidence_url)
        return {"ok": True, "finding_id": fid}

    def add_question(self, question, options, topic="other", source="llm"):
        question = _clip(question, 280)
        if len(question) < 8:
            return {"error": "question is too short"}
        if not question.endswith("?"):
            question += "?"
        topic = topic if topic in QUESTION_TOPICS else "other"
        opts = []
        for o in options or []:
            o = _clip(o, 80)
            if o and o.lower() not in (x.lower() for x in opts):
                opts.append(o)
        opts = opts[:MAX_OPTIONS]
        qid = FollowUpQuestion.make_id(self.sid, topic, question)
        with self.lock:
            qs = self.state.questions
            if any(q.question_id == qid or norm(q.question) == norm(question) for q in qs):
                return {"error": "already asked"}
            if topic != "other" and any(q.topic == topic for q in qs):
                return {"error": "a question about {} was already asked".format(topic)}
            if sum(not q.answered for q in qs) >= MAX_OPEN_QUESTIONS or len(qs) >= MAX_QUESTIONS:
                return {"error": "enough open questions; keep researching"}
            q = FollowUpQuestion(question_id=qid, topic=topic, question=question, options=opts, source=source,
                                 asked_at=_now())
            qs.append(q)
            self.save()
        self.emit("question", question=q.model_dump(mode="json"))
        self.queue_row("question", qid, q.model_dump(mode="json"))
        return q

    def answer(self, question_id: str, answer: str) -> FollowUpQuestion:
        answer = _clip(answer, 500)
        if not answer:
            raise ValueError("answer must be a non-empty string")
        with self.lock:
            q = next((q for q in self.state.questions if q.question_id == question_id), None)
            if q is None:
                raise KeyError(question_id)
            q.answered, q.answer, q.answered_at = True, answer, _now()
            profile = self.state.profile or self._empty_profile()
            profile = profile.model_copy(deep=True)
            apply_answer(profile.video_brief, q)
            profile.open_questions = [o for o in profile.open_questions if not _same_gap(o, q)]
            profile.version += 1
            profile.updated_at = _now()
            self.state.profile = profile
            self.save()
        self.emit("answer", question_id=q.question_id, topic=q.topic, answer=answer)
        self.emit("profile", profile=profile.model_dump(mode="json"), reason="answer")
        self.queue_row("answer", q.question_id, {"question": q.question, "topic": q.topic, "answer": answer})
        self.queue_row("profile", "v{}".format(profile.version), profile.model_dump(mode="json"))
        if not self.alive():
            self.flush()
        return q

    # --- the session ------------------------------------------------------------------------------------------------
    def run(self):
        try:
            if self.state.intent is None or not self.state.home_url:
                self.set_status(ResearchStatus.starting, "finding the company and its website")
                self.resolve()
                if not self.state.home_url:
                    self.set_status(ResearchStatus.error, self.state.error or "website not found")
                    return
            while not self.stop_event.is_set():
                with self.lock:
                    self.state.stats.rounds += 1
                    n = self.state.stats.rounds
                self.set_status(ResearchStatus.researching, "round {}".format(n))
                before = (len(self.state.visited), len(self.state.findings))
                self.run_round(n)
                if self.stop_event.is_set():
                    break
                self.build_profile()
                self.generate_questions()
                self.flush()
                new = (len(self.state.visited) - before[0], len(self.state.findings) - before[1])
                if new == (0, 0) and n > 1:
                    self.emit("status", status=self.state.status.value, message="nothing new found; pausing")
                    with self.lock:
                        self.state.looping = False
                if not self.state.looping or n >= self.settings.research_max_rounds:
                    break
                self.set_status(ResearchStatus.waiting, "next round in {}s".format(self.settings.research_interval_s))
                self.wake.clear()
                deadline = time.time() + self.settings.research_interval_s
                while time.time() < deadline and not self.stop_event.is_set() and self.state.looping:
                    self.wake.wait(max(0.05, min(5.0, deadline - time.time())))
                    self.wake.clear()
                if not self.state.looping:
                    break
            if self.stop_event.is_set():
                self.set_status(ResearchStatus.stopped, "stopped by the user")
            else:
                with self.lock:
                    self.state.looping = False
                self.set_status(ResearchStatus.done, "research finished; answer questions or turn looping on")
        except Exception as e:
            log.exception("research session %s failed", self.sid)
            with self.lock:
                self.state.error = "{}: {}".format(type(e).__name__, str(e)[:300])
            self.emit("error", where="session", message=self.state.error)
            self.set_status(ResearchStatus.error, self.state.error)
        finally:
            self.flush()

    # --- step 1: company + website ----------------------------------------------------------------------------------
    def resolve(self):
        intent = fallback_intent(self.state.prompt)
        got = self.ask_json(INTENT_PROMPT.format(prompt=self.state.prompt[:2000]))
        if got and isinstance(got.get("company_name"), str) and got["company_name"].strip():
            name = _clip(got["company_name"], 120)
            # a small model can hallucinate: keep its name only if the request mentions it
            if compact(name) and (compact(name) in compact(self.state.prompt) or not COMPANY_RE.search(
                    self.state.prompt)):
                intent.company_name = name
            dom = got.get("likely_domain")
            if isinstance(dom, str) and DOMAIN_RE.fullmatch(dom.strip().lower().removeprefix("www.")) and \
                    not intent.likely_domain:
                intent.likely_domain = dom.strip().lower().removeprefix("www.")
            if isinstance(got.get("video_goal"), str) and got["video_goal"].strip():
                intent.video_goal = _clip(got["video_goal"], 400)
        prior = []
        for old in self.store.sessions(limit=50):
            if old.session_id == self.sid or not old.intent or compact(old.intent.company_name) != compact(
                    intent.company_name) or (self.state.user_id and old.user_id != self.state.user_id):
                continue
            for q in old.questions:
                if q.answered and all(p.topic != q.topic or q.topic == "other" for p in prior):
                    prior.append(q)
        with self.lock:
            self.state.intent = intent
            self.state.prior_answers = prior[:10]
            self.save()
        self.emit("status", status=self.state.status.value, message="company: {}".format(intent.company_name),
                  company=intent.company_name, likely_domain=intent.likely_domain, video_goal=intent.video_goal)

        candidates = []
        if intent.likely_domain:
            d = intent.likely_domain
            candidates += ["https://www.{}/".format(d), "https://{}/".format(d)]
        for s in slugs(intent.company_name):
            for tld in ("com", "co", "io", "ai", "app"):
                candidates += ["https://www.{}.{}/".format(s, tld), "https://{}.{}/".format(s, tld)]
        names = {compact(intent.company_name)} | {compact(s) for s in slugs(intent.company_name)}
        seen, checked, rejected = set(), 0, set()
        misses = []  # "address: why it was not the company's site", for the final error

        def miss(url_, reason, quiet=False):
            misses.append("{}: {}".format(url_.split("//", 1)[-1].rstrip("/"), reason))
            if not quiet:
                self.emit("status", status=self.state.status.value, message="skipping {}: {}".format(
                    site_of(host_of(url_)), reason))

        for url in candidates:
            if url in seen or checked >= 12 or self.stop_event.is_set() or site_of(host_of(url)) in rejected:
                continue
            seen.add(url)
            checked += 1
            self.emit("status", status=self.state.status.value, message="checking {}".format(url))
            try:
                page = self.fetcher.fetch(url, allowed=home_guard(url, names))
            except HostNotAllowed as e:  # redirected to a parking page or another company's site
                rejected.add(site_of(host_of(url)))
                miss(url, "redirects to {}".format(str(e).rsplit(": ", 1)[-1][:120]))
                continue
            except EXPECTED_FETCH_ERRORS as e:  # no site there (DNS, refused, timeout, robots.txt …)
                miss(url, fetch_error_reason(e), quiet=True)
                continue
            except Exception as e:
                log.exception("checking %s for %s failed", url, intent.company_name)
                miss(url, "unexpected {}".format(fetch_error_reason(e)), quiet=True)
                self.emit("error", where="resolve", url=url, message=fetch_error_reason(e))
                continue
            if page.status != 200:
                miss(url, "HTTP {}".format(page.status), quiet=True)
                continue
            body = compact(" ".join([page.title, page.description, page.text[:30000]]))
            if not any(n and n in body for n in names):
                miss(url, "page does not mention {}".format(intent.company_name[:60]), quiet=True)
                continue
            problem = home_problem(url, page, names)
            if problem:  # a parked domain or someone else's site: the www / bare twin will not be better
                rejected.add(site_of(host_of(url)))
                miss(url, problem)
                continue
            with self.lock:
                self.state.allowed_hosts = sorted({site_of(host_of(url)), site_of(host_of(page.url))})
                self.state.domain = site_of(host_of(page.url))
                self.state.home_url = page.url
                self.save()
            self.emit("status", status=self.state.status.value, message="website: {}".format(page.url),
                      domain=self.state.domain, home_url=page.url)
            self.round_pages = 0
            self._remember(url, page)
            self.brand_colors(page)
            return
        why = "; ".join(misses[:4]) + (" …" if len(misses) > 4 else "")
        self.state.error = ("could not find {}'s website (tried {} addresses{}); include the domain in the prompt, "
                            "e.g. 'coca-cola.com'".format(intent.company_name, checked, ": " + why if why else ""))

    def brand_colors(self, page):
        """Brand colors usually live in the site's stylesheets: scan up to two same-site CSS files of the homepage."""
        css = []
        for href in page.stylesheets[:4]:
            url = normalize_url(href)
            if not url or not self.allowed(url) or len(css) >= 2:
                continue
            try:
                got = self.fetcher.fetch(url, allowed=self.allowed)
            except EXPECTED_FETCH_ERRORS as e:  # colors are optional: note it and use the page's own colors
                event(log, "research_stylesheet_skipped", logging.DEBUG, url=url, reason=fetch_error_reason(e))
                continue
            except Exception:
                log.exception("reading stylesheet %s failed", url)
                continue
            if got.status == 200:
                css.append(got.text)
        data = self.pages.get(page.url)
        if not css or data is None:
            return
        colors = list(data.get("colors", []))  # the page's own theme color / brand variables come first
        data["colors"] = (colors + [c for c in css_colors(" ".join(css)) if c not in colors])[:6]
        self.store.save_page(self.sid, page.url, data)

    # --- step 2: one research round ---------------------------------------------------------------------------------
    def run_round(self, n: int):
        self.round_pages = 0
        self._videos = self._user_ctx = None  # re-read past videos and the user's prompts once per round
        if self.state.user_id and self.user_context().get("prompts"):
            self.emit("status", status=self.state.status.value, message="using {} earlier prompt(s) from this user"
                      .format(len(self._user_ctx["prompts"])), user_context=summary_line(self._user_ctx))
        vids = self.recent_videos().get("videos", [])
        if vids:
            self.emit("status", status=self.state.status.value,
                      message="{} earlier video(s) for {} found".format(len(vids), self.company), videos=vids)
        if self.llm is not None:
            try:
                self.react(n)
            except Exception as e:
                self.emit("error", where="react", message="{}: {}".format(type(e).__name__, str(e)[:200]))
        self.extract_pending()
        # Fill the page budget with the best unvisited same-site links (the small model often stops early).
        while self.pages_left() > 0 and not self.stop_event.is_set():
            nxt = self.next_link()
            if nxt is None:
                break
            self.get_page(nxt)
        self.extract_pending()

    def next_link(self) -> Optional[str]:
        """Best unvisited link, spreading the budget across sections (about, products, news, sustainability...)."""
        visited = {v.url for v in self.state.visited} | set(self.pages)
        covered: Dict[str, int] = {}
        for v in self.state.visited:
            cat = link_category(v.url, v.title)
            covered[cat] = covered.get(cat, 0) + 1
        best, best_key = None, None
        for url in [v.url for v in self.state.visited]:
            for d in self.links_for(url, limit=60):
                if d["url"] in visited:
                    continue
                key = (d["score"] - 4 * covered.get(link_category(d["url"], d["text"]), 0), -len(d["url"]))
                if best_key is None or key > best_key:
                    best, best_key = d["url"], key
        return best

    def extract_pending(self):
        """Findings from every fetched page not read yet. Each Liquid call takes 5-20 s (the model always reasons),
        so up to `research_parallel` pages are read at once; findings are applied in page order either way."""
        pages = [page for url, page in list(self.pages.items())
                 if url == page.get("url") and page.get("status") == 200 and url not in self.extracted]
        if not pages or self.stop_event.is_set():
            return
        self.extracted.update(page["url"] for page in pages)
        workers = min(max(1, self.settings.research_parallel), len(pages)) if self.llm is not None else 1
        if workers == 1:
            replies = [self.extract_page(page) for page in pages]
        else:
            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="extract-" + self.sid[-8:]) as pool:
                replies = [f.result() for f in [pool.submit(in_context(self.extract_page), page) for page in pages]]
        for page, got in zip(pages, replies):
            if self.stop_event.is_set():
                return
            self.apply_extract(page, got)

    def extract_page(self, page: dict) -> Optional[dict]:
        """Liquid's reply for one page (`purpose=extract_page` in llm_call_done log lines)."""
        if self.llm is None or self.stop_event.is_set():
            return None
        return self.ask_json(EXTRACT_PROMPT.format(
            name=self.company, url=page["url"], title=page.get("title", ""),
            text=page.get("text", "")[:EXTRACT_PAGE_CHARS], n=MAX_FINDINGS_PER_PAGE, topics=", ".join(FINDING_TOPICS)))

    def apply_extract(self, page: dict, got: Optional[dict]):
        """Findings from one page: Liquid proposes quotes, code keeps only verbatim ones. Deterministic fallback:
        the meta description and the first substantial paragraphs."""
        url = page["url"]
        added = 0
        for item in (got or {}).get("findings", [])[:MAX_FINDINGS_PER_PAGE] if isinstance(got, dict) else []:
            if isinstance(item, dict):
                res = self.add_finding(item.get("topic"), item.get("claim"), url, str(item.get("quote", "")),
                                       source="extract")
                added += 1 if res.get("ok") else 0
        if added == 0:
            topic = topic_for_url(url)
            candidates = [page.get("description", "")] + [
                line for line in page.get("text", "").split("\n")
                if len(line) >= 40 and " " in line and not line.startswith("#") and len(line) <= MAX_QUOTE_CHARS]
            for text in candidates[:3]:
                if text and len(text) >= MIN_QUOTE_CHARS:
                    self.add_finding(topic, text[:MAX_QUOTE_CHARS], url, text[:MAX_QUOTE_CHARS], source="page")

    def react(self, n: int):
        tools = ResearchTools(self)
        lc = {t.name: t for t in tools.langchain_tools()}
        st, intent = self.state, self.state.intent
        pages = "; ".join("{} ({})".format(v.url, _clip(v.title, 60)) for v in st.visited[-30:]) or "none"
        topics = sorted({f.topic for f in st.findings})
        answers = "; ".join("{} -> {}".format(q.question, q.answer) for q in st.questions if q.answered) or "none"
        gaps = ", ".join((st.profile.open_questions if st.profile else [])[:6]) or "unknown yet"
        start = ("Start with list_links on the website, then fetch the most useful pages." if n == 1 else
                 "Go deeper: pages you have not fetched yet (list_links on fetched pages), news with dates, proof "
                 "points, and anything the user's answers ask for.")
        task = RESEARCH_TASK.format(name=intent.company_name, home=st.home_url, goal=intent.video_goal or "not given",
                                    round=n, pages_left=self.pages_left(), steps=self.settings.research_max_steps,
                                    n_pages=len(st.visited), pages=pages, n_findings=len(st.findings),
                                    topics=", ".join(topics) or "none", answers=answers, gaps=gaps,
                                    videos=self.videos_line(), user=summary_line(self.user_context()), start=start)
        messages = [SystemMessage(RESEARCH_SYSTEM.format(tools=describe_tools(lc.values()))), HumanMessage(task)]
        nudged, pushes = False, 0
        for step in range(1, self.settings.research_max_steps + 2):
            if self.stop_event.is_set():
                return
            text = self.call_llm(messages, stop=STOP)
            parsed = parse_step(text)
            if parsed[0] == "final":
                if pushes < 2 and self.pages_left() > 0 and step <= self.settings.research_max_steps // 2:
                    pushes += 1  # small models stop early; the budget is there to be used
                    messages += [AIMessage(text), HumanMessage(
                        "You still have {} pages and {} tool steps. Keep researching: list_links on a fetched page, "
                        "fetch unvisited pages (news, brands, sustainability, about) and record_finding.".format(
                            self.pages_left(), self.settings.research_max_steps - step))]
                    continue
                self.emit("status", status=self.state.status.value,
                          message=_clip("agent: " + str(parsed[1].get("brief", "")), 400))
                return
            if parsed[0] == "none":
                if nudged:
                    return
                nudged = True
                messages += [AIMessage(text), HumanMessage("Reply with an Action line or a Final Answer line.")]
                continue
            _, name, args = parsed
            if step > self.settings.research_max_steps:
                messages += [AIMessage(text), HumanMessage("Tool budget reached. Write the Final Answer now.")]
                continue
            tool = lc.get(name)
            t0 = time.perf_counter()
            if tool is None:
                obs = json.dumps({"error": "unknown tool {!r}; use one of {}".format(name, sorted(lc))})
            else:
                try:
                    obs = tool.invoke(args or {})
                except Exception as e:
                    obs = json.dumps({"error": "bad arguments: {}".format(str(e)[:300])})
            event(log, "tool_call_done", logging.INFO if '"error"' not in obs[:20] else logging.WARNING, tool=name,
                  step=step, round=n, ok='"error"' not in obs[:20], inputChars=len(json.dumps(args or {}, default=str)),
                  outputChars=len(obs), error=obs[:200] if '"error"' in obs[:20] else None,
                  durationMs=int((time.perf_counter() - t0) * 1000))
            self.emit("status", status=self.state.status.value, message="tool {}".format(name), tool=name,
                      step=step, ok='"error"' not in obs[:20])
            messages += [AIMessage("Action: {}\nAction Input: {}".format(name, json.dumps(args, default=str))),
                         HumanMessage("Observation: " + obs)]
            self._trim(messages)
        messages.append(HumanMessage("Stop using tools. Write the Final Answer now."))
        self.call_llm(messages, stop=STOP)

    def _trim(self, messages):
        """Keeps all observations within research_context_chars by eliding the oldest ones."""
        obs = [m for m in messages if isinstance(m, HumanMessage) and m.content.startswith("Observation: ")]
        total = sum(len(m.content) for m in obs)
        for m in obs[:-1]:
            if total <= self.settings.research_context_chars:
                break
            if m.content != ELIDED:
                total -= len(m.content) - len(ELIDED)
                m.content = ELIDED

    # --- step 3: profile --------------------------------------------------------------------------------------------
    def _empty_profile(self) -> CompanyProfile:
        return CompanyProfile(session_id=self.sid, name=self.company or "unknown", domain=self.state.domain,
                              updated_at=_now())

    def build_profile(self):
        st = self.state
        findings = list(st.findings)[-80:]
        ids = {"F{}".format(i + 1): f for i, f in enumerate(findings)}
        home = self.pages.get(st.home_url or "", {})
        answers = "; ".join("{} -> {}".format(q.question, q.answer) for q in st.questions if q.answered) or "none"
        got = None
        if self.llm is not None and findings:
            lines = ["F{} [{}] {} ({})".format(i + 1, f.topic, f.claim, f.evidence_url) for i, f in
                     enumerate(findings)]
            budget = self.settings.research_context_chars
            while len("\n".join(lines)) > budget and len(lines) > 10:
                lines = lines[1:]
            pages = "; ".join("{} - {}".format(v.url, _clip(v.title, 50)) for v in st.visited[:25])
            got = self.ask_json(PROFILE_PROMPT.format(name=self.company, domain=st.domain, goal=st.intent.video_goal,
                                                      answers=answers, pages=pages, findings="\n".join(lines)))

        def sourced(value) -> Optional[SourcedText]:
            if not isinstance(value, dict) or not str(value.get("text", "")).strip():
                return None
            refs = [ids[r] for r in (value.get("findings") or []) if isinstance(r, str) and r in ids]
            if not refs:
                return None
            return SourcedText(text=_clip(value["text"], 500), evidence_url=refs[0].evidence_url,
                               finding_ids=[f.finding_id for f in refs][:6])

        def from_finding(f: Optional[Finding]) -> Optional[SourcedText]:
            return SourcedText(text=f.claim, evidence_url=f.evidence_url, finding_ids=[f.finding_id]) if f else None

        by_topic = lambda *t: [f for f in findings if f.topic in t]  # noqa: E731
        home_finding = next((f for f in findings if f.evidence_url == st.home_url), None)
        got = got if isinstance(got, dict) else {}
        profile = self._empty_profile()
        profile.one_line = sourced(got.get("one_line")) or from_finding(home_finding or next(iter(findings), None))
        profile.what_they_do = sourced(got.get("what_they_do")) or from_finding(next(iter(by_topic("about")), None))
        profile.products = [s for s in (sourced(p) for p in (got.get("products") or [])[:10]) if s] or [
            from_finding(f) for f in by_topic("product")[:6]]
        profile.audience = sourced(got.get("audience")) or from_finding(next(iter(by_topic("audience")), None))
        profile.brand_voice = sourced(got.get("brand_voice"))
        if profile.brand_voice is None and isinstance(got.get("brand_voice"), dict) and got["brand_voice"].get("text"):
            # tone is read off the site's own copy; cite the homepage
            profile.brand_voice = SourcedText(text=_clip(got["brand_voice"]["text"], 300), evidence_url=st.home_url)
        profile.key_messages = [s for s in (sourced(k) for k in (got.get("key_messages") or [])[:8]) if s] or [
            from_finding(f) for f in by_topic("brand")[:5]]
        proof = [ids[r] for r in (got.get("proof_points") or []) if isinstance(r, str) and r in ids]
        profile.proof_points = (proof or by_topic("proof", "sustainability", "people"))[:8]
        news, this_year = [], _now().year
        for f in by_topic("news"):
            if re.search(r"©|copyright|all rights reserved", f.quote, re.I):
                continue
            dates = find_dates(f.quote) or find_dates(f.claim) or find_dates(f.evidence_url)
            years = [int(y) for y in re.findall(r"\b(1[6-9]\d\d|20\d\d)\b", " ".join(dates) or f.quote)]
            if years and max(years) < this_year - 2:  # history, not news
                continue
            news.append(NewsItem(title=_clip(f.claim, 300), date=dates[0] if dates else None, url=f.evidence_url))
        profile.recent_news = news[:8]
        colors: List[str] = []
        for p in [home] + [self.pages[v.url] for v in st.visited if v.url in self.pages]:
            for c in p.get("colors", []):
                if c not in colors:
                    colors.append(c)
        profile.visual_identity = VisualIdentity(
            colors=colors[:6], logo_url=home.get("logo_url"), og_image=home.get("og_image"),
            imagery_style=_clip(got.get("imagery_style", ""), 300) if isinstance(got.get("imagery_style"), str)
            else "", evidence_url=st.home_url)
        if not profile.visual_identity.imagery_style and profile.brand_voice:
            profile.visual_identity.imagery_style = _clip("authentic, candid lifestyle photography with a {} feel"
                                                          .format(profile.brand_voice.text.lower().rstrip(".")), 300)
        gaps = [_clip(q, 200) for q in (got.get("open_questions") or []) if isinstance(q, str) and q.strip()][:6]
        for field, question in (("audience", "Who is the target audience?"),
                                ("products", "Which product or brand should be featured?"),
                                ("recent_news", "Is there recent news worth mentioning?")):
            if not getattr(profile, field) and question not in gaps:
                gaps.append(question)
        with self.lock:
            prev = st.profile
            profile.video_brief = prev.video_brief if prev else VideoBrief()
            if prev is None:
                for q in st.prior_answers:  # earlier sessions' answers are defaults; new answers overwrite them
                    apply_answer(profile.video_brief, q)
            if not profile.video_brief.goal and st.intent and st.intent.video_goal:
                profile.video_brief.goal = st.intent.video_goal
            answered = [q for q in st.questions if q.answered]
            profile.open_questions = [g for g in gaps if not any(_same_gap(g, q) for q in answered)]
            profile.version = (prev.version if prev else 0) + 1
            profile.model = self.settings.model if got else "deterministic"
            profile.updated_at = _now()
            st.profile = profile
            self.save()
        self.emit("profile", profile=profile.model_dump(mode="json"), reason="round")
        self.queue_row("profile", "v{}".format(profile.version), profile.model_dump(mode="json"), st.home_url or "")

    # --- step 4: follow-up questions --------------------------------------------------------------------------------
    def generate_questions(self):
        st = self.state
        open_qs = [q for q in st.questions if not q.answered]
        if len(open_qs) >= 3 or len(st.questions) >= MAX_QUESTIONS:
            return
        expressed = self.expressed()
        asked_topics = {q.topic for q in st.questions} | set(expressed)
        gaps = [g for g in (st.profile.open_questions if st.profile else [])]
        if st.questions and not gaps:
            return
        want = max(3, min(5, 5 - len(open_qs)))
        profile = st.profile
        products = [p.text for p in (profile.products if profile else [])][:6]
        added = 0
        got = self.ask_json(QUESTIONS_PROMPT.format(
            name=self.company, one_line=profile.one_line.text if profile and profile.one_line else "",
            goal=st.intent.video_goal if st.intent else "", products="; ".join(products) or "unknown",
            asked="; ".join(q.question for q in st.questions) or "nothing",
            answers="; ".join("{} -> {}".format(q.question, q.answer) for q in st.questions if q.answered) or "none",
            gaps="; ".join(gaps) or "none", videos=self.videos_line(), user=summary_line(self.user_context()),
            expressed="; ".join("{}: {}".format(k, v) for k, v in expressed.items()) or "nothing",
            n=want, topics=", ".join(QUESTION_TOPICS)))
        for item in (got or {}).get("questions", [])[:6] if isinstance(got, dict) else []:
            if added >= want or not isinstance(item, dict):
                continue
            opts = [o for o in (item.get("options") or []) if isinstance(o, str)]
            if len(opts) < 2 or str(item.get("topic")) in expressed:
                continue
            q = self.add_question(str(item.get("question", "")), opts, str(item.get("topic", "other")), "llm")
            added += 0 if isinstance(q, dict) else 1
        for topic in TEMPLATE_ORDER:
            if added >= want or len(open_qs) + added >= 5:
                break
            if topic in asked_topics or any(q.topic == topic for q in st.questions):
                continue
            text, opts = TEMPLATES[topic]
            if topic == "product":
                opts = [_clip(re.split(r"[:.,;(]| - | is ", p)[0], 60) for p in products][:3] + ["The whole portfolio"]
                if len(opts) < 2:
                    opts = ["The flagship product", "The whole portfolio", "A new launch"]
            q = self.add_question(text.format(name=self.company), opts, topic, "template")
            added += 0 if isinstance(q, dict) else 1

    # --- API view ---------------------------------------------------------------------------------------------------
    def view(self) -> dict:
        with self.lock:
            return session_view(self.state)


def _same_gap(gap: str, q: FollowUpQuestion) -> bool:
    words = lambda s: {w for w in re.findall(r"[a-z]{4,}", s.lower())} - {"what", "which", "should", "video"}  # noqa
    g, a = words(gap), words(q.question)
    topic_words = {"audience": {"audience"}, "product": {"product", "brand", "feature", "featured"},
                   "tone": {"tone"}, "cta": {"action"}, "format": {"long", "length", "format"}}.get(q.topic, set())
    return bool(g & topic_words) or (bool(g) and len(g & a) >= max(2, len(g) // 2))


def apply_answer(brief: VideoBrief, q: FollowUpQuestion):
    field = TOPIC_FIELD.get(q.topic)
    if field:
        setattr(brief, field, q.answer or "")
    else:
        note = "{} {}".format(q.question, q.answer)
        if note not in brief.notes:
            brief.notes.append(_clip(note, 400))


def session_view(state: ResearchSessionState) -> dict:
    return {
        "session_id": state.session_id, "status": state.status.value, "looping": state.looping,
        "publish": state.publish, "prompt": state.prompt, "user_id": state.user_id,
        "company": state.intent.company_name if state.intent else None,
        "domain": state.domain, "home_url": state.home_url,
        "video_goal": state.intent.video_goal if state.intent else None,
        "profile": state.profile.model_dump(mode="json") if state.profile else None,
        "questions": [{"id": q.question_id, "topic": q.topic, "question": q.question, "options": q.options,
                       "answered": q.answered, "answer": q.answer, "source": q.source} for q in state.questions],
        "answers": [{"question_id": q.question_id, "topic": q.topic, "question": q.question, "answer": q.answer,
                     "answered_at": q.answered_at} for q in state.questions if q.answered],
        "findings": [f.model_dump(mode="json") for f in state.findings[-100:]],
        "pages": [v.model_dump(mode="json") for v in state.visited[-100:]],
        "stats": {"pages": state.stats.pages, "findings": state.stats.findings, "tokens": state.stats.tokens,
                  "input_tokens": state.stats.input_tokens, "output_tokens": state.stats.output_tokens,
                  "llm_calls": state.stats.llm_calls, "rounds": state.stats.rounds},
        "error": state.error, "created_at": state.created_at, "updated_at": state.updated_at,
    }


class Busy(Exception):
    pass


class ResearchManager:
    """Owns the live sessions of one worker. At most MAX_CONCURRENT_SESSIONS run at once."""

    def __init__(self, settings, store, llm_factory=None, outbox=None, rawtree=None, publish=False,
                 fetcher_factory=None, reader=None):
        self.settings, self.store = settings, store
        self.llm_factory = llm_factory or (lambda: None)
        self.outbox, self.rawtree, self.publish = outbox, rawtree, publish
        self.reader = reader if reader is not None else rawtree
        self.fetcher_factory = fetcher_factory or WebFetcher
        self.sessions: Dict[str, ResearchSession] = {}
        self.lock = threading.Lock()
        for st in store.sessions(statuses=[s.value for s in ResearchStatus if s not in FINAL_STATUSES]):
            st.status, st.looping = ResearchStatus.done, False
            store.save(st)
            store.append_event(st.session_id, "status", {"status": "done", "message":
                                                         "interrupted by a worker restart; POST /loop to resume"})

    def running(self) -> int:
        return sum(1 for s in self.sessions.values() if s.alive())

    def _session(self, state) -> ResearchSession:
        return ResearchSession(self.settings, state, self.store, llm=self.llm_factory(), outbox=self.outbox,
                               rawtree=self.rawtree, fetcher=self.fetcher_factory(), reader=self.reader)

    def start(self, prompt: str, looping: bool = True, test: bool = False, user_id: Optional[str] = None) -> str:
        with self.lock:
            if self.running() >= MAX_CONCURRENT_SESSIONS:
                raise Busy("{} research sessions are already running; stop one first".format(self.running()))
            sid = ("test_research_" if test else "research_") + uuid.uuid4().hex[:16]
            now = _now()
            state = ResearchSessionState(session_id=sid, prompt=prompt, created_at=now, updated_at=now,
                                         looping=looping, publish=self.publish, is_test=test,
                                         user_id=valid_user_id(user_id))
            self.store.save(state)
            session = self._session(state)
            self.sessions[sid] = session
            session.emit("status", status="starting", message="session created", looping=looping,
                         publish=self.publish)
            session.start()
            return sid

    def get(self, sid: str) -> Optional[ResearchSession]:
        with self.lock:
            if sid in self.sessions:
                return self.sessions[sid]
            state = self.store.load(sid)
            if state is None:
                return None
            session = self._session(state)
            self.sessions[sid] = session
            return session

    def view(self, sid: str) -> Optional[dict]:
        s = self.get(sid)
        if s is None:
            return None
        out = s.view()
        out["running"] = s.alive()
        return out

    def set_looping(self, sid: str, looping: bool) -> dict:
        s = self.get(sid)
        if s is None:
            raise KeyError(sid)
        if s.state.status == ResearchStatus.stopped:
            raise ValueError("session was stopped; start a new one")
        s.set_looping(looping)
        if looping and not s.alive():
            with self.lock:
                if self.running() >= MAX_CONCURRENT_SESSIONS:
                    raise Busy("too many research sessions running")
                s.stop_event.clear()
                s.start()
        return {"session_id": sid, "looping": looping, "running": s.alive()}

    def stop(self, sid: str) -> dict:
        s = self.get(sid)
        if s is None:
            raise KeyError(sid)
        s.stop()
        return {"session_id": sid, "status": s.state.status.value}

    def answer(self, sid: str, question_id: str, answer: str) -> dict:
        s = self.get(sid)
        if s is None:
            raise KeyError(sid)
        q = s.answer(question_id, answer)
        return {"session_id": sid, "question_id": q.question_id, "answered": True,
                "video_brief": s.state.profile.video_brief.model_dump() if s.state.profile else None}

    def finished(self, sid: str) -> bool:
        s = self.sessions.get(sid)
        if s is not None:
            return not s.alive() and s.state.status in FINAL_STATUSES
        st = self.store.load(sid)
        return st is None or st.status in FINAL_STATUSES
