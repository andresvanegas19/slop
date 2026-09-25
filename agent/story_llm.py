"""A small JSON-over-Liquid helper for the story tools (competitors, storyline, company detection).

Liquid (LFM on OpenRouter) has no guaranteed structured output: replies are parsed with react.loose_json, which repairs
truncated objects and code fences. Calls never raise; failures return None and are counted.
"""
import logging
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from typing import Optional

from langchain_core.messages import HumanMessage

from core.logs import event, in_context

from .react import SPECIAL_TOKEN_RE, _text, loose_json

log = logging.getLogger("agent.story")
_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="story-llm")


class JsonLlm:
    def __init__(self, llm=None, model: str = "deterministic", timeout_s: Optional[float] = None):
        self.llm, self.model, self.timeout_s = llm, model, timeout_s
        self.calls = self.tokens = self.failures = 0
        self.lock = threading.Lock()

    @property
    def enabled(self):
        return self.llm is not None

    def ask(self, prompt: str, timeout_s: Optional[float] = None) -> Optional[dict]:
        if self.llm is None:
            return None
        timeout_s = timeout_s or self.timeout_s

        def call():
            return self.llm.invoke([HumanMessage(prompt)])

        try:
            message = _POOL.submit(in_context(call)).result(timeout=timeout_s) if timeout_s else call()
        except FutureTimeout:
            with self.lock:
                self.failures += 1
            event(log, "liquid_call_timed_out", logging.WARNING, model=self.model, timeoutS=timeout_s)
            return None
        except Exception as e:
            with self.lock:
                self.failures += 1
            # event() scrubs key-looking strings, so the provider's message (429, 401, bad model …) is safe to keep.
            event(log, "liquid_call_failed", logging.WARNING, model=self.model,
                  error="{}: {}".format(type(e).__name__, str(e)[:300]))
            return None
        usage = getattr(message, "usage_metadata", None) or {}
        with self.lock:
            self.calls += 1
            self.tokens += (usage.get("input_tokens", 0) or 0) + (usage.get("output_tokens", 0) or 0)
        text = SPECIAL_TOKEN_RE.sub("", _text(message))
        got = loose_json(text)
        if not isinstance(got, dict):
            with self.lock:
                self.failures += 1
            event(log, "liquid_reply_not_json", logging.WARNING, model=self.model, replyChars=len(text))
            return None
        return got
