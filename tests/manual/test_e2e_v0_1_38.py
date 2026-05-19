"""End-to-end orchestrator for v0.1.38 verification - replicates the
full Tauri Rust supervisor pipeline outside the .exe.

Flow:
  1. /script (LLM + RAG + two-pass extraction)
  2. /unload?target=ollama
  3. for each IMAGE marker: /image (Z-Image-Turbo via ComfyUI)
  4. /unload?target=image,comfyui
  5. /tts (Qwen3-TTS, voice cloning if requested)
  6. /unload?target=tts
  7. /music (ACE-Step / MusicGen with style_hint)
  8. /unload?target=music
  9. POST :8732/render/narrative (HyperFrames + ffmpeg)
  10. POST :8732/render/thumbnail
  11. fade-out via ffmpeg final-pass
  12. ffprobe sanity check + open file
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

# Force UTF-8 stdout so Spanish accents and Unicode markers don't crash
# print() under Windows' default cp1252 codepage.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# Direct file logger — bypasses PowerShell pipe / Tee-Object buffering
# that has been swallowing all our stdout output.
_log_path = Path(os.environ.get(
    "E2E_LOG_PATH",
    r"C:\Users\swon_\OneDrive\Documentos\PROYECTOS\VIBECLAUDE\Xianxia_Studio\e2e-pilot.log",
))
_log_path.parent.mkdir(parents=True, exist_ok=True)
_log_file = open(_log_path, "w", encoding="utf-8", buffering=1)  # line-buffered

# Save the original print BEFORE rebinding, so _say can call it without
# recursing into itself.
import builtins as _builtins
_orig_print = _builtins.print

def _say(*args, **_kwargs):
    msg = " ".join(str(a) for a in args)
    try:
        _orig_print(msg, flush=True)
    except Exception:
        pass
    try:
        _log_file.write(msg + "\n")
        _log_file.flush()
    except Exception:
        pass

# Replace print with _say across the rest of the script
print = _say  # type: ignore[assignment]

PY = "http://127.0.0.1:8731"
NODE = "http://127.0.0.1:8732"
COMFY = "http://127.0.0.1:8188"

# Read topic + minutes from env vars (PowerShell ArgumentList breaks topics
# with spaces into multiple argv tokens). Fall back to argv if env unset.
TOPIC = (
    os.environ.get("E2E_TOPIC")
    or (sys.argv[1] if len(sys.argv) > 1 else None)
    or "El descubrimiento de la tumba de Tutankamón"
)
_minutes_raw = os.environ.get("E2E_MIN") or (sys.argv[2] if len(sys.argv) > 2 else "8")
try:
    TARGET_MIN = int(_minutes_raw)
except (ValueError, TypeError):
    TARGET_MIN = 8  # YouTube monetization threshold
LANG = "es"
VOICE = "vivian"  # Built-in CustomVoice - fast, no clone install needed
WIDTH, HEIGHT = 1920, 1088  # 1088 is divisible by 16; diffusers fallback requires it
FPS = 30

# Allow resuming from a previous partial run by setting E2E_REUSE_DIR.
# This skips /script and /tts when their artifacts already exist on disk,
# letting us iterate on the image / render stage without paying TTS again.
_reuse = os.environ.get("E2E_REUSE_DIR")
# Reuse the dir as long as it exists — individual phases handle their own
# cache hits (script.json, tts-*.wav, image_files.json, music-*.wav). When
# any of those are missing we regenerate just that one and keep the rest.
if _reuse and Path(_reuse).is_dir():
    OUT_DIR = Path(_reuse)
    PROJ_ID = OUT_DIR.name
else:
    PROJ_ID = f"e2e-v0138-{int(time.time())}"
    OUT_DIR = Path(rf"C:\Users\swon_\AppData\Roaming\xianxia\XianxiaStudio\data\out\{PROJ_ID}")
OUT_DIR.mkdir(parents=True, exist_ok=True)

print(f"=== E2E v0.1.38 verification ===")
print(f"  topic: {TOPIC}")
print(f"  target_minutes: {TARGET_MIN}")
print(f"  lang: {LANG} | voice: {VOICE}")
print(f"  out: {OUT_DIR}\n")


def post(url: str, body: dict, timeout: int = 600) -> dict:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body_text = r.read().decode("utf-8")
        return json.loads(body_text) if body_text else {}


def post_silent(url: str, body: dict, timeout: int = 60):
    try:
        post(url, body, timeout)
    except Exception as e:
        print(f"  [warn] {url} -> {e}")


# -- 1. SCRIPT (RAG + two-pass) — reuse cached if available ----------
_script_cache = OUT_DIR / "script.json"
if _script_cache.exists():
    print(f"[1/9] /script - REUSING cached script.json from {OUT_DIR}")
    script_resp = json.loads(_script_cache.read_text(encoding="utf-8"))
else:
    print(f"[1/9] /script - generating ~{TARGET_MIN}-min narration with RAG...")
    t0 = time.time()
    script_resp = post(f"{PY}/script", {
        "topic": TOPIC,
        "target_minutes": TARGET_MIN,
        "languages": [LANG],
    }, timeout=900)
    print(f"      [OK] {time.time()-t0:.1f}s  -  {script_resp['word_count']} words "
          f" -  est_seconds={script_resp['estimated_seconds']:.1f}")
narration = script_resp["narration"]
markers = script_resp["markers"]
image_markers = [m for m in markers if m["kind"] == "image"]
print(f"      setting_tag: {script_resp.get('setting_tag','(none)')[:120]}")
print(f"      image markers: {len(image_markers)}")
print(f"      first 200 chars of narration: {narration[:200]}...")
(OUT_DIR / "narration.txt").write_text(narration, encoding="utf-8")
(OUT_DIR / "script.json").write_text(
    json.dumps(script_resp, ensure_ascii=False, indent=2), encoding="utf-8"
)
print()

# -- 2. UNLOAD OLLAMA before TTS / SD --------------------------------
print("[2/9] /unload ollama...")
post_silent(f"{PY}/unload?target=ollama", {})

# -- 3. TTS — reuse cached if available -------------------------------
_existing_wavs = list(OUT_DIR.glob("tts-*.wav"))
if _existing_wavs:
    narration_path = str(_existing_wavs[0])
    import wave
    try:
        with wave.open(narration_path, "rb") as wf:
            narration_seconds = wf.getnframes() / float(wf.getframerate())
    except Exception:
        narration_seconds = 0.0
    print(f"[3/9] /tts - REUSING cached {Path(narration_path).name} ({narration_seconds:.1f}s)")
else:
    print(f"[3/9] /tts - synthesizing {len(narration)} chars in {LANG}...")
    t0 = time.time()
    tts_resp = post(f"{PY}/tts", {
        "text": narration,
        "speaker": VOICE,
        "language": LANG,
        "out_dir": str(OUT_DIR),
    }, timeout=3600)  # 60 min: 14 chunks * ~150s/chunk on this machine
    print(f"      [OK] {time.time()-t0:.1f}s  -  audio_path={tts_resp['audio_path']} "
          f" -  duration={tts_resp['duration_seconds']:.1f}s  -  chunks={tts_resp.get('chunks',0)}")
    narration_path = tts_resp["audio_path"]
    narration_seconds = float(tts_resp["duration_seconds"])
print()

# -- 4. UNLOAD TTS before SD -----------------------------------------
print("[4/9] /unload tts...")
post_silent(f"{PY}/unload?target=tts", {})

# -- 5. IMAGES (one per IMAGE marker) - cached + downsampled ---------
# v0.1.38: when an `image_files.json` cache exists from a previous run,
# reuse the paths so we don't regenerate the full 19-image batch every
# time. The HyperFrames renderer was timing out on 19 frames at 1920x1088
# and producing a 65 s clip instead of 368 s, so we also DOWNSAMPLE the
# beats to a manageable number (8) by stride-sampling every Nth marker.
_image_cache_file = OUT_DIR / "image_files.json"
if _image_cache_file.exists():
    image_files = json.loads(_image_cache_file.read_text(encoding="utf-8"))
    print(f"[5/9] /image - REUSING {len(image_files)} cached image_files from {_image_cache_file.name}")
else:
    print(f"[5/9] /image  -  generating {len(image_markers)} frames at {WIDTH}x{HEIGHT}...")
    image_files = []
    for i, m in enumerate(image_markers):
        t = time.time()
        try:
            r = post(f"{PY}/image", {
                "prompt": m["prompt"],
                "width": WIDTH, "height": HEIGHT,
                "out_dir": str(OUT_DIR),
                "style_preset": True,
            }, timeout=900)
            image_files.append({
                "path": r["image_path"],
                "start": float(m["timestamp_seconds"]),
                "duration": 0.0,
                "transition": "fade",
            })
            print(f"  [{i+1}/{len(image_markers)}] [OK] {time.time()-t:.1f}s  -  "
                  f"prompt[:80]={m['prompt'][:80]}...")
        except Exception as e:
            print(f"  [{i+1}/{len(image_markers)}] FAIL ({time.time()-t:.1f}s): {e}")
    _image_cache_file.write_text(json.dumps(image_files, indent=2), encoding="utf-8")

if not image_files:
    print("FATAL: no images. abort.")
    sys.exit(1)

# v0.1.38 (F8): adaptive MAX_BEATS — aim for ~1 beat every 20-25 s so the
# documentary pacing stays tasteful but we get more visual variety than
# the previous fixed 8. HP Theory style ranges 4-8 s per beat (10-14
# cuts/min) but generation cost would explode for longer videos, so we
# settle on ~3 cuts/min as our sweet spot. 5-min video → ~15 beats.
# Floor at 8 beats so very short videos still feel cut.
_target_per_beat_sec = 22.0
_max_beats_dynamic = max(8, min(len(image_files), int(narration_seconds / _target_per_beat_sec)))
if len(image_files) > _max_beats_dynamic:
    stride = len(image_files) / _max_beats_dynamic
    sampled = [image_files[int(i * stride)] for i in range(_max_beats_dynamic)]
    image_files = sampled
    print(f"      downsampled to {len(image_files)} beats (stride {stride:.2f}, target ~{_target_per_beat_sec:.0f}s/beat)")

n = len(image_files)
slot = narration_seconds / n
for idx, im in enumerate(image_files):
    im["start"] = idx * slot
    im["duration"] = slot

# v0.1.38 (F3): attach chapter_title from [CHAPTER:] markers to the
# corresponding beat. We map each chapter marker (timestamp, title) to
# the surviving image beat whose start time is closest to the chapter
# timestamp (and >= it). The renderer then draws a slate divider over
# that beat's first ~1.6 s and the SFX layer auto-plays whoosh+impact.
chapter_markers = [m for m in markers if m.get("kind") == "chapter" and m.get("title")]
if chapter_markers:
    # Skip the very first chapter if it's at t=0 or t<6 (the intro card
    # already covers that — we don't need a redundant slate stacked on it).
    for cm in chapter_markers:
        ct = float(cm["timestamp_seconds"])
        if ct < 6.0:
            continue
        # Find the beat whose start is closest to (and >= ) this chapter.
        candidate = next((im for im in image_files if im["start"] >= ct - slot * 0.5), None)
        if candidate is None:
            candidate = image_files[-1]
        candidate["chapter_title"] = cm["title"][:48]  # safety crop
    chapters_set = sum(1 for im in image_files if im.get("chapter_title"))
    print(f"      chapter dividers attached: {chapters_set} (from {len(chapter_markers)} chapter markers)")

print(f"      timeline normalised: {n} images x {slot:.1f}s each = {n*slot:.1f}s\n")

# -- 5b. DEPTHFLOW PARALLAX (Phase 4b in the real pipeline) ----------
# v0.1.38 — DepthFlow renders a per-pixel-depth-map 2.5D parallax MP4
# for each still. Replaces the rembg+inpaint approach which produced
# torn / smeared backgrounds whenever the foreground subject was big.
# DepthFlow's GLSL shader uses Depth-Anything-V2-small; output is one
# 12 s clip per image (looped at the renderer level). Best-effort: if
# the depthflow venv isn't installed we skip and the renderer falls
# back to single-image + Ken Burns automatically.
print("[5b/9] /depthflow/batch  -  generating parallax 2.5D clips…")
t0 = time.time()
img_paths = [im["path"] for im in image_files]
df_dir = OUT_DIR / "df-clips"
df_dir.mkdir(parents=True, exist_ok=True)
try:
    health = post(f"{PY}/depthflow/health", {}, timeout=15) if False else None
    # (POST not allowed for /health — use direct call)
    health_url = f"{PY}/depthflow/health"
    h_req = urllib.request.Request(health_url, method="GET")
    with urllib.request.urlopen(h_req, timeout=15) as r:
        health = json.loads(r.read().decode("utf-8"))
    if not health.get("venv_python_exists"):
        raise RuntimeError(f"depthflow venv missing at {health.get('venv_python')}")
    df_resp = post(f"{PY}/depthflow/batch", {
        "images": img_paths,
        "out_dir": str(df_dir),
        "duration_seconds": 12.0,
        "fps": 24,
        "width": WIDTH,
        "height": HEIGHT,
    }, timeout=1800)
    results = df_resp.get("results") or []
    if len(results) == len(image_files):
        for i, r in enumerate(results):
            out = r.get("output_path")
            if out:
                image_files[i]["clip_path"] = out
        with_clip = sum(1 for im in image_files if im.get("clip_path"))
        print(f"      [OK] {time.time()-t0:.1f}s  -  {with_clip}/{n} beats with DepthFlow parallax MP4")
    else:
        print(f"      [warn] depthflow returned {len(results)}/{n} — rendering without parallax")
except Exception as e:
    print(f"      [warn] depthflow unavailable ({e})  -  rendering single-image fallback")

# -- 5c. ENRICH BEATS with cinematic transitions + atmospherics ------
# Replicates the Rust supervisor's slot rotation + per-topic atmospherics
# bias so HyperFrames produces variety (cross / flash / whip / inkwash)
# instead of fading-fading-fading-fading.
TRANSITIONS = ["cross", "flash", "whip", "inkwash", "cross", "whip", "flash", "inkwash"]
# v0.1.38: Atmospheric particle FX disabled — they look static during
# Playwright frame capture (the canvas's requestAnimationFrame doesn't
# advance enough between HyperFrames' fixed-timestamp seeks, and the
# slow-moving particles like dust_motes/mist appear frozen). Parallax
# 2.5D + Ken Burns + cinematic transitions already provide ample
# dynamism without the visual artefact.
for i, im in enumerate(image_files):
    im["transition"] = TRANSITIONS[i % len(TRANSITIONS)]
    im["fx"] = "none"
    im["light_rays"] = (i % 3 == 0)
print(f"      transitions: {[im['transition'] for im in image_files]}")

# -- 6. UNLOAD comfy/image before music ------------------------------
print("[6/9] /unload image+comfyui...")
post_silent(f"{PY}/unload?target=image", {})
post_silent(f"{PY}/unload?target=comfyui", {})

# -- 7. MUSIC --------------------------------------------------------
# Reuse cached music wav if it covers the narration (MusicGen is the
# slowest single phase: 20-30 min). Any music-*.wav longer than the
# narration counts as a valid bed.
_cached_music = sorted(
    [p for p in OUT_DIR.glob("music-*.wav")
     if "raw" not in p.name and p.stat().st_size > 1024 * 1024],
    key=lambda p: p.stat().st_mtime,
    reverse=True,
)
music_path = None
if _cached_music:
    music_path = str(_cached_music[0])
    print(f"[7/9] /music - REUSING cached {music_path}")
else:
    print(f"[7/9] /music  -  generating {narration_seconds:.0f}s with style_hint...")
    t0 = time.time()
    try:
        # v0.1.38 (fix): bumped timeout 1800 → 3600 s. MusicGen for 600 s
        # of audio on RTX 4060 8 GB takes ~25-40 min depending on model
        # warm-up + chunk concat. 30 min was hitting timeout on long-form
        # videos; 60 min is the safe ceiling. The endpoint also has its
        # own internal timeout so this is just the urllib client wait.
        music_resp = post(f"{PY}/music", {
            "mood": "epic",
            "duration_seconds": narration_seconds + 5.0,  # tail for fade-out
            "use_musicgen": True,
            "style_hint": script_resp.get("setting_tag") or TOPIC,
            "out_dir": str(OUT_DIR),
        }, timeout=3600)
        music_path = music_resp.get("audio_path")
        print(f"      [OK] {time.time()-t0:.1f}s  -  {music_path}")
    except Exception as e:
        # Fallback: library track (instant) so the video always has music.
        print(f"      [warn] musicgen failed ({e})  -  falling back to library track")
        try:
            fb = post(f"{PY}/music", {
                "mood": "epic",
                "duration_seconds": narration_seconds + 5.0,
                "use_musicgen": False,
                "style_hint": script_resp.get("setting_tag") or TOPIC,
                "out_dir": str(OUT_DIR),
            }, timeout=120)
            music_path = fb.get("audio_path")
            print(f"      [fallback OK] library track: {music_path}")
        except Exception as e2:
            print(f"      [warn] library music also failed: {e2}  -  no music in video")
            music_path = None

# -- 8. UNLOAD music before render -----------------------------------
post_silent(f"{PY}/unload?target=music", {})

# -- 9. RENDER NARRATIVE (HyperFrames + ffmpeg) ----------------------
print(f"[8/9] :8732/render/narrative  -  assembling video...")
t0 = time.time()
out_video = str(OUT_DIR / "video.mp4")
def _beat_payload(im):
    o = {
        "path": im["path"],
        "start": im["start"],
        "duration": im["duration"],
        "transition": im.get("transition", "cross"),
        "fx": im.get("fx", "none"),
        "light_rays": bool(im.get("light_rays")),
    }
    # v0.1.38 — DepthFlow parallax clip preferred; foreground_path kept
    # for legacy callers but ignored by the current renderer (rembg
    # parallax disabled).
    if im.get("clip_path"):
        o["clip_path"] = im["clip_path"]
    if im.get("foreground_path"):
        o["foreground_path"] = im["foreground_path"]
    if im.get("chapter_title"):
        o["chapter_title"] = im["chapter_title"]
    return o

# v0.1.38 — derive intro_eyebrow from setting_tag (matches the Rust
# pipeline's logic in mod.rs: "Ancient Egyptian setting (..)" →
# "ANCIENT EGYPTIAN · HISTORIA REAL"). Falls back to a generic tagline.
import re as _re_intro
_setting_raw = (script_resp.get("setting_tag") or "").strip()
_core_intro = _re_intro.split(r"[(\[]", _setting_raw, 1)[0].strip()
_core_intro = _re_intro.sub(
    r"\b(setting|era|period|world|universe|atmosphere)\b\.?$",
    "", _core_intro, flags=_re_intro.IGNORECASE,
).strip().rstrip(",.").strip()
_tagline_intro = "HISTORIA REAL" if (LANG or "").lower().startswith("es") else "REAL HISTORY"
intro_eyebrow_text = f"{_core_intro.upper()} · {_tagline_intro}" if _core_intro else "DOCUMENTAL"

render_body = {
    "project_id": PROJ_ID,
    "title": TOPIC,
    "intro_eyebrow": intro_eyebrow_text,
    "images": [_beat_payload(im) for im in image_files],
    "narration_path": narration_path,
    "out_path": out_video,
    "width": WIDTH, "height": HEIGHT, "fps": FPS,
    "cinematic": "full",
    "music_volume": 0.32,
    "music_ducking": True,
}
if music_path:
    render_body["music_path"] = music_path
try:
    render_resp = post(f"{NODE}/render/narrative", render_body, timeout=3600)
    print(f"      [OK] {time.time()-t0:.1f}s  -  {render_resp.get('out_path')}")
except Exception as e:
    print(f"      FATAL render: {e}")
    sys.exit(2)

# -- 9b. SUBTITLES via faster-whisper -------------------------------
# The Tauri supervisor's pipeline calls /subtitles after the render to
# transcribe the narration audio + translate to other languages. We
# replicate it here so the test video has subs.es.srt next to the MP4.
print("[9b/9] /subtitles - transcribing narration with faster-whisper...")
t0 = time.time()
_cached_ass = OUT_DIR / f"subs-{LANG}.ass"
_cached_srt = OUT_DIR / f"subs-{LANG}.srt"
if _cached_ass.exists() and _cached_srt.exists() and _cached_srt.stat().st_size > 100:
    # Reuse cached subs + synthesize the response shape so the burn-in
    # block below can pick the .ass without re-running whisper.
    subs_resp = {
        "subtitles": [{
            "language": LANG,
            "ass_path": str(_cached_ass),
            "srt_path": str(_cached_srt),
        }],
    }
    print(f"      REUSING cached subs-{LANG}.ass ({_cached_ass.stat().st_size} bytes)")
try:
    if not (_cached_ass.exists() and _cached_srt.exists() and _cached_srt.stat().st_size > 100):
        subs_resp = post(f"{PY}/subtitles", {
            "audio_path": narration_path,
            "source_language": LANG,
            "target_languages": [LANG, "en"],
            "out_dir": str(OUT_DIR),
            "style": "xianxia",
        }, timeout=900)
    print(f"      [OK] {time.time()-t0:.1f}s  -  files: {list(subs_resp.keys())[:6]}")
    # -- 9c. SUBTITLE BURN-IN (Phase 8 in the real pipeline) ---------
    # The Rust supervisor calls /subtitles/burn-in to overlay the karaoke
    # ASS onto the rendered MP4 with FFmpeg + cinematic post-pass. We
    # replicate it so the pilot's video.mp4 ships subtitles burned in.
    try:
        ass_path = next(
            (a["ass_path"] for a in (subs_resp.get("subtitles") or [])
             if a.get("language") == LANG),
            None,
        )
        if ass_path and Path(ass_path).exists():
            # v0.1.38 — Whisper transcribes the bare narration WAV that
            # starts at t=0, but the rendered video has 6 s of intro
            # silence prepended (the title-card segment). Burning the raw
            # ASS would put the first sentence at 00:00 instead of 00:06
            # so every line stays 6 s ahead of the voice. We post-process
            # the ASS by adding 6 s to every Dialogue start/end before
            # passing it to /subtitles/burn-in.
            INTRO_OFFSET_SEC = 6.0
            shifted_ass = OUT_DIR / f"subs-{LANG}.shifted.ass"
            try:
                import re as _re_ass
                ass_text = Path(ass_path).read_text(encoding="utf-8")
                _ts_pat = _re_ass.compile(
                    r"(Dialogue: \d+,)(\d+):(\d{2}):(\d{2})\.(\d{2}),(\d+):(\d{2}):(\d{2})\.(\d{2}),"
                )
                def _shift(m):
                    s = int(m.group(2))*3600 + int(m.group(3))*60 + int(m.group(4)) + int(m.group(5))/100 + INTRO_OFFSET_SEC
                    e = int(m.group(6))*3600 + int(m.group(7))*60 + int(m.group(8)) + int(m.group(9))/100 + INTRO_OFFSET_SEC
                    def fmt(t):
                        h = int(t // 3600); rem = t - h*3600
                        mm = int(rem // 60); rem -= mm*60
                        ss = int(rem); cs = int(round((rem - ss) * 100))
                        if cs >= 100: cs = 99
                        return f"{h}:{mm:02d}:{ss:02d}.{cs:02d}"
                    return f"{m.group(1)}{fmt(s)},{fmt(e)},"
                shifted_ass.write_text(_ts_pat.sub(_shift, ass_text), encoding="utf-8")
                ass_path = str(shifted_ass)
                print(f"      ASS shifted by +{INTRO_OFFSET_SEC}s for intro")
            except Exception as _e:
                print(f"      [warn] could not shift ASS ({_e}); using original (subs may desync)")

            print("[9c/9] /subtitles/burn-in  -  burning karaoke ASS into MP4…")
            t0 = time.time()
            burn_out = str(OUT_DIR / "video-final.mp4")
            burn_resp = post(f"{PY}/subtitles/burn-in", {
                "video_path": out_video,
                "ass_path": ass_path,
                "out_path": burn_out,
                "crf": 18,
                "preset": "medium",
                "cinematic": "off",  # cinematic stack already applied by HF post-pass
            }, timeout=1800)
            if Path(burn_out).exists() and os.path.getsize(burn_out) > 1024:
                out_video = burn_out
                print(f"      [OK] {time.time()-t0:.1f}s  -  {burn_out}")
            else:
                print(f"      [warn] burn-in returned but no MP4 — keeping un-burned video")
        else:
            print(f"      [warn] no .ass for {LANG} — skipping burn-in")
    except Exception as e:
        print(f"      [warn] burn-in failed: {e}  -  keeping un-burned video")
except Exception as e:
    print(f"      [warn] subtitles failed: {e}")
post_silent(f"{PY}/unload?target=whisper", {})

# -- 10. THUMBNAIL ---------------------------------------------------
print(f"[9/9] /image (1280x720) + :8732/render/thumbnail...")
t0 = time.time()
try:
    setting_prefix = (script_resp.get("setting_tag") or "").strip()
    thumb_prompt = (
        f"VIRAL YOUTUBE THUMBNAIL: {setting_prefix}. {TOPIC}. "
        "Extreme dramatic close-up hero shot, intense emotional expression, "
        "iconic element of the topic in the foreground, high-contrast saturated "
        "colours, rim lighting, deep shadows on the lower third (so title text "
        "overlays cleanly), epic atmosphere, photorealistic, ultra-detailed, "
        "sharp focus on subject, shallow depth of field, clickbait-grade "
        "composition, period-correct iconography faithful to the topic, "
        "no text overlay, no logos, no watermarks"
    )
    bg = post(f"{PY}/image", {
        "prompt": thumb_prompt,
        "width": 1280, "height": 720,
        "out_dir": str(OUT_DIR),
        "style_preset": False,
    }, timeout=600)
    # Subtitle line: short tagline derived from setting_tag (NOT the title
    # repeated). E.g. "Ancient Egyptian setting (sand-gold, …)" → "ANCIENT
    # EGYPTIAN · HISTORIA REAL". Falls back to a generic tagline if the
    # setting is unknown so the thumbnail never shows duplicate text.
    import re as _re
    _core = _re.split(r"[(\[]", setting_prefix, 1)[0].strip()
    _core = _re.sub(r"\b(setting|era|period|world|universe|atmosphere)\b\.?$",
                    "", _core, flags=_re.IGNORECASE).strip().rstrip(",.").strip()
    _tagline = "HISTORIA REAL" if (LANG or "").lower().startswith("es") else "REAL HISTORY"
    subtitle_text = (f"{_core.upper()} · {_tagline}" if _core else _tagline)
    badge = (setting_prefix.split()[0] if setting_prefix else "").upper().strip(",.()")
    thumb_out = str(OUT_DIR / "thumbnail.jpg")
    post(f"{NODE}/render/thumbnail", {
        "title_en": TOPIC,
        "subtitle": subtitle_text,
        "badge": badge,
        "background_path": bg["image_path"],
        "out_path": thumb_out,
    }, timeout=180)
    print(f"      [OK] {time.time()-t0:.1f}s  -  {thumb_out}")
except Exception as e:
    print(f"      [warn] thumbnail failed: {e}")
    thumb_out = None

# -- 10b. ENGAGEMENT analysis + auto-optimize boring valleys ---------
# Phase 11 of the real Tauri pipeline (mod.rs:1175). TRIBE v2 in-silico
# fMRI scores per-second engagement; valleys below 0.40 for 4+ seconds
# get auto-fixed via /engagement/optimize (cuts + audio swells). Best
# effort: 503 means TRIBE not installed → skip gracefully.
print("[10b/?] /engagement/analyze + optimize…")
t0 = time.time()
try:
    eng = post(f"{PY}/engagement/analyze", {
        "video_path": out_video,
        "mode": "light",
        "out_dir": str(OUT_DIR),
        "boring_threshold": 0.40,
        "valley_min_seconds": 4.0,
    }, timeout=1200)
    score = eng.get("overall_score", 0.0)
    valleys = eng.get("boring_spots") or []
    print(f"      analyzed in {time.time()-t0:.1f}s  -  engagement={score:.1f}/100  valleys={len(valleys)}")
    if valleys:
        print("[10c/?] /engagement/optimize  -  fixing valleys…")
        t1 = time.time()
        opt = post(f"{PY}/engagement/optimize", {
            "video_path": out_video,
            "boring_spots": valleys,
            "out_dir": str(OUT_DIR),
            "allow_cut": True,
            "allow_audio_swell": True,
            "allow_broll": False,
        }, timeout=900)
        new_video = opt.get("out_path")
        if new_video and Path(new_video).exists() and os.path.getsize(new_video) > 1024:
            out_video = new_video
            print(f"      [OK] {time.time()-t1:.1f}s  -  {opt.get('spots_fixed', 0)} valleys fixed → {new_video}")
        else:
            print(f"      [warn] optimize returned but no valid MP4 — keeping pre-optimize video")
except Exception as e:
    print(f"      [skip] engagement unavailable: {e}")

# -- 11. RESUMEN -----------------------------------------------------
print()
print("=" * 60)
print(f"DONE - output dir: {OUT_DIR}")
import subprocess
try:
    dur = subprocess.check_output([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1",
        out_video,
    ], text=True).strip()
    size_mb = os.path.getsize(out_video) / (1024 * 1024)
    print(f"  video.mp4: {size_mb:.1f} MB  -  {dur}s")
except Exception:
    pass
if thumb_out and Path(thumb_out).exists():
    print(f"  thumbnail.jpg: {os.path.getsize(thumb_out)/1024:.1f} KB")
print("=" * 60)

# Open the video
try:
    os.startfile(out_video)
except Exception:
    pass
