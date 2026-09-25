"""The long-running loop and the local HTTP trigger.

Loop: every tick, optionally run one core cycle (new RawTree evidence -> beliefs), then rebuild the cached
CompanyContext when state changed or the cache is older than AGENT_REFRESH_S, and deliver the outbox with --publish.

Trigger: the video app POSTs {prompt, kind} to http://127.0.0.1:<port>/context before generating. The agent runs a
prompt-focused ReAct pass; if it takes longer than AGENT_PROMPT_TIMEOUT_S the cached context is returned instead
(the run keeps going and its result is cached for next time). Bound to 127.0.0.1 only.
"""
import json
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from core.repository import StateRepository

from .react import CompanyAgent
from .research import Busy
from .user_context import valid_user_id

log = logging.getLogger("agent")
KINDS = {"image", "video", "multishot", "storyboard", "preset", "edit"}
MAX_BODY_BYTES = 64 * 1024
MAX_PROMPT_CHARS = 32_000
MAX_CONCURRENT_PROMPTS = 2
RESEARCH_PATH = re.compile(r"^/research/([A-Za-z0-9_]{1,64})(?:/(events|answer|loop|stop))?$")
STREAM_MAX_S = 900        # one events stream stays open at most this long; the client reconnects with ?after=
HEARTBEAT_S = 15


def _age_s(ctx):
    return (datetime.now(timezone.utc) - ctx.generated_at).total_seconds()


class AgentWorker:
    def __init__(self, settings, agent: CompanyAgent, store, coordinator=None, rawtree=None, publish=False,
                 research=None, story=None):
        self.settings, self.agent, self.store = settings, agent, store
        self.coordinator, self.rawtree, self.publish = coordinator, rawtree, publish
        self.research = research  # ResearchManager (agent/research.py), or None
        self.story = story  # StoryService (agent/story_api.py): detection, competitors, storyline; or None
        self.pool = ThreadPoolExecutor(max_workers=MAX_CONCURRENT_PROMPTS + 1, thread_name_prefix="agent")
        self.prompt_slots = threading.BoundedSemaphore(MAX_CONCURRENT_PROMPTS)
        self.loop_lock = threading.Lock()
        self.last_tick = None

    def state_version(self):
        if not Path(self.settings.state_db).exists():
            return None
        repo = StateRepository(self.settings.state_db)
        try:
            return repo.version
        finally:
            repo.db.close()

    def tick(self):
        """One loop step. Never raises: a bad tick is logged and the next one tries again."""
        summary = {"at": datetime.now(timezone.utc).isoformat(), "core": None, "refreshed": False, "published": 0}
        with self.loop_lock:
            if self.coordinator is not None:
                try:
                    run, storyboard, _ = self.coordinator.run_cycle()
                    summary["core"] = {"run_id": run.run_id, "pages": run.pages_fetched,
                                       "accepted": run.ops_accepted, "storyboard": bool(storyboard)}
                except Exception as e:
                    summary["core"] = {"error": "{}: {}".format(type(e).__name__, str(e)[:200])}
            version = self.state_version()
            cached = self.store.latest_context("loop")
            changed = str(version) != self.store.get("loop_state_version")
            if cached is None or changed or _age_s(cached) > self.settings.refresh_s:
                try:
                    ctx, run = self.agent.run("loop")
                    self.store.set("loop_state_version", version)
                    summary.update(refreshed=True, context_id=ctx.context_id, steps=run.steps,
                                   llm_calls=run.llm_calls, tokens=run.input_tokens + run.output_tokens)
                except Exception as e:
                    summary["agent_error"] = "{}: {}".format(type(e).__name__, str(e)[:200])
            if self.publish and self.rawtree is not None:
                try:
                    summary["published"] = self.store.deliver(self.rawtree)
                    if self.coordinator is not None:
                        from core.coordinator import OutboxDeliverer
                        summary["published"] += OutboxDeliverer(self.coordinator.repo, self.rawtree).deliver()
                except Exception as e:
                    summary["publish_error"] = "{}: {}".format(type(e).__name__, str(e)[:200])
        self.last_tick = summary
        log.info("tick %s", json.dumps(summary))
        return summary

    def run_forever(self, stop: threading.Event):
        while not stop.is_set():
            self.tick()
            stop.wait(self.settings.interval_s)

    def context_for_prompt(self, prompt, kind, user_id=None):
        """Returns (CompanyContext, stale). Waits at most AGENT_PROMPT_TIMEOUT_S for a fresh prompt-focused run."""
        cached = self.store.latest_context()
        if not self.prompt_slots.acquire(blocking=False):
            return self._cached_or_fallback(cached), True

        def job():
            try:
                return self.agent.run("prompt", prompt=prompt, kind=kind, user_id=user_id)[0]
            finally:
                self.prompt_slots.release()

        future = self.pool.submit(job)
        try:
            return future.result(timeout=self.settings.prompt_timeout_s), False
        except FutureTimeout:
            return self._cached_or_fallback(cached), True
        except Exception as e:
            log.warning("prompt run failed: %s", type(e).__name__)
            return self._cached_or_fallback(cached), True

    def _cached_or_fallback(self, cached):
        if cached is not None:
            return cached
        return CompanyAgent(self.settings, None, self.rawtree, store=None).run("prompt")[0]

    def health(self):
        cached = self.store.latest_context()
        return {"ok": True, "model": self.settings.model, "llm": self.settings.llm_enabled,
                "rawtree": self.rawtree is not None, "publish": self.publish,
                "lastContextAt": cached.generated_at.isoformat() if cached else None,
                "lastTick": self.last_tick,
                "research": None if self.research is None else {"running": self.research.running(),
                                                                "publish": self.research.publish},
                "story": None if self.story is None else self.story.health()}


def make_handler(worker: AgentWorker):
    class Handler(BaseHTTPRequestHandler):
        server_version = "CompanyAgent/1"

        def log_message(self, fmt, *args):  # no request bodies or prompts in logs
            log.debug("http %s %s", self.command, self.path.split("?")[0])

        def _send(self, status, body):
            data = json.dumps(body, default=str).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _body(self):
            """Parsed JSON object body, or None after an error response was sent."""
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if length <= 0 or length > MAX_BODY_BYTES:
                self._send(413 if length > MAX_BODY_BYTES else 400, {"error": "a JSON body up to 64 KB is required"})
                return None
            try:
                body = json.loads(self.rfile.read(length))
            except ValueError:
                self._send(400, {"error": "malformed JSON"})
                return None
            if not isinstance(body, dict):
                self._send(400, {"error": "the body must be a JSON object"})
                return None
            return body

        def do_GET(self):
            path, _, query = self.path.partition("?")
            if path == "/health":
                return self._send(200, worker.health())
            if path == "/context":
                ctx = worker.store.latest_context()
                if ctx is None:
                    return self._send(404, {"error": "no context yet"})
                return self._send(200, {"context": ctx.model_dump(mode="json"), "stale": True})
            routed = worker.story.handle("GET", path, None) if worker.story is not None else None
            if routed is not None:
                return self._send(*routed)
            m = RESEARCH_PATH.match(path)
            if m and worker.research is not None and m.group(2) in (None, "events"):
                view = worker.research.view(m.group(1))
                if view is None:
                    return self._send(404, {"error": "no research session {}".format(m.group(1))})
                if m.group(2) is None:
                    if worker.story is not None:
                        view.update(worker.story.extras(m.group(1)))
                    return self._send(200, view)
                return self._stream_events(m.group(1), query)
            return self._send(404, {"error": "not found"})

        def _stream_events(self, sid, query):
            """NDJSON: every event with seq > after, then new ones as they happen, until the session finishes
            (or ?follow=0, or STREAM_MAX_S). Heartbeats {"type":"heartbeat"} keep proxies from timing out."""
            params = dict(p.split("=", 1) for p in query.split("&") if "=" in p)
            try:
                after = max(0, int(params.get("after", 0)))
            except ValueError:
                after = 0
            follow = params.get("follow", "1") not in ("0", "false")
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            started = last_write = time.time()
            try:
                while True:
                    events = worker.research.store.events(sid, after=after)
                    for e in events:
                        self.wfile.write((json.dumps(e, default=str, ensure_ascii=False) + "\n").encode())
                        after = e["seq"]
                    if events:
                        self.wfile.flush()
                        last_write = time.time()
                        continue
                    finished = worker.research.finished(sid) and not (worker.story and worker.story.pending(sid))
                    if not follow or finished or time.time() - started > STREAM_MAX_S:
                        break
                    if time.time() - last_write > HEARTBEAT_S:
                        self.wfile.write((json.dumps({"type": "heartbeat", "after": after}) + "\n").encode())
                        self.wfile.flush()
                        last_write = time.time()
                    time.sleep(0.4)
            except (BrokenPipeError, ConnectionResetError):
                return
            self.close_connection = True

        def do_POST(self):
            path = self.path.split("?")[0]
            if path == "/context":
                return self._context()
            if worker.story is not None and worker.story.handles(path):
                body = self._body()
                return None if body is None else self._send(*worker.story.handle("POST", path, body))
            if worker.research is None or not (path == "/research" or RESEARCH_PATH.match(path)):
                return self._send(404, {"error": "not found"})
            body = self._body()
            if body is None:
                return None
            research = worker.research
            if path == "/research":
                prompt = body.get("prompt")
                if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT_CHARS:
                    return self._send(400, {"error": "prompt must be a string of 1 to 32,000 characters"})
                looping = body.get("looping", True)
                if not isinstance(looping, bool):
                    return self._send(400, {"error": "looping must be a boolean"})
                user_id = body.get("user_id") or self.headers.get("X-Longform-User")
                if user_id not in (None, "", "anonymous") and valid_user_id(user_id) is None:
                    return self._send(400, {"error": "user_id must be 1-128 characters of letters, digits, _.@:+-"})
                try:
                    sid = research.start(prompt.strip(), looping=looping, test=body.get("test") is True,
                                         user_id=user_id)
                except Busy as e:
                    return self._send(429, {"error": str(e)})
                return self._send(201, {"session_id": sid, "status": "starting", "looping": looping,
                                        "publish": research.publish})
            m = RESEARCH_PATH.match(path)
            sid, action = m.group(1), m.group(2)
            try:
                if action == "answer":
                    qid, answer = body.get("question_id"), body.get("answer")
                    if not isinstance(qid, str) or not isinstance(answer, str) or not answer.strip() \
                            or len(answer) > 2000:
                        return self._send(400, {"error": "send {question_id: string, answer: 1-2000 characters}"})
                    return self._send(200, research.answer(sid, qid, answer))
                if action == "loop":
                    if not isinstance(body.get("looping"), bool):
                        return self._send(400, {"error": "send {looping: true|false}"})
                    return self._send(200, research.set_looping(sid, body["looping"]))
                if action == "stop":
                    return self._send(200, research.stop(sid))
            except KeyError as e:
                return self._send(404, {"error": "not found: {}".format(str(e).strip("'"))})
            except Busy as e:
                return self._send(429, {"error": str(e)})
            except ValueError as e:
                return self._send(409, {"error": str(e)})
            return self._send(404, {"error": "not found"})

        def _context(self):
            body = self._body()
            if body is None:
                return None
            prompt, kind = body.get("prompt"), body.get("kind", "video")
            if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT_CHARS:
                return self._send(400, {"error": "prompt must be a string of 1 to 32,000 characters"})
            if kind not in KINDS:
                return self._send(400, {"error": "kind must be one of {}".format(sorted(KINDS))})
            user_id = valid_user_id(body.get("user_id") or self.headers.get("X-Longform-User"))
            ctx, stale = worker.context_for_prompt(prompt.strip(), kind, user_id=user_id)
            return self._send(200, {"context": ctx.model_dump(mode="json"), "stale": stale})

    return Handler


def serve(worker: AgentWorker, port: int):
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(worker))
    thread = threading.Thread(target=server.serve_forever, name="agent-http", daemon=True)
    thread.start()
    return server
