"""DepthFlow runner — invoked from the main sidecar via subprocess.

Lives in an isolated venv with `pip install depthflow` because depthflow
hard-pins newer torch / transformers / pillow / numpy that conflict with
the main sidecar's deps (qwen-tts, audiocraft, rembg). Keeping
it in its own venv lets us call DepthFlow as a CLI-style tool without
contaminating the rest of the runtime.

Reads a single JSON payload from argv[1] with this shape:

    {
      "image":  "<absolute path to input image>",
      "output": "<absolute path of output mp4>",
      "time":   8.0,                  # seconds
      "fps":    24,
      "width":  1920,
      "height": 1080,
      "animation": "orbital"          # optional preset
    }

Writes the MP4 and prints "OK <path>" on success, "ERR <msg>" on failure.
"""
from __future__ import annotations

import json
import sys
import os
import traceback


def _heal_hf_cache() -> None:
    """Delete any `.incomplete` blob files in the Depth-Anything-V2 cache
    so HuggingFace re-downloads on the next load.

    Why: when the antivirus / a user-cancel interrupts the first-ever
    DepthFlow run, HF leaves `.incomplete` zero-byte blobs in the cache
    and never retries on subsequent runs — every later call then fails
    with "Can't load image processor … preprocessor_config.json"
    (observed in v0.1.41 batch errors). Cleaning these stubs before
    importing depthflow lets transformers re-fetch the missing files
    instead of refusing to start.

    Scopes:
      • The HF_HOME / HF cache resolved exactly the way transformers
        does (env HF_HOME → ~/.cache/huggingface).
      • The XIANXIA app cache at `%APPDATA%/xianxia/XianxiaStudio/data/
        hf-cache` (set by the Tauri supervisor when launching the
        sidecar; the depthflow subprocess inherits this env).
      • For each, only the Depth-Anything-V2 model directory — we do
        NOT touch unrelated downloads.
    """
    candidate_roots: list[str] = []
    env_home = os.environ.get("HF_HOME")
    if env_home:
        candidate_roots.append(os.path.join(env_home, "hub"))
    user_profile = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    if user_profile:
        candidate_roots.append(os.path.join(user_profile, ".cache", "huggingface", "hub"))
    xianxia_data = os.environ.get("XIANXIA_DATA_DIR")
    if xianxia_data:
        candidate_roots.append(os.path.join(xianxia_data, "hf-cache", "hub"))
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidate_roots.append(
            os.path.join(appdata, "xianxia", "XianxiaStudio", "data", "hf-cache", "hub")
        )
    # de-dup while preserving order
    seen: set[str] = set()
    roots: list[str] = []
    for r in candidate_roots:
        if r and r not in seen and os.path.isdir(r):
            seen.add(r)
            roots.append(r)

    targets = ("models--depth-anything--Depth-Anything-V2-small-hf",)
    deleted_any = False
    for root in roots:
        for target in targets:
            model_dir = os.path.join(root, target)
            if not os.path.isdir(model_dir):
                continue
            for walk_root, _dirs, files in os.walk(model_dir):
                for fname in files:
                    if fname.endswith(".incomplete"):
                        fpath = os.path.join(walk_root, fname)
                        try:
                            os.remove(fpath)
                            deleted_any = True
                        except OSError:
                            pass
    if deleted_any:
        # Stdout is captured by the parent; surface a one-line breadcrumb
        # so we can spot self-heal events in `depthflow runner failed`
        # diagnostics if HF still can't download afterwards.
        sys.stderr.write("self-heal: removed .incomplete HF blobs\n")


def main() -> int:
    if len(sys.argv) < 2:
        print("ERR missing JSON payload as argv[1]", flush=True)
        return 2

    try:
        req = json.loads(sys.argv[1])
    except Exception as e:  # noqa: BLE001
        print(f"ERR invalid JSON: {e}", flush=True)
        return 2

    image = req.get("image")
    output = req.get("output")
    time_s = float(req.get("time", 8.0))
    fps = int(req.get("fps", 24))
    width = int(req.get("width", 1920))
    height = int(req.get("height", 1080))
    animation = (req.get("animation") or "").strip().lower()

    if not image or not os.path.isfile(image):
        print(f"ERR image not found: {image}", flush=True)
        return 2
    if not output:
        print("ERR output path required", flush=True)
        return 2
    os.makedirs(os.path.dirname(output) or ".", exist_ok=True)

    # v0.1.42: auto-heal a partial HF download before touching depthflow.
    # If the previous run was killed mid-download (antivirus, power, …)
    # transformers will refuse to load the model because of left-over
    # `.incomplete` blobs — wiping them lets HF re-fetch cleanly.
    try:
        _heal_hf_cache()
    except Exception:  # noqa: BLE001 — never abort runner on heal step
        traceback.print_exc(file=sys.stderr)

    try:
        # Lazy import — keeps the script's startup snappy when arguments
        # are wrong and lets us emit a friendly error before paying the
        # ~3-5 s cost of importing torch + moderngl.
        from depthflow.scene import DepthScene  # type: ignore
    except Exception as e:  # noqa: BLE001
        print(f"ERR depthflow import failed: {e}", flush=True)
        traceback.print_exc(file=sys.stderr)
        return 3

    try:
        scene = DepthScene(backend="headless")
        scene.input(image=image)
        # DepthFlow's default animation is a tasteful subtle dolly-zoom
        # plus minor parallax sway — perfect for documentary pacing.
        # The named-preset API on `depthflow.animation` keeps shifting
        # between versions (Orbital / Cinematic / Move presets disappear
        # and reappear) so we deliberately don't try to pick one and let
        # DepthFlow ship its current default. The `animation` field is
        # accepted for forward-compat but currently ignored.
        _ = animation
        scene.main(
            time=time_s,
            fps=fps,
            output=output,
            width=width,
            height=height,
        )
    except Exception as e:  # noqa: BLE001
        print(f"ERR render failed: {e}", flush=True)
        traceback.print_exc(file=sys.stderr)
        return 4

    if not os.path.isfile(output) or os.path.getsize(output) < 1024:
        print(f"ERR output missing or too small: {output}", flush=True)
        return 5

    print(f"OK {output}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
