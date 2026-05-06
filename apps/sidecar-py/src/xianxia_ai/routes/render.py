"""Video render — pure FFmpeg path (GPU end-to-end via NVENC).

Cinematic camera-motion playbook (FFmpeg wiki + NVENC SDK):

1. **2x canvas upscale before zoompan, lanczos downscale at the end.**
   `zoompan` rounds x/y/zoom to integer pixels per output frame. Doing the
   math on a 2x canvas turns 1-pixel stairsteps into sub-pixel shimmer that
   the encoder absorbs. Eliminates the "entrecortado" jitter in slow zooms.

2. **60 fps native render.** Cheaper than `minterpolate` and produces zero
   warping artifacts on still images. Steadicam-fluid out of the box.

3. **Eased zoom curve** `(1-cos(π·on/N))/2` for organic accel/decel — same
   curve a Steadicam operator would produce. `on` is the output frame
   counter (per-frame eval, not per-cycle).

4. **Subtle horizontal sway** `30*sin(on/120·π)` on top of zoom — what reads
   as "Steadicam handheld" instead of "tripod zoom".

5. **NVENC p7 + tune hq + spatial-aq + temporal-aq + bf 4 + rc-lookahead 32**
   — NVIDIA's "highest quality" preset for slow cinematic motion. AQ shines
   on low-motion footage with detail. ~3-5 % bigger files than p5 but
   visibly cleaner.

6. **EBU R128 loudnorm -14 LUFS** mastering — TikTok / Reels / YouTube standard.
   Plus `sidechaincompress` ratio 8:1 attack 20 / release 400 for dynamic
   ducking that follows speech rhythm.
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
    foreground_path: str | None = None
    transition: str | None = None


class RenderRequest(BaseModel):
    images: list[ImageBeat]
    narration_path: str
    music_path: str | None = None
    music_volume: float = 0.32
    width: int = 1920
    height: int = 1080
    # Render at 60 fps natively for Steadicam-fluid motion. Output stays 60 fps;
    # the encoder is told this is high-quality content so AQ kicks in.
    fps: int = 60
    out_dir: str | None = None
    crossfade_seconds: float = 0.7
    cinematic: str = "full"
    music_ducking: bool = True
    kenburns_start: float = 1.00
    kenburns_end: float = 1.12
    # New: subtle horizontal "handheld" sway in pixels (canvas-relative).
    # 30 px on a 2x canvas == 15 px on output → reads as a real operator.
    handheld_sway_px: float = 30.0
    # New: master loudness target. -14 LUFS is the de-facto standard for
    # TikTok/Reels/YouTube. Use -16 for podcasts, -23 for broadcast.
    loudness_lufs: float = -14.0


class RenderResponse(BaseModel):
    video_path: str
    duration_seconds: float
    cinematic_profile: str
    render_seconds: float


def _eased_z(start: float, end: float, nframes: int) -> str:
    """Cosine-eased zoom expression for FFmpeg zoompan."""
    delta = end - start
    return f"min({start}+{delta:.4f}*((1-cos(PI*on/{nframes}))/2),{end:.4f})"


def _eased_z_with_sway(
    start: float, end: float, nframes: int, sway_px: float
) -> tuple[str, str, str]:
    """Returns (z_expr, x_expr, y_expr) with subtle handheld sway."""
    z = _eased_z(start, end, nframes)
    # Centre crop with a sinusoidal horizontal offset. Period ≈ 4 s at 60 fps.
    # Amplitude bounded so the subject never leaves the frame.
    sway = f"{sway_px:.1f}*sin(on/{int(nframes / 2)}*PI)"
    x = f"iw/2-iw/zoom/2+{sway}"
    y = "ih/2-ih/zoom/2"
    return z, x, y


# Above this many beats, render in chunks of CHUNK_SIZE and concat.
# Single-pass filter_complex with > ~12 inputs starts to hit FFmpeg parser
# limits and balloons RAM (every PNG is decoded + 2x canvas buffered).
MAX_SINGLE_PASS_BEATS = 12
CHUNK_SIZE = 8


@router.post("", response_model=RenderResponse)
def render(req: RenderRequest) -> RenderResponse:
    if not Path(req.narration_path).exists():
        raise HTTPException(404, f"narration audio missing: {req.narration_path}")
    if len(req.images) == 0:
        raise HTTPException(400, "images list is empty")

    # Long-form videos: render chunks separately, then concat with audio over the whole.
    # This keeps each filter_complex small and bounds RAM (only CHUNK_SIZE inputs loaded
    # at a time). Crossfades within chunks are preserved; chunk boundaries use a hard
    # cut (or short fade if the caller wants — added as `bridge_fade_seconds`).
    if len(req.images) > MAX_SINGLE_PASS_BEATS:
        return _render_chunked(req)

    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out"))
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"video-{uuid.uuid4().hex[:10]}.mp4"

    profile = (req.cinematic or "full").lower()
    cfg = (
        EffectsConfig.disabled() if profile == "off"
        else EffectsConfig.light() if profile == "light"
        else EffectsConfig()
    )
    cinema_chain = cinematic_look_filters(cfg)
    cinema_str = ",".join(cinema_chain) if cinema_chain else ""

    fade = max(0.0, float(req.crossfade_seconds))
    W, H, FPS = int(req.width), int(req.height), int(req.fps)

    # 2x canvas. The internal zoompan operates here — we only downscale at the end.
    CANVAS_W, CANVAS_H = W * 2, H * 2

    # Map ImageBeat → FFmpeg input slot.
    inputs: list[str] = []
    beat_slots: list[tuple[int, int | None]] = []
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

    # Per-clip filter chain.
    # Strategy:
    #   1. scale to 2x canvas with lanczos (anti-aliased upscale).
    #   2. zoompan with eased z + sinusoidal sway → motion happens at 2x resolution.
    #   3. (optional) overlay fg layer for parallax 2.5D.
    #   4. lanczos+full_chroma_int+accurate_rnd downscale to output dims.
    #   5. cinematic look chain (eq + colorbalance + unsharp + vignette + grain).
    #   6. format=yuv420p as last step.
    clip_filters: list[str] = []
    for i, (b, (bg_i, fg_i)) in enumerate(zip(req.images, beat_slots)):
        nframes = max(1, int(b.duration_seconds * FPS))
        ks, ke = req.kenburns_start, req.kenburns_end
        delta = ke - ks
        sway = req.handheld_sway_px

        if fg_i is not None:
            # 2.5D parallax: bg with reduced delta (60%), fg boosted (140%).
            bg_z, bg_x, bg_y = _eased_z_with_sway(ks, ks + delta * 0.6, nframes, sway * 0.5)
            fg_z, fg_x, fg_y = _eased_z_with_sway(ks, ks + delta * 1.4, nframes, sway)
            chain = (
                f"[{bg_i}:v]scale={CANVAS_W}:{CANVAS_H}:flags=lanczos,setsar=1,"
                f"zoompan=z='{bg_z}':x='{bg_x}':y='{bg_y}':d=1:s={CANVAS_W}x{CANVAS_H}:fps={FPS}[bgz{i}];"
                f"[{fg_i}:v]scale={CANVAS_W}:{CANVAS_H}:flags=lanczos,setsar=1,"
                f"zoompan=z='{fg_z}':x='{fg_x}':y='{fg_y}':d=1:s={CANVAS_W}x{CANVAS_H}:fps={FPS}[fgz{i}];"
                f"[bgz{i}][fgz{i}]overlay=0:0:format=auto:eof_action=pass[ov{i}];"
                f"[ov{i}]scale={W}:{H}:flags=lanczos+full_chroma_int+accurate_rnd"
            )
            if cinema_str:
                chain += "," + cinema_str
            chain += ",format=yuv420p" + f"[c{i}]"
            clip_filters.append(chain)
        else:
            if abs(delta) > 1e-3:
                z, x, y = _eased_z_with_sway(ks, ke, nframes, sway)
                zp = (
                    f"scale={CANVAS_W}:{CANVAS_H}:flags=lanczos,setsar=1,"
                    f"zoompan=z='{z}':x='{x}':y='{y}':d=1:s={CANVAS_W}x{CANVAS_H}:fps={FPS}"
                )
            else:
                zp = (
                    f"scale={CANVAS_W}:{CANVAS_H}:flags=lanczos,setsar=1,"
                    f"crop={CANVAS_W}:{CANVAS_H},fps={FPS}"
                )
            chain_parts = [
                f"[{bg_i}:v]{zp}",
                f"scale={W}:{H}:flags=lanczos+full_chroma_int+accurate_rnd",
            ]
            if cinema_str:
                chain_parts.append(cinema_str)
            chain_parts.append("format=yuv420p")
            clip_filters.append(",".join(chain_parts) + f"[c{i}]")

    # xfade chain.
    XFADE_MAP = {
        "fade": "fade", "fadeblack": "fadeblack", "fadewhite": "fadewhite",
        "dissolve": "dissolve", "pixelize": "pixelize",
        "wiperight": "wiperight", "wipeleft": "wipeleft",
        "circleopen": "circleopen", "circleclose": "circleclose",
        "radial": "radial", "hblur": "hblur", "smoothleft": "smoothleft",
        "smoothright": "smoothright", "diagtl": "diagtl", "diagbr": "diagbr",
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

    # Audio chain:
    #   1. Narration: raw stream.
    #   2. Music: volume scale + sidechaincompress duck driven by narration env.
    #   3. amix narration + ducked music.
    #   4. Master loudnorm to target LUFS (single-pass, EBU R128) on the mixed bus.
    audio_filters: list[str] = []
    audio_map: str
    lufs = req.loudness_lufs
    norm = f"loudnorm=I={lufs}:TP=-1.5:LRA=11"
    if music_idx is not None and req.music_ducking:
        audio_filters.append(
            f"[{music_idx}:a]volume={req.music_volume}[mvol];"
            f"[{audio_idx}:a]asplit=2[n1][n2];"
            f"[mvol][n1]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400:makeup=2[duck];"
            f"[duck][n2]amix=inputs=2:duration=first:dropout_transition=0.2,{norm}[aout]"
        )
        audio_map = "[aout]"
    elif music_idx is not None:
        audio_filters.append(
            f"[{music_idx}:a]volume={req.music_volume}[m];"
            f"[{audio_idx}:a][m]amix=inputs=2:duration=first:dropout_transition=0.2,{norm}[aout]"
        )
        audio_map = "[aout]"
    else:
        audio_filters.append(f"[{audio_idx}:a]{norm}[aout]")
        audio_map = "[aout]"

    filter_complex = ";".join(clip_filters + xfade_filters + audio_filters)

    enc = best_video_encoder()
    if enc.codec_name == "h264_nvenc":
        # p7 = highest quality preset; tune hq + spatial-aq + temporal-aq for
        # cinematic content with slow motion. bf=4 + rc-lookahead=32 give the
        # encoder more reference frames to allocate bits where the eye looks.
        encode_args = [
            "-preset", "p7", "-tune", "hq", "-rc", "vbr", "-cq", "18", "-b:v", "0",
            "-spatial-aq", "1", "-temporal-aq", "1", "-aq-strength", "8",
            "-bf", "4", "-rc-lookahead", "32", "-multipass", "fullres",
            "-b_ref_mode", "middle", "-pix_fmt", "yuv420p",
        ]
    elif enc.codec_name == "h264_qsv":
        encode_args = ["-global_quality", "18", "-preset", "veryslow", "-look_ahead", "1", "-pix_fmt", "nv12"]
    elif enc.codec_name == "h264_amf":
        encode_args = ["-quality", "quality", "-rc", "vbr_peak", "-qp_i", "18", "-qp_p", "20", "-pix_fmt", "yuv420p"]
    else:
        encode_args = ["-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p"]

    visible_total = sum(b.duration_seconds for b in req.images) - fade * (len(req.images) - 1)

    cmd = [
        "ffmpeg", "-y",
        *inputs,
        "-filter_complex", filter_complex,
        "-map", "[vfinal]",
        "-map", audio_map,
        "-c:v", enc.codec_name,
        *encode_args,
        "-r", str(FPS),
        "-g", str(FPS * 2),  # GOP = 2s, good for streaming and seeking
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-t", f"{visible_total:.3f}",
        "-movflags", "+faststart",
        str(out_path),
    ]

    import time as _t
    t0 = _t.time()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    dt = _t.time() - t0
    if proc.returncode != 0:
        raise HTTPException(500, f"ffmpeg render failed: {proc.stderr[-700:]}")

    return RenderResponse(
        video_path=str(out_path),
        duration_seconds=visible_total,
        cinematic_profile=profile,
        render_seconds=dt,
    )


def _render_chunked(req: RenderRequest) -> RenderResponse:
    """Render long-form videos by rendering CHUNK_SIZE-image segments separately,
    then concatenating the resulting silent MP4s and adding the audio mix once
    at the end. Bounds RAM and avoids FFmpeg's filter_complex parser limits.
    """
    import time as _t

    out_dir = Path(req.out_dir or os.environ.get("XIANXIA_OUT_DIR", "./out"))
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"video-{uuid.uuid4().hex[:10]}.mp4"
    profile = (req.cinematic or "full").lower()

    enc = best_video_encoder()
    t0 = _t.time()

    # 1. Render each chunk as a silent MP4 with internal xfades.
    chunk_paths: list[Path] = []
    chunks = [req.images[i:i + CHUNK_SIZE] for i in range(0, len(req.images), CHUNK_SIZE)]
    for ci, chunk_beats in enumerate(chunks):
        chunk_req = RenderRequest(
            images=chunk_beats,
            narration_path=req.narration_path,  # required by validator, won't be used
            music_path=None,
            width=req.width, height=req.height, fps=req.fps,
            out_dir=str(out_dir),
            crossfade_seconds=req.crossfade_seconds,
            cinematic=req.cinematic,
            music_ducking=False,
            kenburns_start=req.kenburns_start,
            kenburns_end=req.kenburns_end,
            handheld_sway_px=req.handheld_sway_px,
            loudness_lufs=req.loudness_lufs,
        )
        # Use the inline body of `render()` but skip audio entirely for chunks.
        chunk_out = _render_silent_chunk(chunk_req, ci, out_dir)
        chunk_paths.append(chunk_out)

    # 2. concat demuxer (zero re-encode) — chunks share codec/dims/fps.
    list_file = out_dir / f"concat-{uuid.uuid4().hex[:8]}.txt"
    list_file.write_text(
        "\n".join(f"file '{p.as_posix()}'" for p in chunk_paths),
        encoding="utf-8",
    )
    silent_concat = out_dir / f"concat-{uuid.uuid4().hex[:8]}.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
         "-c", "copy", str(silent_concat)],
        capture_output=True, text=True, check=True,
    )

    # 3. Mux the audio mix over the concat'd silent video — single audio pass
    #    with ducking + loudnorm, applied to the full timeline.
    visible_total = sum(b.duration_seconds for b in req.images) - req.crossfade_seconds * (len(req.images) - 1)
    lufs = req.loudness_lufs
    norm = f"loudnorm=I={lufs}:TP=-1.5:LRA=11"

    audio_inputs = ["-i", req.narration_path]
    if req.music_path and Path(req.music_path).exists():
        audio_inputs += ["-i", req.music_path]
        if req.music_ducking:
            af = (
                f"[2:a]volume={req.music_volume}[mvol];"
                f"[1:a]asplit=2[n1][n2];"
                f"[mvol][n1]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400:makeup=2[duck];"
                f"[duck][n2]amix=inputs=2:duration=first:dropout_transition=0.2,{norm}[aout]"
            )
        else:
            af = (
                f"[2:a]volume={req.music_volume}[m];"
                f"[1:a][m]amix=inputs=2:duration=first:dropout_transition=0.2,{norm}[aout]"
            )
        audio_map = "[aout]"
    else:
        af = f"[1:a]{norm}[aout]"
        audio_map = "[aout]"

    cmd = [
        "ffmpeg", "-y",
        "-i", str(silent_concat),
        *audio_inputs,
        "-filter_complex", af,
        "-map", "0:v", "-map", audio_map,
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-t", f"{visible_total:.3f}",
        "-movflags", "+faststart",
        str(out_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise HTTPException(500, f"chunked mux failed: {proc.stderr[-500:]}")

    # Cleanup intermediates
    for p in chunk_paths:
        try: p.unlink()
        except Exception: pass
    try: silent_concat.unlink()
    except Exception: pass
    try: list_file.unlink()
    except Exception: pass

    return RenderResponse(
        video_path=str(out_path),
        duration_seconds=visible_total,
        cinematic_profile=profile,
        render_seconds=_t.time() - t0,
    )


def _render_silent_chunk(req: RenderRequest, chunk_index: int, out_dir: Path) -> Path:
    """Render a single chunk as a silent MP4 using the same filter strategy as render()."""
    profile = (req.cinematic or "full").lower()
    cfg = (
        EffectsConfig.disabled() if profile == "off"
        else EffectsConfig.light() if profile == "light"
        else EffectsConfig()
    )
    cinema_chain = cinematic_look_filters(cfg)
    cinema_str = ",".join(cinema_chain) if cinema_chain else ""

    fade = max(0.0, float(req.crossfade_seconds))
    W, H, FPS = int(req.width), int(req.height), int(req.fps)
    CANVAS_W, CANVAS_H = W * 2, H * 2

    inputs: list[str] = []
    beat_slots: list[tuple[int, int | None]] = []
    slot = 0
    for b in req.images:
        inputs += ["-loop", "1", "-t", f"{b.duration_seconds:.3f}", "-i", b.image_path]
        bg_i = slot; slot += 1
        fg_i: int | None = None
        if b.foreground_path and Path(b.foreground_path).exists():
            inputs += ["-loop", "1", "-t", f"{b.duration_seconds:.3f}", "-i", b.foreground_path]
            fg_i = slot; slot += 1
        beat_slots.append((bg_i, fg_i))

    clip_filters: list[str] = []
    for i, (b, (bg_i, fg_i)) in enumerate(zip(req.images, beat_slots)):
        nframes = max(1, int(b.duration_seconds * FPS))
        ks, ke = req.kenburns_start, req.kenburns_end
        delta = ke - ks
        sway = req.handheld_sway_px

        if fg_i is not None:
            bg_z, bg_x, bg_y = _eased_z_with_sway(ks, ks + delta * 0.6, nframes, sway * 0.5)
            fg_z, fg_x, fg_y = _eased_z_with_sway(ks, ks + delta * 1.4, nframes, sway)
            chain = (
                f"[{bg_i}:v]scale={CANVAS_W}:{CANVAS_H}:flags=lanczos,setsar=1,"
                f"zoompan=z='{bg_z}':x='{bg_x}':y='{bg_y}':d=1:s={CANVAS_W}x{CANVAS_H}:fps={FPS}[bgz{i}];"
                f"[{fg_i}:v]scale={CANVAS_W}:{CANVAS_H}:flags=lanczos,setsar=1,"
                f"zoompan=z='{fg_z}':x='{fg_x}':y='{fg_y}':d=1:s={CANVAS_W}x{CANVAS_H}:fps={FPS}[fgz{i}];"
                f"[bgz{i}][fgz{i}]overlay=0:0:format=auto:eof_action=pass[ov{i}];"
                f"[ov{i}]scale={W}:{H}:flags=lanczos+full_chroma_int+accurate_rnd"
            )
            if cinema_str:
                chain += "," + cinema_str
            chain += ",format=yuv420p" + f"[c{i}]"
            clip_filters.append(chain)
        else:
            if abs(delta) > 1e-3:
                z, x, y = _eased_z_with_sway(ks, ke, nframes, sway)
                zp = (
                    f"scale={CANVAS_W}:{CANVAS_H}:flags=lanczos,setsar=1,"
                    f"zoompan=z='{z}':x='{x}':y='{y}':d=1:s={CANVAS_W}x{CANVAS_H}:fps={FPS}"
                )
            else:
                zp = (
                    f"scale={CANVAS_W}:{CANVAS_H}:flags=lanczos,setsar=1,"
                    f"crop={CANVAS_W}:{CANVAS_H},fps={FPS}"
                )
            chain_parts = [
                f"[{bg_i}:v]{zp}",
                f"scale={W}:{H}:flags=lanczos+full_chroma_int+accurate_rnd",
            ]
            if cinema_str:
                chain_parts.append(cinema_str)
            chain_parts.append("format=yuv420p")
            clip_filters.append(",".join(chain_parts) + f"[c{i}]")

    XFADE_MAP = {
        "fade": "fade", "fadeblack": "fadeblack", "fadewhite": "fadewhite",
        "dissolve": "dissolve", "pixelize": "pixelize",
        "wiperight": "wiperight", "wipeleft": "wipeleft",
        "circleopen": "circleopen", "circleclose": "circleclose",
        "radial": "radial", "hblur": "hblur", "smoothleft": "smoothleft",
        "smoothright": "smoothright", "diagtl": "diagtl", "diagbr": "diagbr",
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

    enc = best_video_encoder()
    if enc.codec_name == "h264_nvenc":
        encode_args = [
            "-preset", "p7", "-tune", "hq", "-rc", "vbr", "-cq", "18", "-b:v", "0",
            "-spatial-aq", "1", "-temporal-aq", "1", "-aq-strength", "8",
            "-bf", "4", "-rc-lookahead", "32", "-multipass", "fullres",
            "-pix_fmt", "yuv420p",
        ]
    elif enc.codec_name == "h264_qsv":
        encode_args = ["-global_quality", "18", "-preset", "veryslow", "-pix_fmt", "nv12"]
    elif enc.codec_name == "h264_amf":
        encode_args = ["-quality", "quality", "-rc", "vbr_peak", "-qp_i", "18", "-qp_p", "20", "-pix_fmt", "yuv420p"]
    else:
        encode_args = ["-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p"]

    visible = sum(b.duration_seconds for b in req.images) - fade * (len(req.images) - 1)
    chunk_path = out_dir / f"chunk-{chunk_index:03d}-{uuid.uuid4().hex[:6]}.mp4"
    cmd = [
        "ffmpeg", "-y",
        *inputs,
        "-filter_complex", ";".join(clip_filters + xfade_filters),
        "-map", "[vfinal]",
        "-c:v", enc.codec_name,
        *encode_args,
        "-r", str(FPS),
        "-g", str(FPS * 2),
        "-an",  # no audio in chunks
        "-t", f"{visible:.3f}",
        str(chunk_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise HTTPException(500, f"chunk {chunk_index} render failed: {proc.stderr[-500:]}")
    return chunk_path
