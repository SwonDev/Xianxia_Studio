from fastapi import APIRouter

from ..codec import best_video_encoder

router = APIRouter()


@router.get("/health")
def health() -> dict:
    enc = best_video_encoder()
    return {
        "ok": True,
        "service": "xianxia-sidecar",
        "version": "0.1.0",
        "video_encoder": enc.codec_name,
        "video_encoder_label": enc.label,
        "video_hw_accelerated": enc.is_hw_accelerated,
    }
