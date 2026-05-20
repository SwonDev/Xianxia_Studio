"""Tests for v0.6.5 deterministic image-subject diversification.

These guard the chronic "muchas imágenes iguales" regression: for a
single-subject / abstract topic the per-beat distiller stays faithful to
the narration and therefore repeats the SAME headline subject every
shot. `_enforce_subject_diversity` must pivot the over-repeated beats to
distinct concrete facets mined (no LLM) from the Wikipedia brief +
setting tag.

Run with: `cd apps/sidecar-py && python -m pytest tests/test_subject_diversity.py`
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from xianxia_ai.routes.script import (  # noqa: E402
    _facet_pool,
    _enforce_subject_diversity,
    _extract_subject_keywords,
    _jaccard,
    _style_anchor,
)

# A realistic "black holes" brief + setting tag — the exact failure the
# user reported (9/12 near-identical black-hole spirals).
BRIEF = (
    "A black hole is a region of spacetime where gravity is so strong "
    "that nothing can escape. Albert Einstein predicted them with "
    "General Relativity. The Event Horizon Telescope imaged the core of "
    "Messier 87. Cygnus X-1 was the first strong black hole candidate. "
    "Stephen Hawking proposed Hawking Radiation. Sagittarius A star sits "
    "at the centre of the Milky Way."
)
SETTING = (
    "Astrophysics documentary setting (deep indigo and starlight, "
    "accretion disks, gravitational lensing, neutron stars, observatory domes)"
)


def test_facet_pool_extracts_distinct_concrete_facets():
    pool = _facet_pool(BRIEF, SETTING, topic="black holes")
    low = [p.lower() for p in pool]
    # Proper-noun facets from the brief.
    assert any("einstein" in p for p in low)
    assert any("cygnus" in p for p in low)
    assert any("hawking" in p for p in low)
    # Iconography facets from the setting parenthetical.
    assert any("lensing" in p or "accretion" in p or "observatory" in p
               for p in low)
    # The over-used topic head must NOT be a facet (that is the subject
    # we are escaping FROM).
    assert "black holes" not in low
    assert "black hole" not in low
    # De-duplicated, bounded.
    assert len(pool) == len(set(low))
    assert len(pool) <= 24


def test_empty_pool_is_a_noop():
    phrases = ["a black hole swirling", "a black hole swirling again"]
    assert _enforce_subject_diversity(phrases, []) == phrases


def test_repeated_subject_gets_pivoted_to_facets():
    # 8 beats that all distil to the same subject (the real bug).
    phrases = [
        "a swirling black hole accretion disk in deep space",
    ] * 8
    pool = _facet_pool(BRIEF, SETTING, topic="black holes")
    out = _enforce_subject_diversity(phrases, pool, window=4, thresh=0.55)

    # Same length, never drops a beat.
    assert len(out) == len(phrases)
    # The first beat is the reference and is kept as-is.
    assert out[0] == phrases[0]
    # The later identical beats MUST have been rewritten (a facet was
    # prepended as the leading CLIP subject -> "Facet: original").
    rewritten = [i for i, p in enumerate(out) if p != phrases[i]]
    assert len(rewritten) >= 5, (out, rewritten)
    for i in rewritten:
        assert ":" in out[i]
        facet = out[i].split(":", 1)[0]
        assert facet.lower() in {p.lower() for p in pool}

    # Net effect: average pairwise subject similarity drops materially.
    def avg_sim(seq: list[str]) -> float:
        ks = [_extract_subject_keywords(s) for s in seq]
        pairs = [
            _jaccard(ks[i], ks[j])
            for i in range(len(ks)) for j in range(i + 1, len(ks))
        ]
        return sum(pairs) / len(pairs) if pairs else 0.0

    assert avg_sim(out) < avg_sim(phrases)


def test_style_anchor_rejects_iconography_in_first_segment():
    """v0.6.8 — the real "Norse mythology" failure: Gemma dumped a
    concrete object in what should have been palette, so the prefix
    "burning world-tree" got stamped on every image → 8/15 frames were
    the same burning tree even though the LLM markers were diverse."""
    tag = (
        "Norse mythology setting (burning world-tree, ash-grey palette, "
        "ember sparks)"
    )
    out = _style_anchor(tag).lower()
    # The whole first-segment must be dropped because it contains a
    # concrete-object noun.
    assert "world-tree" not in out
    assert "tree" not in out
    assert "burning" not in out
    # The era/culture head still survives (anti-drift anchor intact).
    assert out.startswith("norse mythology setting")


def test_style_anchor_keeps_clean_palette():
    """A first-segment that is genuinely a colour palette (no concrete
    objects) must survive — we don't want to lose colour cohesion."""
    tag = (
        "Ancient Greek classical mythic setting (deep ultramarine and gold, "
        "marble temples, olive groves, thunderbolts)"
    )
    out = _style_anchor(tag).lower()
    assert "deep ultramarine and gold" in out
    # Iconography after the first comma is still dropped by the existing
    # split — palette segment is the only piece kept.
    assert "temple" not in out
    assert "thunderbolt" not in out


def test_genuinely_varied_input_is_left_alone():
    # When the distiller already produced distinct subjects, enforcement
    # must NOT meddle (no false positives -> no lost fidelity).
    phrases = [
        "Albert Einstein writing equations at a chalkboard",
        "the Event Horizon Telescope array under a night sky",
        "a star being torn apart by tidal forces",
        "an observatory dome opening at dusk",
    ]
    pool = _facet_pool(BRIEF, SETTING, topic="black holes")
    out = _enforce_subject_diversity(phrases, pool, window=4, thresh=0.55)
    assert out == phrases
