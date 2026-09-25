"""LangChain callback that logs every Liquid/OpenRouter chat call made through agent.llm.liquid_chat_model:
`llm_call_done` (model, purpose, prompt/response chars, input/output/reasoning tokens, latency) or `llm_call_failed`.
Prompts are not logged, only a 200-char preview of the last message."""
import logging
import sys
import threading
import time

from langchain_core.callbacks import BaseCallbackHandler

from core.logs import event

log = logging.getLogger("agent.llm")
GENERIC = {"call_llm", "_call", "ask", "ask_json", "call", "invoke", "run", "_run", "<lambda>", "result"}


def caller_purpose() -> str:
    """Name of the first agent/core function up the stack that is not a generic wrapper (e.g. `extract_page`)."""
    frame = sys._getframe(1)
    fallback = None
    while frame is not None:
        path = frame.f_code.co_filename.replace("\\", "/")
        name = frame.f_code.co_name
        if ("/agent/" in path or "/core/" in path) and not path.endswith("llm_log.py"):
            if name not in GENERIC:
                return name
            fallback = fallback or name
        frame = frame.f_back
    return fallback or "unknown"


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in content)
    return str(content or "")


class LlmLogHandler(BaseCallbackHandler):
    def __init__(self, model: str):
        self.model = model
        self.calls = {}
        self.lock = threading.Lock()

    def on_chat_model_start(self, serialized, messages, *, run_id, metadata=None, **kwargs):
        flat = [m for batch in messages for m in batch]
        chars = sum(len(_text(getattr(m, "content", ""))) for m in flat)
        purpose = (metadata or {}).get("purpose") or caller_purpose()
        with self.lock:
            self.calls[run_id] = (time.perf_counter(), chars, purpose)
        event(log, "llm_call_started", logging.DEBUG, model=self.model, purpose=purpose, messages=len(flat),
              promptChars=chars, prompt=_text(getattr(flat[-1], "content", "")) if flat else "")

    def _pop(self, run_id):
        with self.lock:
            return self.calls.pop(run_id, (time.perf_counter(), 0, "unknown"))

    def on_llm_end(self, response, *, run_id, **kwargs):
        t0, chars, purpose = self._pop(run_id)
        usage, text = {}, ""
        try:
            gen = response.generations[0][0]
            message = getattr(gen, "message", None)
            text = _text(getattr(message, "content", None) or getattr(gen, "text", ""))
            usage = dict(getattr(message, "usage_metadata", None) or {})
        except (IndexError, AttributeError, TypeError):
            pass
        if not usage:
            raw = (getattr(response, "llm_output", None) or {}).get("token_usage") or {}
            usage = {"input_tokens": raw.get("prompt_tokens"), "output_tokens": raw.get("completion_tokens"),
                     "total_tokens": raw.get("total_tokens")}
        details = usage.get("output_token_details") or {}
        event(log, "llm_call_done", model=self.model, purpose=purpose, promptChars=chars, responseChars=len(text),
              inputTokens=usage.get("input_tokens"), outputTokens=usage.get("output_tokens"),
              reasoningTokens=details.get("reasoning") or None, totalTokens=usage.get("total_tokens"),
              durationMs=int((time.perf_counter() - t0) * 1000))

    def on_llm_error(self, error, *, run_id, **kwargs):
        t0, chars, purpose = self._pop(run_id)
        event(log, "llm_call_failed", logging.WARNING, model=self.model, purpose=purpose, promptChars=chars,
              error="{}: {}".format(type(error).__name__, str(error)[:300]),
              durationMs=int((time.perf_counter() - t0) * 1000))
