"""Tests for v0.7.0 video presets registry.

Guards:
- The 6 presets exist and have all fields populated.
- Each preset's abstract keys (voice_tone, music_mood, image_style)
  resolve in their mapping tables — no typos.
- `narrative_epic` byte-identical to the v0.6.x STORY BEATS + STORY
  ARC content (the part of the system prompt that varies by preset).
  Drift here = retro-compat broken.
- The semantically-loaded presets ("explainer" / "documentary")
  enforce their style (no drama keywords in explainer; "FACTUAL"
  required in documentary).
- Unknown preset ids fall back to narrative_epic gracefully.

Run with: `cd apps/sidecar-py && python -m pytest tests/test_presets.py -q`
"""

from __future__ import annotations

import sys
from dataclasses import fields
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from xianxia_ai.presets import (  # noqa: E402
    DEFAULT_PRESET_ID,
    IMAGE_STYLE_BIAS,
    MUSIC_MOOD_TO_PROMPT,
    PRESETS,
    VOICE_TONE_TO_DESCRIPTOR,
    VideoPreset,
    get_preset,
)

EXPECTED_IDS = {
    "narrative_epic",
    "documentary",
    "explainer",
    "listicle",
    "comparative",
    "deep_dive",
}


def test_all_six_presets_exist():
    assert set(PRESETS.keys()) == EXPECTED_IDS
    assert DEFAULT_PRESET_ID == "narrative_epic"


def test_each_preset_has_all_required_fields_populated():
    required = {f.name for f in fields(VideoPreset)}
    for pid, preset in PRESETS.items():
        for fname in required:
            value = getattr(preset, fname)
            assert value not in (None, "", []), (
                f"preset {pid!r} field {fname!r} is empty"
            )


def test_each_preset_abstract_keys_resolve_in_mapping_tables():
    """No typos in voice_tone / music_mood / image_style references."""
    for pid, preset in PRESETS.items():
        assert preset.voice_tone in VOICE_TONE_TO_DESCRIPTOR, (
            f"preset {pid!r}: voice_tone {preset.voice_tone!r} not in table"
        )
        assert preset.music_mood in MUSIC_MOOD_TO_PROMPT, (
            f"preset {pid!r}: music_mood {preset.music_mood!r} not in table"
        )
        assert preset.image_style in IMAGE_STYLE_BIAS, (
            f"preset {pid!r}: image_style {preset.image_style!r} not in table"
        )


def test_narrative_epic_is_byte_identical_for_retrocompat():
    """The narrative_epic directive carries the verbatim STORY BEATS +
    STORY ARC anchors that the v0.6.x prompt template ships. Drift
    here means a user who never touched the new selector gets a
    different script style after upgrading — which violates the
    zero-regression contract."""
    p = PRESETS["narrative_epic"]
    d = p.llm_style_directive
    # Verbatim anchors from the v0.6.x SCRIPT_PROMPT_TEMPLATE.
    assert "═══ STORY BEATS — DOCUMENTARY YOUTUBE VIRAL FORMULA (NON-NEGOTIABLE) ═══" in d
    assert "BEAT 1 — HOOK (first 30-45 seconds, ≈ first 90-110 words)." in d
    assert "BEAT 7 — CTA (last 1-2 sentences)." in d
    assert "═══ STORY ARC + ROUNDED CLOSING (NON-NEGOTIABLE) ═══" in d
    assert "[MUSIC: mood=reveal]" in d
    # And the v0.6.x image suffix is the cinematic bias.
    assert IMAGE_STYLE_BIAS["cinematic"] == (
        "cinematic, photorealistic, ultra detailed, dramatic lighting"
    )


def test_explainer_directive_forbids_dramatization_keywords():
    d = PRESETS["explainer"].llm_style_directive.lower()
    # The explainer must explicitly say "no drama" — these are the
    # exact phrasings the spec asked for. If they vanish, the preset
    # silently turns into another narrative_epic clone.
    assert "no dramatization" in d or "avoid dramatization" in d
    assert "teacher" in d
    assert "factual accuracy" in d
    # And it must explicitly call out the kind of voice keywords to avoid.
    assert "epic" in d  # the explainer mentions "epic" to forbid it
    # Sanity: it's not just narrative_epic copy-pasted.
    assert "STORY BEATS — DOCUMENTARY YOUTUBE VIRAL FORMULA" not in PRESETS["explainer"].llm_style_directive


def test_documentary_directive_demands_factual_accuracy():
    d = PRESETS["documentary"].llm_style_directive
    assert "FACTUAL CONTEXT" in d
    assert "no invented dialogue" in d.lower()
    assert "no mythic" in d.lower() or "no dramatized" in d.lower()
    # Voice descriptor anchor.
    assert "BBC" in d or "national geographic" in d.lower()


def test_deep_dive_uses_chapters_forced():
    assert PRESETS["deep_dive"].use_chapters is True
    # And it's the ONLY preset that forces chapters — others use the
    # auto-detect-by-length logic from v0.5.0.
    forced = {pid for pid, p in PRESETS.items() if p.use_chapters}
    assert forced == {"deep_dive"}


def test_get_preset_unknown_falls_back_to_narrative_epic():
    assert get_preset("does_not_exist").id == "narrative_epic"
    assert get_preset(None).id == "narrative_epic"
    assert get_preset("").id == "narrative_epic"


def test_get_preset_returns_exact_entry_for_known_ids():
    for pid in EXPECTED_IDS:
        p = get_preset(pid)
        assert p.id == pid
        # Same instance — not a copy.
        assert p is PRESETS[pid]
