"""Cinematic post-process pack for the Xianxia Studio render pipeline.

This module owns the **universal post-process FFmpeg pass** that runs after
the visual render — regardless of whether the render came from HyperFrames
(primary path: HTML/CSS/GSAP composition) or MoviePy (fallback path).

Compositional effects (Ken Burns, crossfades, chapter title cards, lower
thirds, animated overlays) are NOT here — those live as HTML/CSS/GSAP in
the HyperFrames templates, where they belong. This file is strictly:

  - cinematic_look_filters()       — color grade + sharpen + vignette + grain
  - music_ducking_filter_complex() — sidechain compression (audio domain)
  - build_video_filter_chain()     — composes the universal post-pass

NVENC handles all this in a single pass at ~+5% over the base encode.

The default visual style follows DESIGN.md "Celestial Dark":
  - Slight teal-orange split (warm highlights, cool shadows)
  - Mild contrast & saturation lift
  - 0.6-strength unsharp mask (preserves Z-Image-Turbo detail)
  - PI/5 vignette (gentle, never crushes edges)
  - 8/255 luma temporal+uniform noise (film-grain feel, not noisy)
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class EffectsConfig:
    """Tuneable knobs for the cinematic look. Defaults match DESIGN.md."""
    color_grade: bool = True
    sharpen: bool = True
    vignette: bool = True
    film_grain: bool = True
    contrast: float = 1.06
    saturation: float = 1.12
    gamma: float = 0.96
    sharpen_strength: float = 0.6
    vignette_angle: str = "PI/5"
    grain_amount: int = 8

    @classmethod
    def disabled(cls) -> "EffectsConfig":
        return cls(False, False, False, False)

    @classmethod
    def light(cls) -> "EffectsConfig":
        """Subtle pass for content where the source already looks great."""
        return cls(
            color_grade=True, sharpen=True, vignette=True, film_grain=False,
            contrast=1.03, saturation=1.05, gamma=0.98,
            sharpen_strength=0.4, vignette_angle="PI/6",
        )


def cinematic_look_filters(cfg: EffectsConfig | None = None) -> list[str]:
    """Return the list of ffmpeg -vf filters that compose the cinematic pass.

    Append these to your existing filter chain (after `crop` and before
    `subtitles=...` so subtitles render OVER the graded image).
    """
    cfg = cfg or EffectsConfig()
    parts: list[str] = []
    if cfg.color_grade:
        # v0.1.35: only contrast / saturation / gamma. Removed the teal-
        # orange colorbalance split that pushed warm shadows + cool
        # highlights — that grade gave EVERY video the same xianxia look
        # regardless of topic. Now the color stays faithful to whatever
        # the diffusion model produced for that scene.
        parts.append(
            f"eq=contrast={cfg.contrast}:saturation={cfg.saturation}:gamma={cfg.gamma}"
        )
    if cfg.sharpen:
        # 5x5 luma sharpen + 3x3 chroma — preserves DiT-generated detail
        parts.append(
            f"unsharp=5:5:{cfg.sharpen_strength}:3:3:{cfg.sharpen_strength * 0.5:.3f}"
        )
    if cfg.vignette:
        parts.append(f"vignette={cfg.vignette_angle}")
    if cfg.film_grain:
        # `t+u` = temporal (changes per frame, more film-like) + uniform
        parts.append(f"noise=alls={cfg.grain_amount}:allf=t+u")
    return parts


def music_ducking_filter_complex(
    narration_idx: int,
    music_idx: int,
    out_label: str = "mixed",
    threshold: float = 0.04,
    ratio: float = 10.0,
    attack_ms: int = 20,
    release_ms: int = 350,
    music_volume: float = 0.32,
) -> str:
    """ffmpeg -filter_complex string that mixes a music track + narration with
    sidechain compression (music ducks when narration speaks).

    The narration is unaffected; only the music's gain follows the inverse
    of the narration envelope. This lets the music sit at a fuller mix
    when there's no speech without ever drowning the voice.
    """
    return (
        f"[{music_idx}:a]volume={music_volume},asplit=2[m1][m_pad];"
        f"[{narration_idx}:a]asplit=2[n1][n2];"
        f"[m1][n1]sidechaincompress="
        f"threshold={threshold}:ratio={ratio}:attack={attack_ms}:release={release_ms}"
        f":makeup=1.0[duck];"
        f"[duck][n2]amix=inputs=2:duration=first:dropout_transition=0[{out_label}]"
    )


def build_video_filter_chain(
    *,
    pre_filters: list[str] | None = None,
    cinematic: EffectsConfig | None = None,
    subtitles_filename: str | None = None,
) -> str:
    """Build the complete -vf string for ffmpeg in the recommended order:

      pre_filters (e.g. crop + scale)
        → cinematic look (grading, sharpen, vignette, grain)
          → subtitles burn-in

    Chapter cards / lower thirds / animated overlays are NOT applied here —
    those are baked into the HyperFrames composition (HTML+GSAP) before the
    video reaches FFmpeg. This keeps the post-pass purely about colour /
    grain / vignette so it never fights the compositional layer.
    """
    chain: list[str] = []
    if pre_filters:
        chain.extend(pre_filters)

    chain.extend(cinematic_look_filters(cinematic))

    if subtitles_filename:
        chain.append(f"subtitles={subtitles_filename}:fontsdir=.")

    return ",".join(chain) if chain else "null"
