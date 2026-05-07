"""Diagnostics endpoint — gives Claude (or any debugger) a single-call
snapshot of the runtime state so failures can be diagnosed without
manually tailing several log files.

Endpoints:

* `GET  /diag/health`    — quick status, used by /diag clients.
* `POST /diag/snapshot`  — returns the last N JSONL lines from sidecar-py,
                           sidecar-node, comfyui and vram streams,
                           filtered by project_id / since / level.
* `GET  /diag/vram`      — current VRAM snapshot (Comfy /system_stats +
                           Ollama /api/ps + torch.cuda.mem_get_info).
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter()

OLLAMA_URL = os.environ.get("XIANXIA_OLLAMA_URL", "http://127.0.0.1:11434")
COMFY_URL = os.environ.get("XIANXIA_COMFY_URL", "http://127.0.0.1:8188")


def _log_dir() -> Path:
    """Resolve the logs directory the same way logging_utils does."""
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


# ─── /diag/health ───────────────────────────────────────────────────────


@router.get("/health")
def diag_health() -> dict:
    """Returns a small JSON payload describing this sidecar's state and
    where logs live. The Rust supervisor and the Tauri UI use this to
    surface 'logs at <path>' to the user.
    """
    log_dir = _log_dir()
    return {
        "ok": True,
        "log_dir": str(log_dir),
        "jsonl_files": sorted(p.name for p in log_dir.glob("*.jsonl")) if log_dir.exists() else [],
    }


# ─── /diag/vram ─────────────────────────────────────────────────────────


def _ollama_running() -> list[dict]:
    try:
        r = httpx.get(f"{OLLAMA_URL}/api/ps", timeout=2)
        if r.status_code == 200:
            return r.json().get("models", []) or []
    except Exception:
        pass
    return []


def _comfyui_devices() -> list[dict]:
    try:
        r = httpx.get(f"{COMFY_URL}/system_stats", timeout=2)
        if r.status_code == 200:
            return r.json().get("devices", []) or []
    except Exception:
        pass
    return []


def _python_cuda_free() -> Optional[float]:
    try:
        import torch  # type: ignore

        if not torch.cuda.is_available():
            return None
        free, _total = torch.cuda.mem_get_info()
        return free / (1024**3)
    except Exception:
        return None


@router.get("/vram")
def diag_vram() -> dict:
    """Cross-process VRAM snapshot. Combine to spot races between phases."""
    return {
        "ts": time.time(),
        "comfyui": [
            {
                "name": d.get("name"),
                "vram_total_gb": (d.get("vram_total") or 0) / (1024**3),
                "vram_free_gb": (d.get("vram_free") or 0) / (1024**3),
            }
            for d in _comfyui_devices()
        ],
        "ollama_running": [
            {
                "name": m.get("name"),
                "size_vram_gb": (m.get("size_vram") or 0) / (1024**3),
                "expires_at": m.get("expires_at"),
            }
            for m in _ollama_running()
        ],
        "python_cuda_free_gb": _python_cuda_free(),
    }


# ─── /diag/snapshot ─────────────────────────────────────────────────────


class SnapshotRequest(BaseModel):
    project_id: Optional[str] = Field(
        default=None,
        description="Filter lines whose project_id matches.",
    )
    since: Optional[float] = Field(
        default=None,
        description="UNIX timestamp; only lines newer than this are returned.",
    )
    level: Optional[str] = Field(
        default=None,
        description="Minimum level: debug | info | warn | error.",
    )
    max_lines: int = Field(default=2000, ge=10, le=20000)
    sources: Optional[list[str]] = Field(
        default=None,
        description="Subset of: python, node, comfyui, rust, vram. None = all.",
    )


_LEVEL_ORDER = {"debug": 10, "info": 20, "warn": 30, "warning": 30, "error": 40, "fatal": 50, "critical": 50}


def _passes_filter(
    obj: dict,
    project_id: Optional[str],
    since: Optional[float],
    level: Optional[str],
) -> bool:
    if project_id and obj.get("project_id") != project_id:
        return False
    if since:
        ts = obj.get("ts")
        # Accept either ISO strings or unix floats
        if isinstance(ts, (int, float)) and ts < since:
            return False
    if level:
        min_lvl = _LEVEL_ORDER.get(level.lower(), 0)
        line_lvl = _LEVEL_ORDER.get((obj.get("level") or "info").lower(), 20)
        if line_lvl < min_lvl:
            return False
    return True


def _read_tail_jsonl(path: Path, max_lines: int) -> list[dict]:
    """Reads the last `max_lines` JSONL records from `path`. Returns [] if
    the file doesn't exist. Handles incomplete final line.
    """
    if not path.exists():
        return []
    # Read tail efficiently — for files > 50 MB we should stream, but at
    # the volumes Xianxia produces a single read is fine.
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            block = min(size, 1024 * 1024 * 8)  # last 8 MB
            f.seek(size - block)
            data = f.read().decode("utf-8", errors="replace")
    except Exception:
        return []
    out: list[dict] = []
    for line in data.splitlines()[-max_lines:]:
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            # Lines from non-JSONL streams (uvicorn legacy, comfyui stdout)
            # are wrapped so the caller still sees the raw text.
            out.append({"_raw": line, "level": "info", "source": "unknown"})
    return out


@router.post("/snapshot")
def diag_snapshot(req: SnapshotRequest) -> dict:
    """Returns combined tail of logs from the four streams plus a small
    summary so the caller can spot what's wrong at a glance.
    """
    log_dir = _log_dir()
    all_sources = ["python", "node", "comfyui", "rust", "vram"]
    sources = req.sources or all_sources

    file_map = {
        "python": log_dir / "sidecar-py.jsonl",
        "node": log_dir / "sidecar-node.jsonl",
        "comfyui": log_dir / "comfyui.jsonl",
        "rust": log_dir / "pipeline-rust.jsonl",
        "vram": log_dir / "vram.jsonl",
    }
    per_source_lines = max(req.max_lines // max(1, len(sources)), 50)

    combined: list[dict] = []
    by_source: dict[str, int] = {}
    for src in sources:
        path = file_map.get(src)
        if not path:
            continue
        lines = _read_tail_jsonl(path, per_source_lines)
        for line in lines:
            line.setdefault("source", src)
            if _passes_filter(line, req.project_id, req.since, req.level):
                combined.append(line)
        by_source[src] = len(lines)

    # Sort combined by timestamp (string ISO works as well as float)
    def _ts_key(o: dict) -> Any:
        return o.get("ts") or 0

    try:
        combined.sort(key=_ts_key)
    except TypeError:
        # Mixed ts types — leave as-is
        pass

    # Light summary
    summary: dict[str, Any] = {
        "lines_returned": len(combined),
        "by_source": by_source,
        "errors": sum(1 for o in combined if (o.get("level") or "").lower() in ("error", "fatal", "critical")),
        "files": {k: str(v) if v.exists() else None for k, v in file_map.items()},
    }
    # By-phase counter for quick triage of where a run got stuck
    by_phase: dict[str, int] = {}
    for o in combined:
        ph = o.get("phase")
        if ph is not None:
            by_phase[str(ph)] = by_phase.get(str(ph), 0) + 1
    if by_phase:
        summary["by_phase"] = by_phase

    return {"summary": summary, "lines": combined}


# ─── /diag/list ─────────────────────────────────────────────────────────


@router.get("/list")
def diag_list() -> dict:
    """Lists log files with sizes so the UI can show 'logs occupying X MB'."""
    log_dir = _log_dir()
    if not log_dir.exists():
        return {"log_dir": str(log_dir), "files": []}
    files = []
    for p in sorted(log_dir.glob("*")):
        try:
            stat = p.stat()
            files.append({
                "name": p.name,
                "size_bytes": stat.st_size,
                "modified": stat.st_mtime,
            })
        except OSError:
            continue
    total_bytes = sum(f["size_bytes"] for f in files)
    return {
        "log_dir": str(log_dir),
        "total_bytes": total_bytes,
        "total_mb": round(total_bytes / (1024 * 1024), 2),
        "files": files,
    }
