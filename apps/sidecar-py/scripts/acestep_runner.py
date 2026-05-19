"""ACE-Step v1.5 runner — invoked from the main sidecar via subprocess.

Lives in an ISOLATED venv (`runtime/acestep-venv`) because ACE-Step-1.5
(tag v0.1.7) hard-pins `torch==2.7.1+cu128` + `nano-vllm` (local
editable) + flash-attn / triton-windows / transformers>=4.51, all of
which conflict with the main sidecar's torch 2.5.1+cu121 stack. Same
isolation strategy the project already uses for DepthFlow.

Reads ONE JSON payload from argv[1]:

    {
      "repo_dir":   "<abs path to the cloned ACE-Step-1.5 repo>",
      "ckpt_dir":   "<abs path where the HF checkpoint lives/downloads>",
      "caption":    "epic cinematic orchestral, taiko, ethereal choir",
      "duration":   180.0,
      "out_path":   "<abs path of the .wav to write>",
      "seed":       42,
      "infer_steps": 32
    }

Prints exactly one final line: "OK <wav_path>" or "ERR <message>".
GPU-only by contract: offload flags are forced False (the 2B SFT
checkpoint is <4 GB BF16 and fits 8 GB without CPU offload).

API verified against ace-step/ACE-Step-1.5 @ tag v0.1.7
(commit cb49cb9): acestep.handler.AceStepHandler +
acestep.inference.generate_music / GenerationParams / GenerationConfig.
"""
from __future__ import annotations

import json
import os
import sys
import traceback


def _fail(msg: str) -> "NoReturn":  # type: ignore[name-defined]
    print(f"ERR {msg}", flush=True)
    sys.exit(1)


def main() -> None:
    if len(sys.argv) < 2:
        _fail("no JSON payload argument")
    try:
        req = json.loads(sys.argv[1])
    except Exception as e:  # noqa: BLE001
        _fail(f"bad JSON payload: {e}")

    repo_dir = req.get("repo_dir") or ""
    ckpt_dir = req.get("ckpt_dir") or ""
    caption = (req.get("caption") or "cinematic orchestral instrumental").strip()
    duration = float(req.get("duration") or 180.0)
    out_path = req.get("out_path") or ""
    seed = int(req.get("seed") or 42)
    infer_steps = int(req.get("infer_steps") or 32)

    if not out_path:
        _fail("out_path missing")
    # ACE-Step 1.5 valid duration range is 10–600 s (verified inference.py).
    duration = max(10.0, min(600.0, duration))

    # The checkpoint downloads here on first run via huggingface_hub
    # snapshot_download (repo ACE-Step/Ace-Step1.5). Pin it so it lands
    # inside the app data dir, not a random cwd/checkpoints folder.
    if ckpt_dir:
        os.environ["ACESTEP_CHECKPOINTS_DIR"] = ckpt_dir
    if repo_dir:
        os.environ.setdefault("ACESTEP_PROJECT_ROOT", repo_dir)
        # The repo must be importable (it's not a published wheel).
        if repo_dir not in sys.path:
            sys.path.insert(0, repo_dir)
    # Force HuggingFace as the weights source (avoid the ModelScope
    # fallback) and keep downloads inside the app cache.
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

    try:
        from acestep.handler import AceStepHandler  # type: ignore
        from acestep.inference import (  # type: ignore
            generate_music,
            GenerationParams,
            GenerationConfig,
        )
    except Exception as e:  # noqa: BLE001
        _fail(f"acestep import failed (venv not ready?): {e}")

    out_dir = os.path.dirname(os.path.abspath(out_path)) or "."
    os.makedirs(out_dir, exist_ok=True)

    try:
        dit = AceStepHandler()
        dit.initialize_service(
            project_root=repo_dir,
            config_path="acestep-v15-sft",  # 2B SFT, <4 GB BF16
            device="cuda",
            use_flash_attention=False,  # robust on 8 GB / mixed driver
            compile_model=False,
            offload_to_cpu=False,       # GPU-only contract
            offload_dit_to_cpu=False,   # GPU-only contract
        )
    except Exception as e:  # noqa: BLE001
        _fail(f"initialize_service failed: {e}\n{traceback.format_exc()[-800:]}")

    try:
        params = GenerationParams(
            task_type="text2music",
            caption=caption,
            lyrics="[Instrumental]",
            instrumental=True,
            duration=duration,
            inference_steps=infer_steps,
            guidance_scale=7.0,
            seed=seed,
            thinking=False,         # do NOT load the 0.6B LM planner (VRAM)
            use_cot_metas=False,
            use_cot_caption=False,
            use_cot_language=False,
        )
        config = GenerationConfig(
            batch_size=1,           # default 2 → 1 for 8 GB
            use_random_seed=False,
            audio_format="wav",
        )
        # llm_handler=None: thinking/CoT off → planner not required
        # (verified inference.py:437).
        result = generate_music(dit, None, params, config, save_dir=out_dir)
    except Exception as e:  # noqa: BLE001
        _fail(f"generate_music failed: {e}\n{traceback.format_exc()[-800:]}")

    ok = bool(getattr(result, "success", False))
    audios = getattr(result, "audios", None) or []
    if not ok or not audios:
        err = getattr(result, "error", None) or "no audio produced"
        _fail(f"generation unsuccessful: {err}")

    produced = ""
    first = audios[0]
    if isinstance(first, dict):
        produced = first.get("path") or first.get("audio_path") or ""
    else:
        produced = str(first)
    if not produced or not os.path.isfile(produced):
        _fail(f"result path missing on disk: {produced!r}")

    # Normalise to the caller's requested out_path.
    try:
        if os.path.abspath(produced) != os.path.abspath(out_path):
            import shutil
            shutil.move(produced, out_path)
        final = out_path
    except Exception:
        final = produced  # caller can still read the produced file

    if not os.path.isfile(final) or os.path.getsize(final) < 1024:
        _fail(f"final wav empty/missing: {final}")

    print(f"OK {final}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 — last-resort guard
        print(f"ERR unhandled: {e}\n{traceback.format_exc()[-800:]}", flush=True)
        sys.exit(1)
