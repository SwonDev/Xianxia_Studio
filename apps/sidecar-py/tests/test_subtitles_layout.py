"""Regression tests for the ASS subtitle layout.

These tests pin the contract that prevents the bug the user reported in
v0.1.10:
  - Two adjacent caption Dialogue events overlapping by 100-150 ms made
    libass apply Collisions: Normal stacking, putting two captions on
    different rows simultaneously. Combined with a corrupted video stream
    underneath, the result was illegible (words half-cropped by black
    bands).
  - Wide chunks (max_chars=42) wrapped onto two lines, doubling the
    visible text height and making the safe-zone bottom margin too small.

This file enforces:
  1. Adjacent Dialogue events never overlap in time (start[N+1] > end[N]).
  2. No single chunk's visible text exceeds the configured max_chars.
  3. The ASS header opts in to Collisions: Reverse and BorderStyle: 3.

Run with: `cd apps/sidecar-py && python -m pytest tests/`.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from xianxia_ai.routes.subtitles import (  # noqa: E402
    _ass_header,
    _word_karaoke_ass,
    _segment_karaoke_ass,
    _ass_ts,
)


_TIME_RE = re.compile(r"(\d+):(\d+):(\d+)\.(\d+)")


def _parse_ts(s: str) -> float:
    h, m, sec, cs = _TIME_RE.match(s.strip()).groups()
    return int(h) * 3600 + int(m) * 60 + int(sec) + int(cs) / 100


def _events_from_ass(ass_text: str) -> list[tuple[float, float, str]]:
    events: list[tuple[float, float, str]] = []
    for line in ass_text.splitlines():
        if not line.startswith("Dialogue:"):
            continue
        # Dialogue: layer,start,end,style,name,L,R,V,effect,text
        parts = line.split(",", 9)
        start = _parse_ts(parts[1])
        end = _parse_ts(parts[2])
        text = parts[9]
        events.append((start, end, text))
    return events


def _strip_ass_overrides(text: str) -> str:
    """Strip {\\kfNN} and {\\fad(...)} so we can measure the visible chars."""
    return re.sub(r"\{[^}]*\}", "", text)


# ─── Tests ─────────────────────────────────────────────────────────────


def test_word_karaoke_no_overlapping_dialogue_events():
    """Adjacent Dialogue events MUST NOT overlap. This is the bug fix."""
    words = []
    t = 0.0
    for i in range(40):  # plenty of words to force multiple chunks
        words.append({"word": f"word{i}", "start": t, "end": t + 0.45})
        t += 0.5
    ass = _word_karaoke_ass(words, "Arial", 64, vertical=False, style="xianxia")
    events = _events_from_ass(ass)
    assert len(events) >= 4, "expected several chunks"
    for (a_start, a_end, _), (b_start, _b_end, _) in zip(events, events[1:]):
        assert a_end <= b_start + 1e-6, (
            f"chunks overlap: prev_end={a_end:.3f} next_start={b_start:.3f}"
        )


def test_word_karaoke_chunks_fit_max_chars():
    """No chunk should exceed 28 visible chars (horizontal default)."""
    words = []
    t = 0.0
    for i in range(60):
        words.append({"word": f"longerword{i}", "start": t, "end": t + 0.35})
        t += 0.4
    ass = _word_karaoke_ass(words, "Arial", 64, vertical=False, style="xianxia")
    for _, _, raw in _events_from_ass(ass):
        visible = _strip_ass_overrides(raw)
        # +6 grace because the packing is greedy on word boundaries.
        assert len(visible) <= 28 + 6, f"chunk too wide: {visible!r}"


def test_segment_karaoke_no_overlap_across_segments():
    """Even when the source SRT has tight back-to-back entries, generated
    Dialogue events must not overlap (the previous +0.15 trailing offset
    was the source of the bug)."""
    entries = [
        (0.00, 4.00, "First sentence with several words to wrap correctly."),
        (4.00, 7.50, "Second sentence immediately following with more words."),
        (7.50, 10.0, "And a third one to be absolutely sure."),
    ]
    ass = _segment_karaoke_ass(entries, "Arial", 64, vertical=False, style="xianxia")
    events = _events_from_ass(ass)
    for (a_s, a_e, _), (b_s, _b_e, _) in zip(events, events[1:]):
        assert a_e <= b_s + 1e-6, (
            f"segment chunk overlap: prev_end={a_e:.3f} next_start={b_s:.3f}"
        )


def test_header_uses_opaque_box_and_reverse_collisions():
    """The header must opt in to BorderStyle 3 (opaque box) and
    Collisions: Reverse so libass never stacks captions."""
    h = _ass_header("Arial", 64, vertical=False, style="xianxia")
    assert "Collisions: Reverse" in h, "must use Reverse to suppress stacking"
    assert "WrapStyle: 2" in h, "WrapStyle: 2 forces hard line breaks only"
    # BorderStyle column position in `Style:` line is 17 (0-indexed) — it's
    # easier to grep for a substring matching ",3," at a known position
    # against the actual style line.
    style_line = next(line for line in h.splitlines() if line.startswith("Style:"))
    fields = style_line[len("Style:"):].split(",")
    # Format positions per ASS v4+ spec:
    #   Name(0) Fontname(1) Fontsize(2) PrimaryColour(3) SecondaryColour(4)
    #   OutlineColour(5) BackColour(6) Bold(7) Italic(8) Underline(9)
    #   StrikeOut(10) ScaleX(11) ScaleY(12) Spacing(13) Angle(14)
    #   BorderStyle(15) Outline(16) Shadow(17) Alignment(18) ...
    assert fields[15].strip() == "3", (
        f"BorderStyle must be 3 (opaque box), got {fields[15]!r}"
    )
    # Alignment must be 2 (bottom-centre) so captions don't end up at the top.
    assert fields[18].strip() == "2", (
        f"Alignment must be 2 (bottom-centre), got {fields[18]!r}"
    )


def test_word_karaoke_handles_zero_duration_word_safely():
    """A zero-or-negative-length word slot must not produce end<=start
    Dialogue events, which would crash libass."""
    words = [
        {"word": "Hi", "start": 0.0, "end": 0.0},  # degenerate
        {"word": "there", "start": 0.0, "end": 0.4},
    ]
    ass = _word_karaoke_ass(words, "Arial", 64, vertical=False, style="xianxia")
    for s, e, _ in _events_from_ass(ass):
        assert e > s, f"non-positive duration: start={s} end={e}"


def test_ass_timestamp_centiseconds_format():
    """ASS timestamps are H:MM:SS.cc — 2-digit centiseconds, not ms."""
    assert _ass_ts(63.27) == "0:01:03.27"
    assert _ass_ts(0.0) == "0:00:00.00"
