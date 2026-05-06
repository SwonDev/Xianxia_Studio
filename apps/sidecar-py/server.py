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

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from xianxia_ai.routes import (
    depth,
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

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
log = logging.getLogger("xianxia.sidecar")


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Xianxia Python sidecar starting on :8731")
    yield
    log.info("Xianxia Python sidecar shutting down")


app = FastAPI(
    title="Xianxia Studio Sidecar",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    # Origins covered:
    #   localhost:1420       — Vite dev server
    #   tauri://localhost    — Tauri 1 / macOS / Linux webview origin
    #   http(s)://tauri.localhost — Tauri 2 Windows webview origin (WebView2)
    #   http://asset.localhost — convertFileSrc URLs from the asset protocol
    allow_origin_regex=r"^(http://localhost:1420|tauri://localhost|https?://tauri\.localhost|http://asset\.localhost)$",
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
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
