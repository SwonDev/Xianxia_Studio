"""Xianxia Studio — Python sidecar.

Runs FastAPI on 127.0.0.1:8731. Models are loaded lazily on first call
to their respective endpoints. Heavy dependencies (torch, diffusers,
qwen_tts, faster_whisper, etc.) are imported inside the route handlers
so the bare server can boot even before they're installed.
"""

from __future__ import annotations

import logging
import os
import sys
from contextlib import asynccontextmanager

# ─── Augment PATH so ffmpeg/ffprobe are reachable by subprocess.run ─────
# Tauri spawns the sidecar with a minimal PATH that may NOT include the
# user's ffmpeg install (e.g. WinGet `~/AppData/Local/Microsoft/WinGet/
# Links/`). Without this, every call to `subprocess.run(["ffmpeg", ...])`
# in the route handlers crashes with FileNotFoundError [WinError 2].
#
# Resolution order, prepended (highest priority first):
#   1. <embedded-python>/  — where the supervisor extract step copies a
#      portable ffmpeg/ffprobe pair as last-resort.
#   2. <data_dir>/runtime/ffmpeg/bin  — installer-managed install.
#   3. <data_dir>/runtime/sidecar-node/node_modules/.bin  — copied by
#      the prepare step so HyperFrames CLI also finds them.
#   4. Common system locations (WinGet Links, Program Files).
def _augment_path_for_ffmpeg() -> None:
    candidates: list[str] = []
    emb_dir = os.path.dirname(sys.executable)
    candidates.append(emb_dir)
    appdata = os.environ.get("APPDATA")
    if appdata:
        runtime = os.path.join(appdata, "xianxia", "XianxiaStudio", "data", "runtime")
        candidates.append(os.path.join(runtime, "ffmpeg", "bin"))
        candidates.append(os.path.join(runtime, "sidecar-node", "node_modules", ".bin"))
    local_appdata = os.environ.get("LOCALAPPDATA")
    if local_appdata:
        candidates.append(os.path.join(local_appdata, "Microsoft", "WinGet", "Links"))
    candidates.append(r"C:\\Program Files\\ffmpeg\\bin")
    existing = os.environ.get("PATH", "")
    extra = os.pathsep.join(c for c in candidates if c and os.path.isdir(c))
    if extra:
        os.environ["PATH"] = extra + os.pathsep + existing

_augment_path_for_ffmpeg()

# Initialize JSONL structured logging BEFORE importing any route handlers
# so all subsequent log calls (including imports' module-level logging) go
# through the JSONL formatter. Idempotent.
from xianxia_ai.logging_utils import (  # noqa: E402
    log_event,
    new_request_id,
    set_phase,
    set_project_id,
    set_request_id,
    setup_logging,
)

_JSONL_PATH = setup_logging()

import time as _time  # noqa: E402

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from starlette.middleware.base import BaseHTTPMiddleware  # noqa: E402

from xianxia_ai.routes import (  # noqa: E402
    depth,
    diag,
    engagement,
    export,
    health,
    image,
    install,
    music,
    reframe,
    render,
    script,
    shorts,
    shorts_auto,
    subtitles,
    transcribe,
    tts,
    unload,
)

log = logging.getLogger("xianxia.sidecar")


@asynccontextmanager
async def lifespan(app: FastAPI):
    log_event("info", "sidecar_python_boot", port=8731, jsonl_path=str(_JSONL_PATH))
    yield
    log_event("info", "sidecar_python_shutdown")


app = FastAPI(
    title="Xianxia Studio Sidecar",
    version="0.1.0",
    lifespan=lifespan,
)


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Assigns a per-request request_id, captures duration, sets the
    project_id/phase from request headers if present, and emits one
    JSONL `http_request` event per finished request.

    The Rust pipeline supervisor will be modified in a follow-up step to
    propagate `X-Xianxia-Request-Id`, `X-Xianxia-Project-Id` and
    `X-Xianxia-Phase` headers so cross-source correlation works without
    body parsing.
    """

    async def dispatch(self, request: Request, call_next):
        # Skip noisy /health polling — we emit a single boot event for those
        is_health = request.url.path == "/health"
        rid = request.headers.get("x-xianxia-request-id") or new_request_id()
        pid = request.headers.get("x-xianxia-project-id")
        ph_raw = request.headers.get("x-xianxia-phase")
        try:
            ph = int(ph_raw) if ph_raw else None
        except ValueError:
            ph = None

        rid_token = set_request_id(rid)
        pid_token = set_project_id(pid)
        ph_token = set_phase(ph)
        start = _time.monotonic()
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            response.headers["x-xianxia-request-id"] = rid
            return response
        except Exception as exc:  # pragma: no cover (re-raised to FastAPI)
            log_event(
                "error",
                "http_handler_unhandled",
                method=request.method,
                path=request.url.path,
                error_type=type(exc).__name__,
                error=str(exc),
            )
            raise
        finally:
            duration_ms = int((_time.monotonic() - start) * 1000)
            if not is_health or status_code >= 400:
                log_event(
                    "info" if status_code < 400 else "error",
                    "http_request",
                    method=request.method,
                    path=request.url.path,
                    status=status_code,
                    duration_ms=duration_ms,
                    client_port=request.client.port if request.client else None,
                )
            try:
                set_request_id(None)
                set_project_id(None)
                set_phase(None)
            except Exception:
                pass


app.add_middleware(RequestContextMiddleware)

app.add_middleware(
    CORSMiddleware,
    # Origins covered:
    #   localhost:1420       — Vite dev server
    #   tauri://localhost    — Tauri 1 / macOS / Linux webview origin
    #   http(s)://tauri.localhost — Tauri 2 Windows webview origin (WebView2)
    #   http://asset.localhost — convertFileSrc URLs from the asset protocol
    allow_origin_regex=r"^(http://localhost:1420|tauri://localhost|https?://tauri\.localhost|http://asset\.localhost)$",
    allow_methods=["*"],
    allow_headers=["*", "x-xianxia-request-id", "x-xianxia-project-id", "x-xianxia-phase"],
    expose_headers=["x-xianxia-request-id"],
)

app.include_router(health.router)
app.include_router(diag.router, prefix="/diag", tags=["diag"])
app.include_router(install.router, prefix="/install", tags=["install"])
app.include_router(script.router, prefix="/script", tags=["script"])
app.include_router(tts.router, prefix="/tts", tags=["tts"])
app.include_router(image.router, prefix="/image", tags=["image"])
app.include_router(music.router, prefix="/music", tags=["music"])
app.include_router(transcribe.router, prefix="/transcribe", tags=["transcribe"])
app.include_router(subtitles.router, prefix="/subtitles", tags=["subtitles"])
app.include_router(render.router, prefix="/render", tags=["render"])
app.include_router(shorts.router, prefix="/shorts", tags=["shorts"])
app.include_router(shorts_auto.router, prefix="/shorts", tags=["shorts"])
app.include_router(depth.router, prefix="/depth", tags=["depth"])
app.include_router(unload.router, prefix="/unload", tags=["unload"])
app.include_router(reframe.router, prefix="/reframe", tags=["reframe"])
app.include_router(export.router, prefix="/export", tags=["export"])
app.include_router(engagement.router, prefix="/engagement", tags=["engagement"])


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8731, log_level="info")
