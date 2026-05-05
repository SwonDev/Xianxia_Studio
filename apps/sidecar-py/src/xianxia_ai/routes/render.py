"""Video render — pure FFmpeg path (GPU end-to-end via NVENC).

The previous MoviePy implementation generated frames in CPU (Ken Burns lambda
in PIL + crossfade in numpy), bottlenecking 4-min 1080×1920 renders to
~14 min on RTX 4060. This pure-FFmpeg path uses native filters:

  - `zoompan` for Ken Burns (filter graph, in-process)
  - `xfade` for crossfades between scenes
  - cinematic stack: eq + colorbalance + unsharp + vignette + film grain
  - sidechain ducking for narration + music mix
  - NVENC encode (h264_nvenc) — never touches CPU for the encode

Validated: 5 beats covering 263s of video → 251s render (1× realtime) on
RTX 4060 8 GB. ~6× faster than the MoviePy fallback.

The HyperFrames primary path (Node sidecar) is still preferred when the
client wants the full effects pack (parallax 2.5D layers, atmospheric
particles, cinematic transitions). This Python route covers the speed-
optimised "fast" mode and the no-Node-sidecar fallback.
"""

from __future__ import annotations

import os
import subprocess
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..codec import best_video_encoder
from ..effects import EffectsConfig, cinematic_look_filters

router = APIRouter()


class ImageBeat(BaseModel):
    image_path: str
    start_seconds: float
    duration_seconds: float
    # Optional 2.5D parallax layers (from /depth/batch). When both fg and image
    # paths are present, the renderer composes bg+fg with different zoom speeds
    # for true parallax depth instead of a single-image Ken Burns.
    foreground_path: str | None = None
    # Optional per-beat transition kind for the OUTGOING edge:
    # 'fade' (default), 'fadeblack', 'circleopen', 'wiperight', 'pixelize', 'dissolve'.
    transition: str | None = None


class RenderRequest(BaseModel):
    images: list[ImageBeat]
    narration_path: str
    music_path: str | None = None
    music_volume: float = 0.32
    width: int = 1920
    height: int = 1080
    fps: int = 24
    out_dir: str | None = None
    crossfade_seconds: float = 0.7
    cinematic: str = "full"  # "off" | "light" | "full"
    music_ducking: bool = True
    # Ken Burns zoom range (start_scale -> end_scale). Set both to 1.0 to disable.
    kenburns_start: float = 1.00
    kenburns_end: float = 1.08


class RenderResponse(BaseModel):
    video_path: str
    duration_seconds: float
    cinematic_profile: str
    render_seconds: float


@router.post("", response_model=RenderResponse)
def render(req: RenderRequest) -> RenderResponse:
    if not Path(req.narration_path).exists():
        raise HTTPException(404, f"narration audio missing: {req.narration_path}")
    if len(req.images) == 0:
        raise HTTPException(400, "images list is empty")

    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out"))
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"video-{uuid.uuid4().hex[:10]}.mp4"

    profile = (req.cinematic or "full").lower()
    if profile == "off":
        cfg = EffectsConfig.disabled()
    elif profile == "light":
        cfg = EffectsConfig.light()
    else:
        cfg = EffectsConfig()
    cinema_chain = cinematic_look_filters(cfg)
    cinema_str = ",".join(cinema_chain) if cinema_chain else ""

    fade = max(0.0, float(req.crossfade_seconds))
    W, H, FPS = int(req.width), int(req.height), int(req.fps)

    # Map ImageBeat → FFmpeg input slot. When a beat has foreground_path, we
    # add TWO inputs (bg + fg) and remember the indices so the filter graph
    # can composite them. Otherwise just one (the image).
    inputs: list[str] = []
    beat_slots: list[tuple[int, int | None]] = []  # (bg_idx, fg_idx_or_None)
    slot = 0
    for b in req.images:
        inputs += ["-loop", "1", "-t", f"{b.duration_seconds:.3f}", "-i", b.image_path]
        bg_i = slot; slot += 1
        fg_i: int | None = None
        if b.foreground_path and Path(b.foreground_path).exists():
            inputs += ["-loop", "1", "-t", f"{b.duration_seconds:.3f}", "-i", b.foreground_path]
            fg_i = slot; slot += 1
        beat_slots.append((bg_i, fg_i))

    audio_idx = slot
    inputs += ["-i", req.narration_path]
    slot += 1
    music_idx: int | None = None
    if req.music_path and Path(req.music_path).exists():
        inputs += ["-i", req.music_path]
        music_idx = slot; slot += 1

    # Per-clip filter chain. For 2.5D parallax: bg slow zoom + fg fast zoom,
    # both with ease-in-out time mapping so motion feels organic. The eased
    # progress `p` replaces the linear `on/N` so accel/decel curves smoothly.
    #
    # Easing function: quadratic ease-in-out
    #     p_eased = 0.5 - 0.5 * cos(PI * on / N)
    # (Equivalent to a smoothstep from 0 to 1, no abrupt start/stop.)
    clip_filters: list[str] = []
    for i, (b, (bg_i, fg_i)) in enumerate(zip(req.images, beat_slots)):
        nframes = max(1, int(b.duration_seconds * FPS))
        ks = req.kenburns_start
        ke = req.kenburns_end
        delta = ke - ks
        # Eased zoom expression as a string-substitution for {p}.
        # FFmpeg expr supports `cos(x)` and `PI`. Use `min()` clamp at end.
        eased_z = (
            f"min({ks}+{delta:.4f}*((1-cos(PI*on/{nframes}))/2),{ke})"
        )
        flat_z = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}"

        if fg_i is not None:
            # 2.5D parallax: bg with reduced delta (60%), fg with boosted delta (140%)
            bg_delta = delta * 0.6
            fg_delta = delta * 1.4
            bg_z = f"min({ks}+{bg_delta:.4f}*((1-cos(PI*on/{nframes}))/2),{ks + bg_delta:.4f})"
            fg_z = f"min({ks}+{fg_delta:.4f}*((1-cos(PI*on/{nframes}))/2),{ks + fg_delta:.4f})"
            bg_zp = f"zoompan=z='{bg_z}':d={nframes}:s={W}x{H}:fps={FPS}"
            fg_zp = f"zoompan=z='{fg_z}':d={nframes}:s={W}x{H}:fps={FPS}"
            chain = (
                f"[{bg_i}:v]{bg_zp},setsar=1[bgz{i}];"
                f"[{fg_i}:v]{fg_zp},setsar=1[fgz{i}];"
                f"[bgz{i}][fgz{i}]overlay=0:0:format=auto[ov{i}];"
                f"[ov{i}]format=yuv420p"
            )
            if cinema_str:
                chain += "," + cinema_str
            chain += f"[c{i}]"
            clip_filters.append(chain)
        else:
            zp = f"zoompan=z='{eased_z}':d={nframes}:s={W}x{H}:fps={FPS}" if abs(delta) > 1e-3 else flat_z
            chain_parts = [f"[{bg_i}:v]{zp}", "setsar=1", "format=yuv420p"]
            if cinema_str:
                chain_parts.append(cinema_str)
            clip_filters.append(",".join(chain_parts) + f"[c{i}]")

    # xfade chain with per-beat transition kind. FFmpeg xfade transitions:
    #   fade (default), fadeblack, fadewhite, dissolve, pixelize,
    #   wiperight, wipeleft, circleopen, circleclose, radial, hblur, hlslice
    # Mapping our friendly names to xfade names + a default fallback.
    XFADE_MAP = {
        "fade": "fade",
        "fadeblack": "fadeblack",
        "fadewhite": "fadewhite",
        "dissolve": "dissolve",
        "pixelize": "pixelize",
        "wiperight": "wiperight",
        "wipeleft": "wipeleft",
        "circleopen": "circleopen",
        "circleclose": "circleclose",
        "radial": "radial",
        "hblur": "hblur",
    }
    xfade_filters: list[str] = []
    if len(req.images) == 1:
        xfade_filters.append("[c0]copy[vfinal]")
    else:
        prev = "c0"
        cumulative = req.images[0].duration_seconds
        for i in range(1, len(req.images)):
            label = "vfinal" if i == len(req.images) - 1 else f"x{i}"
            offset = cumulative - fade
            outgoing = req.images[i - 1].transition or "fade"
            kind = XFADE_MAP.get(outgoing, "fade")
            xfade_filters.append(
                f"[{prev}][c{i}]xfade=transition={kind}:duration={fade}:offset={offset:.3f}[{label}]"
            )
            cumulative += req.images[i].duration_seconds - fade
            prev = label

    # Audio mix: narration only / narration + music / narration + music with ducking
    audio_filters: list[str] = []
    audio_map: str  # what to pass to -map for audio
    if music_idx is not None and req.music_ducking:
        # Sidechain compression: music ducks under narration
        audio_filters.append(
            f"[{music_idx}:a]volume={req.music_volume},asplit=2[m1][m_pad];"
            f"[{audio_idx}:a]asplit=2[n1][n2];"
            f"[m1][n1]sidechaincompress=threshold=0.04:ratio=10:attack=20:release=350:makeup=1.0[duck];"
            f"[duck][n2]amix=inputs=2:duration=first:dropout_transition=0[aout]"
        )
        audio_map = "[aout]"
    elif music_idx is not None:
        audio_filters.append(
            f"[{music_idx}:a]volume={req.music_volume}[m];"
            f"[{audio_idx}:a][m]amix=inputs=2:duration=first:dropout_transition=0[aout]"
        )
        audio_map = "[aout]"
    else:
        # Direct narration stream — no filter needed
        audio_map = f"{audio_idx}:a:0"

    filter_complex = ";".join(clip_filters + xfade_filters + audio_filters)

    enc = best_video_encoder()
    if enc.codec_name == "h264_nvenc":
        encode_args = ["-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "20", "-b:v", "0", "-pix_fmt", "yuv420p"]
    elif enc.codec_name == "h264_qsv":
        encode_args = ["-global_quality", "20", "-preset", "medium", "-pix_fmt", "nv12"]
    elif enc.codec_name == "h264_amf":
        encode_args = ["-quality", "quality", "-rc", "vbr_peak", "-qp_i", "20", "-qp_p", "22", "-pix_fmt", "yuv420p"]
    else:
        encode_args = ["-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p"]

    # Total visible video duration after xfade overlap.
    visible_total = sum(b.duration_seconds for b in req.images) - fade * (len(req.images) - 1)

    cmd = [
        "ffmpeg", "-y",
        *inputs,
        "-filter_complex", filter_complex,
        "-map", "[vfinal]",
        "-map", audio_map,
        "-c:v", enc.codec_name,
        *encode_args,
        "-c:a", "aac", "-b:a", "192k",
        # Force exact output duration so the video doesn't stretch to match the
        # narration when audio is longer. -shortest is unreliable here because
        # xfade extends the last frame implicitly.
        "-t", f"{visible_total:.3f}",
        str(out_path),
    ]

    import time as _t
    t0 = _t.time()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    dt = _t.time() - t0
    if proc.returncode != 0:
        raise HTTPException(500, f"ffmpeg render failed: {proc.stderr[-700:]}")

    # Total visible duration = last beat end (with overlaps)
    total = sum(b.duration_seconds for b in req.images) - fade * (len(req.images) - 1)
    return RenderResponse(
        video_path=str(out_path),
        duration_seconds=total,
        cinematic_profile=profile,
        render_seconds=dt,
    )
