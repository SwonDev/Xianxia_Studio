"""Tests for pure LTX-2.3 img2video helpers.

Run with: `cd apps/sidecar-py && python -m pytest tests/test_ltx_video.py -q`
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from xianxia_ai.routes.ltx_video import build_ltx_workflow, ltx_frame_count  # noqa: E402


def test_frames_rule_div8_plus1():
    assert ltx_frame_count(4.0, 24) == 97
    assert ltx_frame_count(1.0, 24) == 25
    assert ltx_frame_count(0.0, 24) == 9


def test_build_ltx_workflow_params():
    wf = build_ltx_workflow(
        template="gguf",
        init_image="/k.png",
        prompt="a misty peak",
        width=768,
        height=512,
        seconds=4.0,
        fps=24,
        seed=7,
    )
    s = json.dumps(wf)
    assert "/k.png" in s and "a misty peak" in s
    assert wf["__frames"] == 97 and wf["__width"] == 768 and wf["__height"] == 512


def test_build_ltx_workflow_full_template():
    wf = build_ltx_workflow(
        template="full",
        init_image="/img.png",
        prompt="snowy valley",
        width=512,
        height=512,
        seconds=1.0,
        fps=24,
        seed=42,
    )
    s = json.dumps(wf)
    assert "/img.png" in s and "snowy valley" in s
    assert wf["__frames"] == 25


def test_ltx_frame_count_edge():
    # min clamp: 0 seconds still yields 9 frames
    assert ltx_frame_count(0.0, 24) == 9
    # 0.3s @ 24fps → round(7.2)=7 → (7//8)*8=0 → 0+1=1 < 9 → clamp to 9
    assert ltx_frame_count(0.3, 24) == 9
