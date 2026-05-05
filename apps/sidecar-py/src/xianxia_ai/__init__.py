"""Xianxia Studio AI sidecar package."""
import os
from pathlib import Path

__version__ = "0.1.0"


def _comfy_root() -> Path:
    """Return ComfyUI install directory (env override or default runtime path)."""
    env = os.environ.get("XIANXIA_COMFYUI_PATH")
    if env:
        return Path(env)
    # Default: <app data>/runtime/comfyui (matches Rust installer's paths::runtime_dir)
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA", "")) / "xianxia" / "XianxiaStudio" / "data"
    else:
        base = Path.home() / ".local" / "share" / "XianxiaStudio"
    return base / "runtime" / "comfyui"
