"""Image generation via Z-Image-Turbo (diffusers)."""

from __future__ import annotations

import os
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..models import image_model

router = APIRouter()

XIANXIA_STYLE = (
    "cinematic xianxia, jade mountains, swirling qi mist, golden hour, "
    "ultra detailed, epic composition, photorealistic, 8k"
)


class ImageRequest(BaseModel):
    prompt: str
    negative_prompt: str | None = None
    width: int = 1344
    height: int = 768
    seed: int | None = None
    # Z-Image-Turbo native step count. Some diffusers dev revisions over-iterate
    # and crash with "index out of bounds" at step 10; 8 is the safe canonical
    # value (the model performs 8 DiT forwards regardless).
    steps: int = 8
    out_dir: str | None = None
    style_preset: bool = True


class ImageResponse(BaseModel):
    image_path: str
    seed: int


@router.post("", response_model=ImageResponse)
def generate(req: ImageRequest) -> ImageResponse:
    prompt = f"{req.prompt}, {XIANXIA_STYLE}" if req.style_preset else req.prompt

    # ComfyUI path (preferred when running): submit the workflow and wait.
    if os.environ.get("XIANXIA_USE_COMFYUI") == "1":
        from ..models import comfyui_client
        if comfyui_client.is_running():
            wf = comfyui_client.xianxia_workflow(
                prompt, width=req.width, height=req.height, seed=req.seed or 42,
            )
            pid = comfyui_client.queue_prompt(wf)
            out_path_comfy = comfyui_client.wait_for_image(pid)
            return ImageResponse(image_path=str(out_path_comfy), seed=req.seed or 42)

    # Diffusers path (default + fallback)
    try:
        pipe = image_model.load()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Image model not ready: {e}") from e

    import torch

    seed = req.seed if req.seed is not None else int(torch.seed() % (2**31))

    image = pipe(
        prompt=prompt,
        negative_prompt=req.negative_prompt,
        height=req.height,
        width=req.width,
        num_inference_steps=req.steps,
        guidance_scale=0.0,  # required for Turbo variants
        generator=torch.Generator(image_model.device()).manual_seed(seed),
    ).images[0]

    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out"))
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"image-{uuid.uuid4().hex[:10]}.png"
    image.save(out_path)
    return ImageResponse(image_path=str(out_path), seed=seed)
