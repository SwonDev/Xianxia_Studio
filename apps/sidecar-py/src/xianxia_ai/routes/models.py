"""LLM model management endpoints.

Mounted under /models — the Settings UI (T5) consumes these to let the user:

  * GET  /models/local          → list every GGUF on disk
  * POST /models/inspect        → dump GGUF metadata for a single file
  * POST /models/recommend      → compute auto-config (llmfit-style)
  * GET  /models/search?q=…     → search HuggingFace for GGUF repos
  * POST /models/download       → fetch a HF repo (file or snapshot)
  * POST /models/activate       → write `<data_dir>/models/active.json`
                                   so the Rust supervisor (T3) picks the
                                   selected GGUF on its next spawn cycle.
  * GET  /models/active         → read the current active config

Storage layout under `<data_dir>/models/`:
  active.json                   ← T3 reads this on every supervised spawn
  <repo_id_safe>/               ← one directory per HF repo
    *.gguf
    config.json                 ← per-model recommendation, written when
                                   the user activates the model
    README.md                   ← copy of HF model card for offline display
"""

from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..gguf_meta import GgufMeta, quantization_from_filename, read_gguf_meta
from ..llm_recommender import (
    HardwareSnapshot,
    LlmRecommendation,
    detect_hardware_locally,
    recommend,
)

router = APIRouter()

# Same path resolution the Rust supervisor uses. Keeping this in sync is
# the only T3↔T4 coupling; the parity-check (T7) asserts both reference
# `data_dir/models/active.json`.
def _data_dir() -> Path:
    if env := os.environ.get("XIANXIA_DATA_DIR"):
        return Path(env)
    if appdata := os.environ.get("APPDATA"):
        return Path(appdata) / "xianxia" / "XianxiaStudio" / "data"
    return Path.home() / ".local" / "share" / "xianxia" / "XianxiaStudio" / "data"


def _models_dir() -> Path:
    p = _data_dir() / "models"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _active_config_path() -> Path:
    return _models_dir() / "active.json"


def _legacy_gguf_roots() -> list[Path]:
    """Directories where v0.1.x deposited LLM-compatible GGUFs. Surfaced
    in /models/local so the migration to v0.2.0 is bytewise seamless —
    no re-downloads of multi-GB weights.

    NOTE: GGUFs under `<data_dir>/runtime/comfyui/models/{diffusion_models,
    text_encoders}/` are SD weights (Z-Image, Qwen3-4B text encoder) and
    MUST NOT be surfaced as LLM candidates. The `_is_llm_gguf` filter
    enforces this.
    """
    d = _data_dir()
    return [
        d / "hf-cache" / "models" / "llm",  # v0.1.x install.py target
        d / "hf-cache" / "hub",              # HF snapshot cache (legacy)
    ]


def _is_llm_gguf(path: Path) -> bool:
    """Reject GGUFs that are clearly NOT LLM weights.

    The wizard also downloads GGUFs for ComfyUI (Z-Image diffusion + Qwen3
    text encoder for prompt embedding). Those live under runtime/comfyui/
    and would crash llama-server if passed as `--model`. We exclude them
    by path inspection — fast and reliable.
    """
    parts = [p.lower() for p in path.parts]
    blocked = (
        "comfyui",
        "diffusion_models",
        "text_encoders",
        "vae",
        "clip",
        "clip_vision",
        "controlnet",
        "loras",
        "upscale_models",
    )
    return not any(b in parts for b in blocked)


def _safe_repo_id(repo_id: str) -> str:
    """Convert a HuggingFace repo id ("Author/Repo Name") into a safe
    directory name. The same algorithm runs on the Rust side so model
    paths are consistent across both layers.
    """
    return re.sub(r"[^A-Za-z0-9._-]+", "_", repo_id)


# ─── /models/local ──────────────────────────────────────────────────


class LocalModel(BaseModel):
    path: str
    filename: str
    size_bytes: int
    repo_id: str | None = None
    architecture: str | None = None
    quantization: str | None = None
    context_length: int | None = None


@router.get("/local")
def list_local_models() -> dict[str, list[LocalModel]]:
    """Return every GGUF under `<data_dir>/models/` AND `<data_dir>/hf-cache/hub`.

    The HF cache hits are tagged with `repo_id` derived from the legacy
    layout `models--<owner>--<name>/snapshots/<sha>/<file>.gguf`. T4's
    download flow writes new GGUFs straight under `models/<safe_repo_id>/`
    so future downloads don't depend on that brittle path scheme.
    """
    out: list[LocalModel] = []
    seen: set[str] = set()

    def emit(path: Path, repo_id: str | None) -> None:
        key = str(path.resolve()).lower()
        if key in seen:
            return
        seen.add(key)
        if not _is_llm_gguf(path):
            return  # ComfyUI / diffusion / text encoder GGUFs are not LLMs
        try:
            size = path.stat().st_size
        except OSError:
            return
        if size < 1_000_000:  # skip stub files
            return
        # Try to read metadata; skip with best-effort fallback on failure.
        arch: str | None = None
        ctx: int | None = None
        try:
            m = read_gguf_meta(path, max_string_bytes=64_000)
            arch = m.architecture
            ctx = m.context_length
        except Exception:
            pass
        out.append(LocalModel(
            path=str(path),
            filename=path.name,
            size_bytes=size,
            repo_id=repo_id,
            architecture=arch,
            quantization=quantization_from_filename(path),
            context_length=ctx,
        ))

    # Layer 1: <data_dir>/models/**/*.gguf (T4 download target).
    for sub in _models_dir().rglob("*.gguf"):
        repo = sub.parent.name if sub.parent != _models_dir() else None
        emit(sub, repo)

    # Layer 2: legacy v0.1.x roots. Two layouts coexist:
    #   a) <data_dir>/hf-cache/models/llm/<file>.gguf  — wizard target
    #   b) <data_dir>/hf-cache/hub/models--<owner>--<name>/snapshots/<sha>/*.gguf
    #      — huggingface_hub native cache (Whisper + Z-Image live here too,
    #      but `_is_llm_gguf` filters them out by path).
    for root in _legacy_gguf_roots():
        if not root.is_dir():
            continue
        for gguf in root.rglob("*.gguf"):
            # Best-effort repo id extraction from the HF cache layout.
            owner_name: str | None = None
            for ancestor in gguf.parents:
                if ancestor.name.startswith("models--"):
                    owner_name = ancestor.name.removeprefix("models--").replace("--", "/", 1)
                    break
            emit(gguf, owner_name)

    out.sort(key=lambda m: m.size_bytes, reverse=True)
    return {"models": [m.model_dump() for m in out]}


# ─── /models/inspect ────────────────────────────────────────────────


class InspectRequest(BaseModel):
    path: str


@router.post("/inspect")
def inspect_model(req: InspectRequest) -> dict[str, Any]:
    p = Path(req.path)
    if not p.is_file():
        raise HTTPException(404, f"GGUF not found: {req.path}")
    try:
        meta = read_gguf_meta(p, max_string_bytes=1_000_000)
    except Exception as exc:
        raise HTTPException(400, f"failed to read GGUF: {exc}") from exc
    # Surface a flat summary plus the raw KV (capped to keep the response
    # bounded — full KV with tokenizer.ggml.tokens would be huge).
    bounded_kv: dict[str, Any] = {}
    for k, v in meta.kv.items():
        if isinstance(v, list) and len(v) > 32:
            bounded_kv[k] = v[:32] + [f"<{len(v) - 32} more truncated>"]
        else:
            bounded_kv[k] = v
    return {
        "path": meta.path,
        "version": meta.version,
        "tensor_count": meta.tensor_count,
        "architecture": meta.architecture,
        "name": meta.name,
        "context_length": meta.context_length,
        "embedding_length": meta.embedding_length,
        "block_count": meta.block_count,
        "head_count": meta.head_count,
        "chat_template_present": bool(meta.chat_template),
        "chat_template_preview": (meta.chat_template or "")[:600],
        "eos_token_id": meta.eos_token_id,
        "bos_token_id": meta.bos_token_id,
        "quantization": quantization_from_filename(p),
        "kv": bounded_kv,
    }


# ─── /models/recommend ──────────────────────────────────────────────


class RecommendRequest(BaseModel):
    path: str
    # Optional hardware override. When absent, the recommender probes the
    # local Rust supervisor (/install/hardware) for accurate numbers.
    vram_gb: float | None = None
    ram_gb: float | None = None
    cpu_cores: int | None = None
    gpu_vendor: str | None = None


@router.post("/recommend")
async def recommend_for_model(req: RecommendRequest) -> dict[str, Any]:
    p = Path(req.path)
    if not p.is_file():
        raise HTTPException(404, f"GGUF not found: {req.path}")
    meta = read_gguf_meta(p, max_string_bytes=1_000_000)
    hw = await _resolve_hardware(req)
    rec: LlmRecommendation = recommend(
        gguf_path=p,
        meta=meta,
        hardware=hw,
        file_size_bytes=p.stat().st_size,
    )
    return {
        "gpu_layers": rec.gpu_layers,
        "context_size": rec.context_size,
        "flash_attention": rec.flash_attention,
        "chat_template": rec.chat_template,
        "threads": rec.threads,
        "batch_size": rec.batch_size,
        "ubatch_size": rec.ubatch_size,
        "parallel": rec.parallel,
        "sampling": rec.sampling,
        "rationale": rec.rationale,
        "hardware": {
            "vram_gb": hw.vram_gb,
            "ram_gb": hw.ram_gb,
            "cpu_cores": hw.cpu_cores,
            "gpu_vendor": hw.gpu_vendor,
        },
        "metadata": {
            "architecture": meta.architecture,
            "context_length": meta.context_length,
            "block_count": meta.block_count,
            "embedded_chat_template": bool(meta.chat_template),
        },
    }


async def _resolve_hardware(req: RecommendRequest) -> HardwareSnapshot:
    # Caller-supplied overrides win.
    if req.vram_gb is not None or req.ram_gb is not None or req.cpu_cores is not None:
        return HardwareSnapshot(
            vram_gb=req.vram_gb or 0.0,
            ram_gb=req.ram_gb or 0.0,
            cpu_cores=req.cpu_cores or 0,
            gpu_vendor=req.gpu_vendor or "",
        )
    # Try the local /install/hardware endpoint — same host, instant call.
    # IMPORTANT: this endpoint emits CPU + RAM as FLAT fields on the root
    # object (cpu_cores, cpu_logical_cores, total_ram_gb) and ONLY `gpu` as
    # a nested object. Parsing them as nested-dicts silently returns zeros.
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            r = await client.get("http://127.0.0.1:8731/install/hardware")
            if r.status_code == 200:
                data = r.json()
                gpu = data.get("gpu") or {}
                return HardwareSnapshot(
                    vram_gb=float(gpu.get("vram_gb") or 0.0),
                    ram_gb=float(data.get("total_ram_gb") or 0.0),
                    cpu_cores=int(data.get("cpu_cores") or data.get("cpu_logical_cores") or 0),
                    gpu_vendor=str(gpu.get("vendor") or ""),
                )
    except Exception:
        pass
    # Last resort: local psutil + torch probe.
    return detect_hardware_locally()


# ─── /models/search (HuggingFace) ───────────────────────────────────


@router.get("/search")
async def search_hf_models(q: str = "", limit: int = 30) -> dict[str, Any]:
    """Search HuggingFace for GGUF-containing repos matching `q`.

    Uses the public /api/models endpoint with the `filter=gguf` tag so
    the results are pre-filtered to llama.cpp-compatible repos. No auth
    token required — the responses are public.
    """
    params: dict[str, Any] = {
        "filter": "gguf",
        "sort": "downloads",
        "direction": -1,
        "limit": max(1, min(int(limit), 100)),
    }
    if q.strip():
        params["search"] = q.strip()
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get("https://huggingface.co/api/models", params=params)
            if r.status_code != 200:
                raise HTTPException(502, f"HuggingFace API: {r.status_code}")
            data = r.json()
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"HuggingFace unreachable: {exc}") from exc

    items = []
    for it in data:
        repo_id = it.get("id") or it.get("modelId")
        if not repo_id:
            continue
        items.append({
            "repo_id": repo_id,
            "downloads": it.get("downloads", 0),
            "likes": it.get("likes", 0),
            "tags": it.get("tags", []),
            "library_name": it.get("library_name"),
            "pipeline_tag": it.get("pipeline_tag"),
            "last_modified": it.get("lastModified"),
        })
    return {"query": q, "results": items}


# ─── /models/files (list GGUF files inside a HF repo) ───────────────


@router.get("/files")
async def list_repo_files(repo_id: str) -> dict[str, Any]:
    """For a given HF repo id, list its GGUF files with REAL sizes.

    Implementation note (verified against HF API on 2026-05-13):
      * `/api/models/{repo}` returns a `siblings` array but its entries
        only have `rfilename` — `size` is `None` for every LFS file.
        This is why the older code showed "Tamaño desconocido" everywhere.
      * `/api/models/{repo}/tree/main` IS the right endpoint. Each entry
        has `path`, `size`, `lfs.size` (always equal for LFS-tracked files),
        plus `oid` and `type`. GGUFs are LFS by convention.
      * Gated/private repos return `{"error": "Invalid username or password."}`
        without auth — we surface that as an empty file list rather than
        crashing, so the UI shows "no files" cleanly.
    """
    files: list[dict[str, Any]] = []
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(
                f"https://huggingface.co/api/models/{repo_id}/tree/main",
                headers={"Accept": "application/json"},
            )
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"HuggingFace unreachable: {exc}") from exc

    if isinstance(data, dict) and data.get("error"):
        # Gated repo without auth, or 404 — return empty list with the
        # error message so the UI can render a helpful hint.
        return {"repo_id": repo_id, "files": [], "error": str(data["error"])}

    if not isinstance(data, list):
        return {"repo_id": repo_id, "files": [], "error": "unexpected API response"}

    for entry in data:
        if not isinstance(entry, dict):
            continue
        path = entry.get("path") or ""
        if not path.endswith(".gguf"):
            continue
        # `size` is the canonical field for both LFS and regular files.
        # `lfs.size` is also populated for LFS entries and matches `size`
        # — we prefer the top-level `size` for simplicity.
        size = entry.get("size")
        if size is None and isinstance(entry.get("lfs"), dict):
            size = entry["lfs"].get("size")
        files.append({
            "filename": path,
            "size_bytes": int(size) if isinstance(size, (int, float)) else None,
            "quantization": quantization_from_filename(path),
        })
    files.sort(key=lambda f: (f["size_bytes"] or 0))
    return {"repo_id": repo_id, "files": files}


# ─── /models/download ───────────────────────────────────────────────


class DownloadRequest(BaseModel):
    repo_id: str = Field(..., description="HuggingFace repo, e.g. 'mradermacher/supergemma4-…-GGUF'")
    filename: str = Field(..., description="GGUF filename inside the repo")
    revision: str = "main"


@router.post("/download")
def download_model(req: DownloadRequest) -> dict[str, Any]:
    """Download a single GGUF file from a HuggingFace repo into
    `<data_dir>/models/<safe_repo_id>/`. Uses `huggingface_hub.hf_hub_download`
    so resumable + parallel byte ranges + the user's HF_HOME cache are honoured.

    Idempotent: re-downloading an existing file is a no-op (hash compare
    inside huggingface_hub).
    """
    safe = _safe_repo_id(req.repo_id)
    target_dir = _models_dir() / safe
    target_dir.mkdir(parents=True, exist_ok=True)
    try:
        from huggingface_hub import hf_hub_download  # type: ignore
    except ImportError as exc:  # pragma: no cover
        raise HTTPException(500, "huggingface_hub not installed in sidecar") from exc
    try:
        cached = hf_hub_download(
            repo_id=req.repo_id,
            filename=req.filename,
            revision=req.revision,
            cache_dir=str(_hf_cache_root().parent),  # HF expects parent of "hub/"
            local_dir=str(target_dir),  # also materialise under models/<safe>/
            local_dir_use_symlinks=False,
        )
    except Exception as exc:
        raise HTTPException(502, f"download failed: {exc}") from exc

    # The HF README often has the recommended sampling params. Snag it
    # for offline display next to the model.
    try:
        from huggingface_hub import hf_hub_download as _dl  # type: ignore
        readme = _dl(
            repo_id=req.repo_id,
            filename="README.md",
            revision=req.revision,
            local_dir=str(target_dir),
            local_dir_use_symlinks=False,
        )
    except Exception:
        readme = None

    return {
        "ok": True,
        "path": str(Path(cached)),
        "repo_id": req.repo_id,
        "filename": req.filename,
        "size_bytes": Path(cached).stat().st_size,
        "readme_path": readme,
    }


# ─── /models/activate ───────────────────────────────────────────────


class ActivateRequest(BaseModel):
    path: str = Field(..., description="Absolute path to the GGUF to activate")
    # Optional explicit overrides for advanced users. None ⇒ use recommend()
    gpu_layers: int | None = None
    context_size: int | None = None
    flash_attention: bool | None = None
    chat_template: str | None = None
    threads: int | None = None
    batch_size: int | None = None
    ubatch_size: int | None = None
    parallel: int | None = None
    extra_args: list[str] | None = None


@router.post("/activate")
async def activate_model(req: ActivateRequest) -> dict[str, Any]:
    """Compute the recommendation (or honour the explicit overrides) and
    persist it to `<data_dir>/models/active.json`. The Rust supervisor
    picks the new config on its next spawn cycle (within ~3 s).
    """
    p = Path(req.path)
    if not p.is_file():
        raise HTTPException(404, f"GGUF not found: {req.path}")
    meta = read_gguf_meta(p, max_string_bytes=1_000_000)
    hw = await _resolve_hardware(RecommendRequest(path=req.path))
    rec = recommend(
        gguf_path=p,
        meta=meta,
        hardware=hw,
        file_size_bytes=p.stat().st_size,
    )

    cfg = {
        "gguf_path": str(p),
        "context_size": req.context_size or rec.context_size,
        "gpu_layers": req.gpu_layers if req.gpu_layers is not None else rec.gpu_layers,
        "flash_attention": req.flash_attention if req.flash_attention is not None else rec.flash_attention,
        "chat_template": req.chat_template if req.chat_template is not None else rec.chat_template,
        "threads": req.threads if req.threads is not None else rec.threads,
        "batch_size": req.batch_size if req.batch_size is not None else rec.batch_size,
        "ubatch_size": req.ubatch_size if req.ubatch_size is not None else rec.ubatch_size,
        "parallel": req.parallel if req.parallel is not None else rec.parallel,
        "extra_args": req.extra_args or [],
        "model_id": p.stem,
        "architecture": meta.architecture,
        "quantization": quantization_from_filename(p),
    }

    out = _active_config_path()
    tmp = out.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    tmp.replace(out)
    # Also drop a sibling config.json next to the GGUF (per-model snapshot)
    # so the UI can show "last recommendation" history per model.
    try:
        sibling = p.with_suffix(".config.json")
        sibling.write_text(
            json.dumps({**cfg, "rationale": rec.rationale, "sampling": rec.sampling}, indent=2),
            encoding="utf-8",
        )
    except OSError:
        pass

    # Tell the LLM backend abstraction to reset its singleton so the next
    # request picks up the new model. The reset is a no-op when the
    # backend is Ollama (the model name is the discriminator there, not
    # the underlying GGUF path).
    try:
        from ..llm_backend import reset_backend
        reset_backend()
    except Exception:
        pass

    return {"ok": True, "active_config_path": str(out), "config": cfg}


# ─── /models/active ─────────────────────────────────────────────────


@router.get("/active")
def get_active() -> dict[str, Any]:
    p = _active_config_path()
    if not p.is_file():
        return {"active": None}
    try:
        return {"active": json.loads(p.read_text(encoding="utf-8"))}
    except Exception as exc:
        raise HTTPException(500, f"active.json unreadable: {exc}") from exc


# ─── /models/delete ─────────────────────────────────────────────────


class DeleteRequest(BaseModel):
    path: str


@router.post("/delete")
def delete_model(req: DeleteRequest) -> dict[str, Any]:
    """Delete a downloaded GGUF (and its sibling config). Refuses to
    delete the currently active model — the caller must activate
    something else first so the supervisor doesn't crash on respawn.
    """
    p = Path(req.path)
    if not p.is_file():
        raise HTTPException(404, "GGUF not found")
    active = _active_config_path()
    if active.is_file():
        try:
            data = json.loads(active.read_text(encoding="utf-8"))
            if Path(data.get("gguf_path", "")).resolve() == p.resolve():
                raise HTTPException(409, "cannot delete the active model; activate another first")
        except HTTPException:
            raise
        except Exception:
            pass
    parent = p.parent
    try:
        p.unlink()
    except OSError as exc:
        raise HTTPException(500, f"unlink failed: {exc}") from exc
    sibling = p.with_suffix(".config.json")
    if sibling.is_file():
        sibling.unlink(missing_ok=True)
    # If the directory is now empty (no GGUFs, no other artefacts), tidy
    # up so /models/local doesn't surface empty repo folders.
    if parent != _models_dir() and not any(parent.iterdir()):
        try:
            shutil.rmtree(parent, ignore_errors=True)
        except Exception:
            pass
    return {"ok": True}
