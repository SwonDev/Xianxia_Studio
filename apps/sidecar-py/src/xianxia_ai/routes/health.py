from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
def health() -> dict:
    return {"ok": True, "service": "xianxia-sidecar", "version": "0.1.0"}
