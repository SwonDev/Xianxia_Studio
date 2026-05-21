"""Model installer endpoints — invoked by the Rust auto-installer to fetch HF assets."""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


# ── /install/hardware ──────────────────────────────────────────────
# Mirrors apps/desktop/src-tauri/src/hardware.rs:detect_hardware so
# browser-mode (the tauri-shim) sees the SAME CPU/RAM/GPU values the
# Tauri webview gets from the Rust sysinfo crate. Without this the
# top-bar widget shows "0 cores · 0.0 / 0.0 GB" in dev.
@router.get("/hardware")
def hardware() -> dict:
    info: dict = {
        "os": platform.system().lower(),
        "arch": platform.machine().lower(),
        "cpu_brand": "Unknown",
        "cpu_cores": 0,
        "cpu_logical_cores": 0,
        "total_ram_gb": 0.0,
        "available_ram_gb": 0.0,
        "free_disk_gb": 0.0,
        "gpu": None,
    }
    # CPU + RAM via psutil (already in the sidecar's deps).
    try:
        import psutil
        info["cpu_cores"] = psutil.cpu_count(logical=False) or 0
        info["cpu_logical_cores"] = psutil.cpu_count(logical=True) or 0
        vm = psutil.virtual_memory()
        info["total_ram_gb"] = round(vm.total / 1024 / 1024 / 1024, 2)
        info["available_ram_gb"] = round(vm.available / 1024 / 1024 / 1024, 2)
    except Exception:
        pass
    # CPU brand (Windows: cpuinfo; cross-platform fallback platform.processor)
    try:
        info["cpu_brand"] = (platform.processor() or "Unknown").strip()
        if not info["cpu_brand"] or info["cpu_brand"] == "":
            info["cpu_brand"] = "Unknown"
    except Exception:
        pass
    # Free disk on the install drive (current working drive).
    try:
        usage = shutil.disk_usage(os.path.abspath(os.sep))
        info["free_disk_gb"] = round(usage.free / 1024 / 1024 / 1024, 2)
    except Exception:
        pass
    # GPU — nvidia-smi (already required for ComfyUI / Z-Image). One-shot
    # query; failure is fine — UI shows "Sin GPU dedicada" tier.
    try:
        proc = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
            encoding="utf-8", errors="replace",
        )
        if proc.returncode == 0 and proc.stdout.strip():
            first_line = proc.stdout.strip().splitlines()[0]
            parts = [p.strip() for p in first_line.split(",")]
            if len(parts) >= 2:
                info["gpu"] = {
                    "vendor": "nvidia",
                    "name": parts[0],
                    "vram_gb": round(float(parts[1]) / 1024.0, 2) if parts[1] else None,
                    "driver": parts[2] if len(parts) > 2 else None,
                }
    except Exception:
        pass
    # Tiering — mirrors hardware.rs::recommend_models heuristic.
    vram = (info["gpu"] or {}).get("vram_gb") or 0.0
    ram = info["total_ram_gb"]
    if vram >= 24 and ram >= 32:
        tier = "ultra"
    elif vram >= 12:
        tier = "high"
    elif vram >= 8:
        tier = "medium"
    elif vram >= 6:
        tier = "medium-safe"
    elif vram >= 4:
        tier = "low"
    else:
        tier = "cpu-only" if ram >= 16 else "low"
    info["recommendation"] = {
        "llm_hf_repo": "mradermacher/supergemma4-e4b-abliterated-i1-GGUF",
        "llm_gguf_file": "supergemma4-e4b-abliterated.i1-Q4_K_M.gguf",
        "llm_label": "Gemma 4 E4B abliterated Q4_K_M",
        "llm_abliterated": True,
        "image": "Z-Image-Turbo",
        "tts": "Qwen3-TTS",
        "tier": tier,
        "estimated_download_gb": 17.0,
    }
    return info


class HfDownloadRequest(BaseModel):
    repo: str
    filename: str | None = None  # if None, download whole repo
    revision: str = "main"
    target_dir: str


class HfDownloadResponse(BaseModel):
    path: str
    bytes: int


@router.post("/hf-download", response_model=HfDownloadResponse)
def hf_download(req: HfDownloadRequest) -> HfDownloadResponse:
    """Snapshot or single-file download from HuggingFace via huggingface_hub.

    v0.12.6 — detección distinguida 401 vs 403:
      - 401 (GatedRepoError sin token): el usuario NO tiene HF token
        configurado. La UI muestra "Configura tu token HF en Ajustes".
      - 403 (GatedRepoError con token pero sin authorized list): el usuario
        no aceptó la licencia del modelo. La UI muestra "Ve a HF y acepta
        el modelo: <URL>".
      - Repo no encontrado: error claro distinto al gated.

    Token resolution order (mismo patrón que huggingface_hub default):
      1. Env var XIANXIA_HF_TOKEN (preferido: lo controla el usuario en
         Ajustes vía app_settings).
      2. Env var HF_TOKEN / HUGGING_FACE_HUB_TOKEN (estándar HF).
      3. Token guardado en ~/.cache/huggingface/token (login CLI).
      4. None → solo modelos públicos accesibles.
    """
    import os
    try:
        from huggingface_hub import hf_hub_download, snapshot_download
        from huggingface_hub.errors import GatedRepoError, RepositoryNotFoundError
    except Exception as e:
        raise HTTPException(503, f"huggingface_hub not installed: {e}") from e

    target = Path(req.target_dir)
    target.mkdir(parents=True, exist_ok=True)

    # Token explícito del entorno (Ajustes UI escribirá esto en una
    # próxima versión). Si está vacío, huggingface_hub usa el default
    # chain (env HF_TOKEN o ~/.cache/huggingface/token).
    token = (
        os.environ.get("XIANXIA_HF_TOKEN")
        or os.environ.get("HF_TOKEN")
        or os.environ.get("HUGGING_FACE_HUB_TOKEN")
        or None
    )

    try:
        if req.filename:
            path = hf_hub_download(
                repo_id=req.repo,
                filename=req.filename,
                revision=req.revision,
                local_dir=str(target),
                token=token,
            )
        else:
            path = snapshot_download(
                repo_id=req.repo,
                revision=req.revision,
                local_dir=str(target),
                token=token,
            )
    except GatedRepoError as exc:
        # huggingface_hub.errors.GatedRepoError wraps both 401 (no token)
        # and 403 (token but not in authorized list). Distinguimos con el
        # status code real del response wrapped por el SDK.
        msg = str(exc)
        # El mensaje del SDK incluye literalmente "401" o "403".
        if "403" in msg or "authorized list" in msg.lower():
            raise HTTPException(
                403,
                detail={
                    "kind": "hf_gated_not_authorized",
                    "repo": req.repo,
                    "remedy": (
                        f"Acepta la licencia del modelo: "
                        f"https://huggingface.co/{req.repo}"
                    ),
                    "raw": msg[:300],
                },
            ) from exc
        # 401 → falta token o token sin acceso al repo gated.
        raise HTTPException(
            401,
            detail={
                "kind": "hf_token_missing_or_invalid",
                "repo": req.repo,
                "remedy": (
                    "Configura tu token HF en Ajustes → HuggingFace, o "
                    "ejecuta `huggingface-cli login` con un token Read."
                ),
                "raw": msg[:300],
            },
        ) from exc
    except RepositoryNotFoundError as exc:
        raise HTTPException(
            404,
            detail={
                "kind": "hf_repo_not_found",
                "repo": req.repo,
                "remedy": "Verifica el repo_id (puede haberse renombrado).",
                "raw": str(exc)[:300],
            },
        ) from exc

    p = Path(path)
    size = p.stat().st_size if p.is_file() else sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
    return HfDownloadResponse(path=str(p), bytes=size)


class OllamaModelfileRequest(BaseModel):
    model_name: str
    gguf_path: str
    abliterated: bool = False


@router.post("/ollama-create")
def ollama_create(req: OllamaModelfileRequest) -> dict:
    """Write a Modelfile pointing at the GGUF and run `ollama create`."""
    system_prompt = (
        "Eres un narrador experto en xianxia, wuxia y mitologia china. "
        "Tu estilo es epico, mistico y accesible para audiencia occidental. "
        "Generas scripts cinematograficos con marcadores [IMAGE: ...] [MUSIC: mood=...] [CHAPTER: ...]"
    )
    modelfile = (
        f"FROM {req.gguf_path.replace(os.sep, '/')}\n"
        "PARAMETER temperature 0.85\n"
        "PARAMETER top_p 0.92\n"
        "PARAMETER num_ctx 32768\n"
        f'SYSTEM """{system_prompt}"""\n'
    )
    mf_path = Path(req.gguf_path).parent / f"{req.model_name}.Modelfile"
    mf_path.write_text(modelfile, encoding="utf-8")

    # v0.7.16 — timeout 10 min. `ollama create` copia el GGUF (puede ser
    # 4-8 GB) y genera el manifest. En disco SATA puede tardar minutos;
    # un cuelgue real bailaría con esto.
    try:
        result = subprocess.run(
            ["ollama", "create", req.model_name, "-f", str(mf_path)],
            capture_output=True,
            text=True,
            timeout=600,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(500, f"ollama create timeout (>10 min): {exc}") from exc
    if result.returncode != 0:
        raise HTTPException(500, f"ollama create failed: {result.stderr}")
    return {
        "model_name": req.model_name,
        "modelfile": str(mf_path),
        "stdout": result.stdout,
    }
