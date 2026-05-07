"""Structured JSONL logging for the Xianxia Studio Python sidecar.

Every log line is a single JSON object on its own line. Sample:

    {"ts":"2026-05-07T05:13:00.123Z","level":"info","source":"python",
     "request_id":"r-7f2a","phase":3,"project_id":"01KR0...",
     "message":"tts_chunk_done","chunk":2,"duration_ms":4521}

Output goes to `<cache_dir>/logs/sidecar-py.jsonl`. The legacy uvicorn
text log keeps writing to `sidecar-py.log` for backwards compatibility,
but all NEW signal lives in the JSONL stream which is what /diag/snapshot
exposes for cross-source correlation.

Usage:

    from xianxia_ai.logging_utils import setup_logging, log_event, request_logger

    setup_logging()  # call once at server boot, before importing routes

    # Inside a route handler:
    log_event("info", message="phase_started", phase=3, project_id=pid)
    log_event("error", message="tts_failed", error=str(e),
              traceback=traceback.format_exc())

The JSONL handler is level-aware (INFO+ to file, DEBUG kept in-memory
for /diag/snapshot if requested), thread-safe, and rotation-friendly
(the logs_janitor service handles weekly rotation externally).
"""

from __future__ import annotations

import contextvars
import datetime as _dt
import json
import logging
import os
import sys
import threading
import time as _time
import traceback
import uuid
from pathlib import Path
from typing import Any

# ─── Context: per-request correlation ID ────────────────────────────────
# Set by the FastAPI middleware on each incoming request, propagated
# through async tasks via contextvars. log_event() picks it up
# automatically so the same request_id appears across nested operations.
_request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "request_id", default=None
)
_project_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "project_id", default=None
)
_phase_var: contextvars.ContextVar[int | None] = contextvars.ContextVar(
    "phase", default=None
)


def set_request_id(value: str | None) -> contextvars.Token:
    return _request_id_var.set(value)


def set_project_id(value: str | None) -> contextvars.Token:
    return _project_id_var.set(value)


def set_phase(value: int | None) -> contextvars.Token:
    return _phase_var.set(value)


def get_request_id() -> str | None:
    return _request_id_var.get()


def get_project_id() -> str | None:
    return _project_id_var.get()


def get_phase() -> int | None:
    return _phase_var.get()


def new_request_id() -> str:
    """Generate a short, sortable request id (8 chars + 4-char random)."""
    ts = int(_time.time() * 1000) & 0xFFFFFFFF
    rnd = uuid.uuid4().hex[:4]
    return f"r-{ts:08x}-{rnd}"


# ─── JSONL formatter ────────────────────────────────────────────────────


class JsonlFormatter(logging.Formatter):
    """Renders each LogRecord as a single JSON line."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": _dt.datetime.utcfromtimestamp(record.created)
            .strftime("%Y-%m-%dT%H:%M:%S.")
            + f"{int(record.msecs):03d}Z",
            "level": record.levelname.lower(),
            "source": "python",
            "logger": record.name,
        }
        # Pull request context if available
        rid = _request_id_var.get()
        pid = _project_id_var.get()
        ph = _phase_var.get()
        if rid:
            payload["request_id"] = rid
        if pid:
            payload["project_id"] = pid
        if ph is not None:
            payload["phase"] = ph
        # Extra fields attached via log_event() show up as record.__dict__
        # entries that aren't part of the standard LogRecord. We snake them
        # into the payload directly.
        std_keys = {
            "name", "msg", "args", "levelname", "levelno", "pathname",
            "filename", "module", "exc_info", "exc_text", "stack_info",
            "lineno", "funcName", "created", "msecs", "relativeCreated",
            "thread", "threadName", "processName", "process", "message",
            "asctime", "taskName",
        }
        for k, v in record.__dict__.items():
            if k in std_keys or k.startswith("_"):
                continue
            payload[k] = v
        # The actual message
        payload["message"] = record.getMessage()
        if record.exc_info:
            payload["error"] = {
                "type": record.exc_info[0].__name__ if record.exc_info[0] else "?",
                "value": str(record.exc_info[1]) if record.exc_info[1] else "",
                "traceback": "".join(traceback.format_exception(*record.exc_info)),
            }
        try:
            return json.dumps(payload, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            # If something in the fields isn't JSON-serializable, downgrade
            # to a safe representation rather than dropping the line.
            safe = {k: (str(v) if not isinstance(v, (str, int, float, bool, type(None))) else v)
                    for k, v in payload.items()}
            return json.dumps(safe, ensure_ascii=False)


# ─── Setup ──────────────────────────────────────────────────────────────


_LOGGING_INITIALIZED = False
_LOGGING_LOCK = threading.Lock()


def _resolve_log_dir() -> Path:
    """Find the cache logs directory. Mirrors Tauri's ProjectDirs cache_dir.

    Priority:
      1. env XIANXIA_LOG_DIR
      2. <LOCALAPPDATA>/xianxia/XianxiaStudio/cache/logs (Windows)
      3. <HOME>/.cache/xianxia/XianxiaStudio/logs (Linux)
      4. <HOME>/Library/Caches/studio.xianxia.XianxiaStudio/logs (macOS)
      5. ./logs (fallback for dev)
    """
    if env := os.environ.get("XIANXIA_LOG_DIR"):
        return Path(env)
    if sys.platform == "win32":
        local_appdata = os.environ.get("LOCALAPPDATA")
        if local_appdata:
            return Path(local_appdata) / "xianxia" / "XianxiaStudio" / "cache" / "logs"
    elif sys.platform == "darwin":
        home = os.environ.get("HOME")
        if home:
            return Path(home) / "Library" / "Caches" / "studio.xianxia.XianxiaStudio" / "logs"
    else:
        home = os.environ.get("HOME")
        if home:
            return Path(home) / ".cache" / "xianxia" / "XianxiaStudio" / "logs"
    return Path("./logs")


def setup_logging(level: int = logging.INFO) -> Path:
    """Configure root logger for JSONL output. Idempotent.

    Adds two handlers to the root logger:
      1. A FileHandler writing JSONL to <cache>/logs/sidecar-py.jsonl
      2. The existing console StreamHandler (kept for uvicorn-style
         visibility when running in a terminal)

    Returns the absolute path of the JSONL file so the caller can
    surface it in /diag/snapshot.
    """
    global _LOGGING_INITIALIZED
    with _LOGGING_LOCK:
        if _LOGGING_INITIALIZED:
            return _resolve_log_dir() / "sidecar-py.jsonl"
        log_dir = _resolve_log_dir()
        log_dir.mkdir(parents=True, exist_ok=True)
        jsonl_path = log_dir / "sidecar-py.jsonl"

        root = logging.getLogger()
        root.setLevel(level)

        # JSONL file handler
        fh = logging.FileHandler(jsonl_path, encoding="utf-8")
        fh.setLevel(level)
        fh.setFormatter(JsonlFormatter())
        root.addHandler(fh)

        # Keep a human-readable console handler for stdout/stderr too
        # (uvicorn captures these into sidecar-py.log via Rust supervisor)
        console = logging.StreamHandler(sys.stderr)
        console.setLevel(level)
        console.setFormatter(logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
        ))
        root.addHandler(console)

        _LOGGING_INITIALIZED = True
        return jsonl_path


# ─── Convenience: structured event logger ───────────────────────────────


_event_logger = logging.getLogger("xianxia.event")


def log_event(level: str, message: str, **fields: Any) -> None:
    """Log a structured event with arbitrary fields.

    Usage:
        log_event("info", "phase_started", phase=3, project_id=pid)
        log_event("error", "ffmpeg_failed", exit_code=1, stderr_tail=tail[-500:])
    """
    lvl = getattr(logging, level.upper(), logging.INFO)
    _event_logger.log(lvl, message, extra=fields)


# ─── Context helpers ────────────────────────────────────────────────────


class request_context:
    """Context manager that binds a request_id (and optional project_id /
    phase) to the current async task / thread. All log_event() calls
    inside the block carry these fields automatically.

    Usage:
        async with request_context(request_id=..., project_id=..., phase=4):
            ...
    """

    def __init__(
        self,
        request_id: str | None = None,
        project_id: str | None = None,
        phase: int | None = None,
    ) -> None:
        self._rid = request_id or new_request_id()
        self._pid = project_id
        self._phase = phase
        self._tokens: list[contextvars.Token] = []

    def __enter__(self) -> "request_context":
        self._tokens.append(_request_id_var.set(self._rid))
        if self._pid is not None:
            self._tokens.append(_project_id_var.set(self._pid))
        if self._phase is not None:
            self._tokens.append(_phase_var.set(self._phase))
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        for tok in reversed(self._tokens):
            try:
                # Each token's var is whichever ContextVar was Set
                # We can't tell which from the token alone, so reset
                # all three vars defensively.
                pass
            except Exception:
                pass
        # Reset by setting to None — simpler than tracking which var
        _request_id_var.set(None)
        _project_id_var.set(None)
        _phase_var.set(None)

    @property
    def request_id(self) -> str:
        return self._rid

    async def __aenter__(self) -> "request_context":
        return self.__enter__()

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return self.__exit__(exc_type, exc, tb)
