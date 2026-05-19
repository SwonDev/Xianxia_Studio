"""Tests for pure chapter-generation helpers.

Run with: `cd apps/sidecar-py && python -m pytest tests/`
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from xianxia_ai.chapters import (  # noqa: E402
    parse_outline, chapter_count_for, assemble_script, expected_crossfade_duration,
)


def test_chapter_count_rule():
    assert chapter_count_for(6) == 3
    assert chapter_count_for(14) == 6
    assert 3 <= chapter_count_for(10) <= 6


def test_parse_outline_ok():
    raw = '{"chapters":[{"index":1,"title":"El Hallazgo",' \
          '"synopsis":"x","target_words":300,"beats":["a"]}]}'
    out = parse_outline(raw)
    assert out[0]["title"] == "El Hallazgo"
    assert out[0]["index"] == 1


def test_parse_outline_strips_codefence():
    raw = '```json\n{"chapters":[{"index":1,"title":"T",' \
          '"synopsis":"s","target_words":100,"beats":[]}]}\n```'
    assert parse_outline(raw)[0]["title"] == "T"


def test_parse_outline_invalid_raises():
    import pytest
    with pytest.raises(ValueError):
        parse_outline("not json at all")
    with pytest.raises(ValueError):
        parse_outline('{"chapters":[]}')


def test_expected_crossfade_duration():
    from xianxia_ai.chapters import expected_crossfade_duration
    assert abs(expected_crossfade_duration([10.0, 10.0, 10.0], 0.08) - 29.84) < 1e-6
    assert expected_crossfade_duration([], 0.08) == 0.0
    assert expected_crossfade_duration([5.0], 0.08) == 5.0


def test_assemble_script_preserves_markers():
    chapters = [
        "[CHAPTER: Uno]\nHola. [IMAGE: a] Mundo.",
        "[CHAPTER: Dos]\nMas texto. [MUSIC: mood=epic]",
    ]
    s = assemble_script(chapters)
    assert s.count("[CHAPTER:") == 2
    assert "[IMAGE: a]" in s and "[MUSIC: mood=epic]" in s
    assert "\n\n" in s
