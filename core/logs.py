"""Structured logging for the Python agent and core, in the same style as the web app (docs/LOGGING.md).

- Console: one line per event, `[agent] 15:23:48.141 INFO  trace=ab12cd34 session=rs_1 llm_call_done model=... (agent.llm)`.
- File: NDJSON appended to generation-video/output/logs/agent-<YYYY-MM-DD>.ndjson (`source: "agent"`), the folder the
  web app's /api/logs and the Logs drawer read. Rotated daily by name; LOG_DIR overrides the folder.
- Context (contextvars): `log_context(traceId=..., sessionId=...)` / `bind(...)`; every line logged inside carries it.
  Threads do not inherit contextvars: start them with `contextvars.copy_context().run` (see `in_context`).
- Structured events: `event(log, "name", key=value, ...)`; timings: `with span(log, "name", key=value) as extra:`.
- Secrets never reach the logs: secret-looking keys are redacted, key-looking substrings masked, strings capped.
"""
import contextvars
import json
import logging
import os
import re
import secrets
import sys
import threading
import time
import traceback
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

_CTX = contextvars.ContextVar("longform_log_context", default={})
LEVEL_NAMES = {"debug": logging.DEBUG, "info": logging.INFO, "warn": logging.WARNING, "warning": logging.WARNING,
               "error": logging.ERROR}
MAX_STRING = 500
MAX_PROMPT = 200
SECRET_KEY = re.compile(r"(api[_-]?key|secret|password|authorization|cookie|^x-key$|^token$|access[_-]?token|bearer)",
                        re.I)
PROMPT_KEY = re.compile(r"(prompt|message|reply|content|instruction|text|query|sql)$", re.I)
SECRET_VALUE = [re.compile(r"sk-or-[A-Za-z0-9_-]{8,}"), re.compile(r"sk-[A-Za-z0-9_-]{16,}"),
                re.compile(r"Bearer\s+[A-Za-z0-9._-]{8,}", re.I)]
ENVELOPE = {"ts", "level", "event", "source"}
COLORS = {"DEBUG": "\x1b[90m", "INFO": "\x1b[36m", "WARN": "\x1b[33m", "ERROR": "\x1b[31m"}


def new_trace_id() -> str:
    return secrets.token_hex(6)


def current() -> dict:
    return dict(_CTX.get())


def bind(**fields):
    """Adds fields to the current context (for the rest of this thread / context). Returns the reset token."""
    merged = dict(_CTX.get())
    merged.update({k: v for k, v in fields.items() if v not in (None, "")})
    return _CTX.set(merged)


@contextmanager
def log_context(**fields):
    token = bind(**fields)
    try:
        yield current()
    finally:
        _CTX.reset(token)


def in_context(fn, **fields):
    """`fn` wrapped to run in a copy of the current context (plus `fields`) — pass it as a Thread target."""
    ctx = contextvars.copy_context()
    ctx.run(bind, **fields)
    return lambda *a, **kw: ctx.run(fn, *a, **kw)


def _cap(text: str, limit: int) -> str:
    return text if len(text) <= limit else "{}…(+{})".format(text[:limit], len(text) - limit)


def _scrub(text: str) -> str:
    for pattern in SECRET_VALUE:
        text = pattern.sub("***", text)
    return text


def _clean(key, value, depth=0):
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return round(value, 3) if isinstance(value, float) else value
    if isinstance(value, str):
        if SECRET_KEY.search(str(key)):
            return "[redacted]" if value else value
        return _scrub(_cap(value, MAX_PROMPT if PROMPT_KEY.search(str(key)) else MAX_STRING))
    if isinstance(value, BaseException):
        return _scrub(_cap("{}: {}".format(type(value).__name__, value), MAX_STRING))
    if depth >= 2:
        return "[object]"
    if isinstance(value, dict):
        return {str(k): ("[redacted]" if SECRET_KEY.search(str(k)) and v else _clean(k, v, depth + 1))
                for k, v in list(value.items())[:30]}
    if isinstance(value, (list, tuple, set)):
        return [_clean(key, v, depth + 1) for v in list(value)[:20]]
    return _scrub(_cap(str(value), MAX_STRING))


def event(logger: logging.Logger, name: str, level=logging.INFO, /, **fields):
    """Logs a structured event: `name` plus key=value fields (sanitized)."""
    logger.log(level, name, extra={"lf_event": name, "lf_fields": fields})


@contextmanager
def span(logger: logging.Logger, name: str, level=logging.INFO, /, **fields):
    """Logs `<name>_done` with durationMs (or `<name>_failed` with the error). Yields a dict for extra result fields."""
    extra = {}
    t0 = time.perf_counter()
    try:
        yield extra
    except BaseException as e:
        event(logger, name + "_failed", logging.WARNING, **fields, **extra,
              error="{}: {}".format(type(e).__name__, str(e)[:300]), durationMs=int((time.perf_counter() - t0) * 1000))
        raise
    event(logger, name + "_done", level, **fields, **extra, durationMs=int((time.perf_counter() - t0) * 1000))


def _level_name(record) -> str:
    return "WARN" if record.levelname == "WARNING" else ("ERROR" if record.levelno >= logging.ERROR else record.levelname)


def _entry(record: logging.LogRecord) -> dict:
    name = getattr(record, "lf_event", None)
    fields = dict(getattr(record, "lf_fields", None) or {})
    if name is None:
        name = record.name.replace(".", "_") + "_log"
        fields["msg"] = record.getMessage()
    entry = {"ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec="milliseconds")
             .replace("+00:00", "Z"), "level": _level_name(record).lower(), "event": name, "source": "agent"}
    entry.update({k: _clean(k, v) for k, v in current_for(record).items()})
    for key, value in fields.items():
        if value is None:
            continue
        entry["_" + key if key in ENVELOPE else key] = _clean(key, value)
    entry["logger"] = record.name
    if record.exc_info and record.exc_info[1] is not None:
        entry.setdefault("error", _clean("error", record.exc_info[1]))
        entry["stack"] = _scrub(_cap("".join(traceback.format_exception(*record.exc_info)), 2000))
    return entry


def current_for(record) -> dict:
    return getattr(record, "lf_context", None) or {}


class _ContextFilter(logging.Filter):
    """Captures the context on the logging thread (handlers may run later)."""

    def filter(self, record):
        record.lf_context = current()
        return True


def _fmt(value) -> str:
    if isinstance(value, str):
        return value if value and re.fullmatch(r'[^\s"=]+', value) else json.dumps(value, ensure_ascii=False)
    return json.dumps(value, ensure_ascii=False, default=str)


def _duration(ms) -> str:
    if ms < 1000:
        return "{}ms".format(int(ms))
    return "{:.2f}s".format(ms / 1000) if ms < 60000 else "{}m{}s".format(int(ms // 60000), int(ms % 60000 / 1000))


class ConsoleFormatter(logging.Formatter):
    def __init__(self, color: bool):
        super().__init__()
        self.color = color

    def _paint(self, code, text):
        return "{}{}\x1b[0m".format(code, text) if self.color else text

    def format(self, record):
        e = _entry(record)
        clock = datetime.fromtimestamp(record.created).strftime("%H:%M:%S.%f")[:-3]
        level = _level_name(record)
        parts = [self._paint("\x1b[2m", "[agent]"), self._paint("\x1b[2m", clock),
                 self._paint(COLORS.get(level, ""), level.ljust(5))]
        if e.get("traceId"):
            parts.append(self._paint("\x1b[35m", "trace=" + str(e["traceId"])[:8]))
        if e.get("sessionId"):
            parts.append(self._paint("\x1b[35m", "session=" + str(e["sessionId"])[-10:]))
        parts.append(self._paint("\x1b[1m", e["event"]))
        skip = ENVELOPE | {"traceId", "sessionId", "logger", "stack", "durationMs"}
        for key, value in e.items():
            if key not in skip:
                parts.append("{}{}".format(self._paint("\x1b[90m", key + "="), _fmt(value)))
        if isinstance(e.get("durationMs"), (int, float)):
            parts.append(self._paint("\x1b[32m", "in " + _duration(e["durationMs"])))
        parts.append(self._paint("\x1b[2m", "({})".format(record.name)))
        line = " ".join(parts)
        if e.get("stack"):
            line += "\n" + self._paint("\x1b[2m", e["stack"])
        return line


def default_log_dir() -> Path:
    configured = os.environ.get("LOG_DIR", "").strip()
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parents[1] / "generation-video" / "output" / "logs"


class NdjsonHandler(logging.Handler):
    """Appends one JSON object per record to <dir>/agent-<local date>.ndjson (a new file each day)."""

    def __init__(self, directory: Path, level=logging.DEBUG):
        super().__init__(level)
        self.directory = Path(directory)
        self.lock_ = threading.Lock()

    def emit(self, record):
        try:
            line = json.dumps(_entry(record), ensure_ascii=False, default=str) + "\n"
            path = self.directory / "agent-{}.ndjson".format(datetime.now().strftime("%Y-%m-%d"))
            with self.lock_:
                self.directory.mkdir(parents=True, exist_ok=True)
                with open(path, "a", encoding="utf-8") as f:
                    f.write(line)
        except Exception:  # logging must never break the agent
            pass


def _parse_level(value, default):
    return LEVEL_NAMES.get((value or "").strip().lower(), default)


def setup_logging(level=None, ndjson=True, directory=None):
    """Configures the root logger: console (LOG_LEVEL, default info) + NDJSON file (LOG_FILE_LEVEL, default debug)."""
    console_level = level if level is not None else _parse_level(os.environ.get("LOG_LEVEL"), logging.INFO)
    file_level = _parse_level(os.environ.get("LOG_FILE_LEVEL"), logging.DEBUG)
    root = logging.getLogger()
    for handler in list(root.handlers):
        if getattr(handler, "_longform", False):
            root.removeHandler(handler)
    context = _ContextFilter()
    color_env = os.environ.get("LOG_COLOR", "").strip().lower()
    color = color_env in ("1", "true") or (color_env not in ("0", "false") and not os.environ.get("NO_COLOR")
                                           and (sys.stderr.isatty() or os.environ.get("FORCE_COLOR")))
    console = logging.StreamHandler()
    console.setLevel(console_level)
    console.setFormatter(ConsoleFormatter(bool(color)))
    console.addFilter(context)
    console._longform = True
    root.addHandler(console)
    handlers_min = console_level
    if ndjson:
        file_handler = NdjsonHandler(directory or default_log_dir(), file_level)
        file_handler.addFilter(context)
        file_handler._longform = True
        root.addHandler(file_handler)
        handlers_min = min(console_level, file_level)
    root.setLevel(handlers_min)
    # Chatty libraries stay at warning.
    for noisy in ("httpx", "httpcore", "openai", "urllib3", "langchain", "langsmith"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    return root
