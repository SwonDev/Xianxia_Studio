"""Model installer endpoints — invoked by the Rust auto-installer to fetch HF assets."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


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
    """Snapshot or single-file download from HuggingFace via huggingface_hub."""
    try:
        from huggingface_hub import hf_hub_download, snapshot_download
    except Exception as e:
        raise HTTPException(503, f"huggingface_hub not installed: {e}") from e

    target = Path(req.target_dir)
    target.mkdir(parents=True, exist_ok=True)

    if req.filename:
        path = hf_hub_download(
            repo_id=req.repo,
            filename=req.filename,
            revision=req.revision,
            local_dir=str(target),
        )
    else:
        path = snapshot_download(
            repo_id=req.repo,
            revision=req.revision,
            local_dir=str(target),
        )
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

    result = subprocess.run(
        ["ollama", "create", req.model_name, "-f", str(mf_path)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise HTTPException(500, f"ollama create failed: {result.stderr}")
    return {
        "model_name": req.model_name,
        "modelfile": str(mf_path),
        "stdout": result.stdout,
    }
