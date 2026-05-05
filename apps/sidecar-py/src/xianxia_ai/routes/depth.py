"""Depth segmentation route — produce 2.5D parallax layers from a single image.

Toma una imagen generada por Z-Image-Turbo y produce dos assets que la
plantilla narrativa de HyperFrames consume como capas paralax:

  - ``<stem>.bg.jpg`` — fondo con el sujeto eliminado e *inpainted*
    (rellena el hueco que deja el primer plano para que el fondo no
    parezca recortado durante el pan).
  - ``<stem>.fg.png`` — primer plano sobre transparencia (RGBA).

La plantilla ``apps/sidecar-node/src/templates/narrative.html`` ya
soporta este flujo a través de los campos ``foreground_path`` y
``mid_path`` de ``ImageBeat`` (ver ``apps/sidecar-node/src/render.ts``).
Sin estas capas, la plantilla cae en el modo ``.single`` (solo pan
direccional, sin paralaje real).

Modelos de matting soportados:

  - ``u2net`` (por defecto): rembg + U2Net. Rápido en GPU (~1.5–2.5 s
    por 1024×1024 en una RTX 4060) y excelente para personajes/sujetos
    centrales.
  - ``isnet``: rembg + ISNet General Use. Bordes ligeramente más
    limpios en escenas con vegetación o pelo fino.
  - ``briaai``: ``briaai/RMBG-2.0`` desde ``transformers``. Mayor
    calidad a costa de más VRAM. Solo se carga si ``transformers`` y
    ``torch`` están instalados.

Inpainting:
  El hueco que deja el primer plano se rellena con
  ``cv2.inpaint(..., INPAINT_TELEA)``. El resultado es perfectamente
  válido para paralaje porque la animación cubre la zona inpaint con la
  capa ``fg.png``; los requisitos de calidad del fondo son modestos.

Instalación necesaria (si todavía no están disponibles en el venv)::

    pip install rembg onnxruntime-gpu opencv-python

Para el modo ``briaai`` adicionalmente::

    pip install transformers torch
"""

from __future__ import annotations

import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter()
log = logging.getLogger("xianxia.depth")

# ── Cache perezoso para sesiones de rembg / modelos pesados ──────────
# Evita recargar el modelo en cada request (las sesiones de rembg y los
# pesos de RMBG-2.0 ocupan VRAM y tardan en inicializar).
_REMBG_SESSIONS: dict[str, Any] = {}
_BRIAAI_MODEL: Any = None


# ── Schemas ──────────────────────────────────────────────────────────


class DepthSegmentRequest(BaseModel):
    image_path: str
    out_dir: str | None = None  # por defecto: mismo directorio que image_path
    model: str = Field(default="u2net", description="'u2net' | 'isnet' | 'briaai'")
    inpaint_radius: int = Field(default=12, ge=1, le=64)
    feather_pixels: int = Field(default=4, ge=0, le=64)


class DepthSegmentResponse(BaseModel):
    bg_path: str
    fg_path: str
    width: int
    height: int
    seconds: float


class DepthBatchRequest(BaseModel):
    images: list[str]
    out_dir: str | None = None
    model: str = Field(default="u2net", description="'u2net' | 'isnet' | 'briaai'")
    inpaint_radius: int = Field(default=12, ge=1, le=64)
    feather_pixels: int = Field(default=0, ge=0, le=64)
    max_workers: int = Field(default=2, ge=1, le=8)


class DepthBatchResponse(BaseModel):
    results: list[DepthSegmentResponse]
    seconds: float


# ── Endpoints ────────────────────────────────────────────────────────


@router.post("", response_model=DepthSegmentResponse)
def segment(req: DepthSegmentRequest) -> DepthSegmentResponse:
    """Procesa una sola imagen y devuelve las rutas de ``bg.jpg`` y ``fg.png``."""
    return _segment_one(req)


@router.post("/batch", response_model=DepthBatchResponse)
def segment_batch(req: DepthBatchRequest) -> DepthBatchResponse:
    """Procesa varias imágenes en paralelo (útil para pre-procesar todos los
    *beats* antes de invocar al renderer de HyperFrames).

    Nota: el paralelismo real es limitado en GPU (la mayoría de modelos de
    matting son monohilo en CUDA), pero ``max_workers > 1`` ayuda en CPU y
    permite solapar I/O del *inpainting* con el matting siguiente.
    """
    if not req.images:
        return DepthBatchResponse(results=[], seconds=0.0)

    t0 = time.perf_counter()
    results: list[DepthSegmentResponse] = []

    # Pre-carga la sesión una sola vez para evitar que cada hilo la cree
    # de forma concurrente y duplique el coste de inicialización.
    _ensure_session(req.model)

    def _job(image_path: str) -> DepthSegmentResponse:
        sub = DepthSegmentRequest(
            image_path=image_path,
            out_dir=req.out_dir,
            model=req.model,
            inpaint_radius=req.inpaint_radius,
            feather_pixels=req.feather_pixels,
        )
        return _segment_one(sub)

    workers = max(1, min(req.max_workers, len(req.images)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for res in pool.map(_job, req.images):
            results.append(res)

    return DepthBatchResponse(results=results, seconds=time.perf_counter() - t0)


# ── Implementación ───────────────────────────────────────────────────


def _segment_one(req: DepthSegmentRequest) -> DepthSegmentResponse:
    src = Path(req.image_path)
    if not src.exists():
        raise HTTPException(404, f"image missing: {req.image_path}")

    out_dir = Path(req.out_dir) if req.out_dir else src.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    bg_path = out_dir / f"{src.stem}.bg.jpg"
    fg_path = out_dir / f"{src.stem}.fg.png"

    # ── Dependencias pesadas (importadas perezosamente) ──────────────
    try:
        import numpy as np  # type: ignore
        from PIL import Image  # type: ignore
    except Exception as e:  # pragma: no cover - dep básica del proyecto
        raise HTTPException(503, f"PIL/numpy not ready: {e}") from e

    try:
        import cv2  # type: ignore
    except Exception as e:
        raise HTTPException(
            503,
            "opencv-python no está instalado. Ejecuta: "
            "pip install opencv-python",
        ) from e

    t0 = time.perf_counter()

    # ── 1) Carga la imagen en RGB ────────────────────────────────────
    pil_rgb = Image.open(str(src)).convert("RGB")
    width, height = pil_rgb.size
    np_rgb = np.array(pil_rgb)  # (H, W, 3) uint8

    # ── 2) Genera la máscara alfa del primer plano ───────────────────
    mask = _compute_mask(np_rgb, model=req.model)
    if mask.shape[:2] != (height, width):
        # Reescala si el modelo devolvió otra resolución (RMBG suele
        # trabajar a 1024 internamente).
        mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_LINEAR)

    # Asegura uint8 [0,255]
    if mask.dtype != np.uint8:
        mask = np.clip(mask, 0, 255).astype(np.uint8)

    # ── 3) Suaviza el borde de la máscara para componer limpio ───────
    feather = int(req.feather_pixels)
    alpha = mask
    if feather > 0:
        # Kernel impar para GaussianBlur
        k = feather * 2 + 1
        alpha = cv2.GaussianBlur(mask, (k, k), 0)

    # ── 4) Construye el FG en RGBA ───────────────────────────────────
    fg_rgba = np.dstack([np_rgb, alpha])  # (H, W, 4)
    Image.fromarray(fg_rgba, mode="RGBA").save(str(fg_path), format="PNG", optimize=True)

    # ── 5) Construye el BG inpainted ────────────────────────────────
    # cv2.inpaint requiere BGR + máscara binaria de las zonas a rellenar.
    # Dilatamos la máscara para evitar restos del sujeto en el borde.
    bgr = cv2.cvtColor(np_rgb, cv2.COLOR_RGB2BGR)
    binary_mask = (mask > 16).astype(np.uint8) * 255
    dilate_k = max(3, req.inpaint_radius // 2)
    if dilate_k % 2 == 0:
        dilate_k += 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilate_k, dilate_k))
    binary_mask = cv2.dilate(binary_mask, kernel, iterations=1)

    bg_bgr = cv2.inpaint(
        bgr,
        binary_mask,
        inpaintRadius=int(req.inpaint_radius),
        flags=cv2.INPAINT_TELEA,
    )
    # Guardado JPEG con calidad 92 para reducir tamaño sin pérdida visible.
    cv2.imwrite(str(bg_path), bg_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 92])

    elapsed = time.perf_counter() - t0
    log.info(
        "depth.segment %s (%dx%d) model=%s in %.2fs",
        src.name,
        width,
        height,
        req.model,
        elapsed,
    )

    return DepthSegmentResponse(
        bg_path=str(bg_path),
        fg_path=str(fg_path),
        width=width,
        height=height,
        seconds=elapsed,
    )


# ── Backends de matting ──────────────────────────────────────────────


def _ensure_session(model: str) -> None:
    """Pre-carga el modelo solicitado (idempotente). Llamado en batch."""
    model = (model or "u2net").lower()
    if model == "briaai":
        _ensure_briaai()
    else:
        _ensure_rembg(model)


def _compute_mask(rgb: Any, model: str) -> Any:
    """Devuelve la máscara alfa del primer plano (uint8, HxW, 0..255)."""
    model = (model or "u2net").lower()
    if model == "briaai":
        return _mask_briaai(rgb)
    # u2net | isnet (cualquier valor desconocido cae a u2net)
    return _mask_rembg(rgb, name=model if model in {"u2net", "isnet"} else "u2net")


def _ensure_rembg(name: str) -> Any:
    """Carga (y cachea) una sesión de rembg. Devuelve la sesión."""
    try:
        from rembg import new_session  # type: ignore
    except Exception as e:
        raise HTTPException(
            503,
            "rembg no está instalado. Ejecuta: "
            "pip install rembg onnxruntime-gpu",
        ) from e

    if name not in _REMBG_SESSIONS:
        # Nombres oficiales de modelos de rembg.
        rembg_name = {"u2net": "u2net", "isnet": "isnet-general-use"}.get(name, "u2net")
        log.info("loading rembg session model=%s", rembg_name)
        # rembg autodetecta CUDA si onnxruntime-gpu está disponible.
        _REMBG_SESSIONS[name] = new_session(rembg_name)
    return _REMBG_SESSIONS[name]


def _mask_rembg(rgb: Any, name: str) -> Any:
    """Matting con rembg/U2Net (o ISNet). Devuelve uint8 (H, W)."""
    import numpy as np  # type: ignore
    from PIL import Image  # type: ignore
    from rembg import remove  # type: ignore

    session = _ensure_rembg(name)
    pil = Image.fromarray(rgb, mode="RGB")
    # ``only_mask=True`` evita que rembg componga el RGBA (más rápido).
    out = remove(pil, session=session, only_mask=True, post_process_mask=True)
    if isinstance(out, Image.Image):
        return np.array(out.convert("L"))
    if isinstance(out, (bytes, bytearray)):
        from io import BytesIO

        return np.array(Image.open(BytesIO(out)).convert("L"))
    return np.array(out)


def _ensure_briaai() -> Any:
    """Carga (y cachea) ``briaai/RMBG-2.0`` desde transformers en GPU si hay."""
    global _BRIAAI_MODEL
    if _BRIAAI_MODEL is not None:
        return _BRIAAI_MODEL

    try:
        import torch  # type: ignore
        from transformers import AutoModelForImageSegmentation  # type: ignore
    except Exception as e:
        raise HTTPException(
            503,
            "transformers/torch no están instalados. Usa model='u2net' "
            "o instala: pip install transformers torch",
        ) from e

    log.info("loading briaai/RMBG-2.0 (one-shot)")
    model = AutoModelForImageSegmentation.from_pretrained(
        "briaai/RMBG-2.0", trust_remote_code=True
    )
    if torch.cuda.is_available():
        model = model.to("cuda").eval()
    else:
        model = model.eval()
    # Habilita TF32 para acelerar matmul en RTX serie 30/40.
    if hasattr(torch, "set_float32_matmul_precision"):
        torch.set_float32_matmul_precision("high")
    _BRIAAI_MODEL = model
    return _BRIAAI_MODEL


def _mask_briaai(rgb: Any) -> Any:
    """Matting con RMBG-2.0. Devuelve uint8 (H, W) a la resolución de la entrada."""
    import numpy as np  # type: ignore
    import torch  # type: ignore
    from PIL import Image  # type: ignore
    from torchvision import transforms  # type: ignore

    model = _ensure_briaai()
    pil = Image.fromarray(rgb, mode="RGB")
    src_w, src_h = pil.size

    # RMBG-2.0 espera 1024x1024 normalizado a [-1, 1].
    tx = transforms.Compose(
        [
            transforms.Resize((1024, 1024)),
            transforms.ToTensor(),
            transforms.Normalize([0.5, 0.5, 0.5], [1.0, 1.0, 1.0]),
        ]
    )
    x = tx(pil).unsqueeze(0)
    if torch.cuda.is_available():
        x = x.to("cuda")

    with torch.no_grad():
        preds = model(x)[-1].sigmoid().cpu()
    pred = preds[0].squeeze()
    mask_pil = transforms.ToPILImage()(pred)
    mask_pil = mask_pil.resize((src_w, src_h), Image.BILINEAR)
    return np.array(mask_pil.convert("L"))
