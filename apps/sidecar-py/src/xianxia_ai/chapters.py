"""Pure helpers for long-form chapter generation (no network, no LLM).

Kept import-free of FastAPI/httpx so it is unit-testable in isolation,
mirroring how effects/seo logic is split from the routers.
"""
from __future__ import annotations

import json
import re


def chapter_count_for(minutes: int) -> int:
    """Same rule as the legacy [CHAPTER:] marker guidance: ~minutes/2,
    clamped to [3, 6]."""
    return max(3, min(6, round(minutes / 2)))


_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.IGNORECASE)


def parse_outline(raw: str) -> list[dict]:
    """Parse the planner LLM output into a validated chapter list.

    Raises ValueError on anything we cannot trust (no JSON, no chapters,
    missing keys) so the caller can fall back to the v0.1.38 multi-pass.
    """
    text = _FENCE.sub("", raw.strip())
    brace = text.find("{")
    if brace > 0:
        text = text[brace:]
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(f"outline is not valid JSON: {e}") from e
    chapters = data.get("chapters")
    if not isinstance(chapters, list) or not chapters:
        raise ValueError("outline has no chapters")
    out: list[dict] = []
    for i, ch in enumerate(chapters):
        if not isinstance(ch, dict) or not ch.get("title"):
            raise ValueError(f"chapter {i} missing title")
        out.append({
            "index": int(ch.get("index", i + 1)),
            "title": str(ch["title"]).strip(),
            "synopsis": str(ch.get("synopsis", "")).strip(),
            "target_words": int(ch.get("target_words", 0)) or 0,
            "beats": [str(b) for b in ch.get("beats", []) if str(b).strip()],
        })
    return out


def assemble_script(chapter_texts: list[str]) -> str:
    """Join chapters with the same blank-line separator the legacy
    multi-pass used, so parse_markers() never merges sentences across a
    chapter boundary."""
    return "\n\n".join(t.strip() for t in chapter_texts if t.strip())


def expected_crossfade_duration(seg_seconds: list[float], xfade: float) -> float:
    """Total duration after chaining N segments with `xfade` s crossfade
    on each of the N-1 joins."""
    if not seg_seconds:
        return 0.0
    return sum(seg_seconds) - xfade * (len(seg_seconds) - 1)
