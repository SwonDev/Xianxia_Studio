"""Xianxia Studio — Python sidecar.

Runs FastAPI on 127.0.0.1:8731. Models are loaded lazily on first call
to their respective endpoints. Heavy dependencies (torch, diffusers,
qwen_tts, faster_whisper, etc.) are imported inside the route handlers
so the bare server can boot even before they're installed.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from xianxia_ai.routes import (
    depth,
    health,
    image,
    install,
    music,
    reframe,
    render,
    script,
    shorts,
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
    allow_origins=["http://localhost:1420", "tauri://localhost"],
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
app.include_router(depth.router, prefix="/depth", tags=["depth"])
app.include_router(unload.router, prefix="/unload", tags=["unload"])
app.include_router(reframe.router, prefix="/reframe", tags=["reframe"])


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8731, log_level="info")
