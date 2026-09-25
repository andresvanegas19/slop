"""A small JSON-over-Liquid helper for the story tools (competitors, storyline, company detection).

Liquid (LFM on OpenRouter) has no guaranteed structured output: replies are parsed with react.loose_json, which repairs
truncated objects and code fences. Calls never raise; failures return None and are counted.
"""
import logging
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from typing import Optional

from langchain_core.messages import HumanMessage

from .react import SPECIAL_TOKEN_RE, _text, loose_json

log = logging.getLogger("agent.story")
_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="story-llm")


class JsonLlm:
    def __init__(self, llm=None, model: str = "deterministic"):
        self.llm, self.model = llm, model
        self.calls = self.tokens = self.failures = 0
        self.lock = threading.Lock()

    @property
    def enabled(self):
        return self.llm is not None

    def ask(self, prompt: str, timeout_s: Optional[float] = None) -> Optional[dict]:
        if self.llm is None:
            return None

        def call():
            return self.llm.invoke([HumanMessage(prompt)])

        try:
            message = _POOL.submit(call).result(timeout=timeout_s) if timeout_s else call()
        except FutureTimeout:
            with self.lock:
                self.failures += 1
            log.info("liquid call timed out after %ss", timeout_s)
            return None
        except Exception as e:
            with self.lock:
                self.failures += 1
            log.warning("liquid call failed: %s", type(e).__name__)
            return None
        usage = getattr(message, "usage_metadata", None) or {}
        with self.lock:
            self.calls += 1
            self.tokens += (usage.get("input_tokens", 0) or 0) + (usage.get("output_tokens", 0) or 0)
        got = loose_json(SPECIAL_TOKEN_RE.sub("", _text(message)))
        return got if isinstance(got, dict) else None
