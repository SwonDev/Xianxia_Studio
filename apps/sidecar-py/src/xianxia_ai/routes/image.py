"""Image generation via Z-Image-Turbo (ComfyUI primary, diffusers fallback).

Defaults are tuned for 8 GB VRAM:
- horizontal: 1280x720 (sweet spot, no offload, ~5-7 GB peak)
- vertical:   720x1280 (sweet spot vertical, same VRAM budget)

The XIANXIA_STYLE preset drops SDXL-isms ("8k", "masterpiece") that degrade
Z-Image quality and uses cinematographer vocabulary the Lumina2 family was
trained on.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..models import image_model

router = APIRouter()

# Cinematic preset — tuned to Z-Image's training distribution.
# Avoids SDXL trigger words that visibly degrade output on Lumina2 / DiT models.
XIANXIA_STYLE = (
    "cinematic anamorphic 2.39:1 framing, volumetric god rays, "
    "Kodak Portra 400 film grade, teal-and-orange tones, "
    "jade mountains and silk hanfu in xianxia mood, "
    "sharp focus on subject, natural skin texture, ink-wash atmosphere"
)


class ImageRequest(BaseModel):
    prompt: str
    negative_prompt: str | None = None
    # 8 GB VRAM sweet spot. For horizontal, callers usually pass 1280x720 explicitly.
    # For vertical Shorts, callers should pass 720x1280 explicitly. The 1344x768
    # default kept here is for legacy callers; production code passes explicit dims.
    width: int = 1280
    height: int = 720
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
        # Z-Image-Turbo is trained with guidance_scale=0.0 → negative prompts
        # have no effect. We accept the field for API stability but pass None
        # to skip the unnecessary forward pass.
        negative_prompt=None,
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
