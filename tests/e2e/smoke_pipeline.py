#!/usr/bin/env python
"""End-to-end smoke for the Xianxia Studio production pipeline.

Hits the Python (8731) + Node (8732) sidecars in the same order the Rust
supervisor does in apps/desktop/src-tauri/src/pipeline/mod.rs. Runs in two
modes — `horizontal` and `vertical` — and emits a verdict file per run
with ffprobe metrics + frame dumps so we can audit the result without a
GUI.

This is the harness Claude uses to validate v0.1.10 fixes
without going through the Tauri UI:
  python tests/e2e/smoke_pipeline.py horizontal --topic "Sea of Stars"
  python tests/e2e/smoke_pipeline.py vertical   --topic "Lone Cultivator"

Each run produces:
  out/<run_id>/script.json
  out/<run_id>/tts.wav
  out/<run_id>/image-<N>.png
  out/<run_id>/depth-bg-<N>.jpg + depth-fg-<N>.png
  out/<run_id>/music.mp3
  out/<run_id>/video.mp4
  out/<run_id>/subs-en.{srt,ass}
  out/<run_id>/video.subs.mp4
  out/<run_id>/verdict.json   ← ffprobe summary + assertions
  out/<run_id>/frame-mid.jpg  ← visual check
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

import httpx

PY = "http://127.0.0.1:8731"
NODE = "http://127.0.0.1:8732"
TIMEOUT = httpx.Timeout(60.0 * 60.0, connect=10.0, read=60.0 * 60.0, write=60.0)


def step(name: str) -> None:
    print(f"\n=== {name} ===", flush=True)


def post(client: httpx.Client, url: str, payload: dict) -> dict:
    r = client.post(url, json=payload)
    r.raise_for_status()
    return r.json()


def ffprobe_meta(file: Path) -> dict:
    """Return dict with video_dur, audio_dur, container_dur, w, h."""
    def probe(args: list[str]) -> str:
        try:
            return subprocess.check_output(["ffprobe", "-v", "error", *args, str(file)], text=True).strip()
        except Exception:
            return ""
    vdur = probe(["-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "default=nw=1:nk=1"])
    adur = probe(["-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "default=nw=1:nk=1"])
    cdur = probe(["-show_entries", "format=duration", "-of", "default=nw=1:nk=1"])
    wh = probe(["-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0"])
    w, h = (wh.split(",") + ["", ""])[:2] if wh else ("", "")
    return {
        "video_seconds": float(vdur) if vdur else None,
        "audio_seconds": float(adur) if adur else None,
        "container_seconds": float(cdur) if cdur else None,
        "width": int(w) if w.isdigit() else None,
        "height": int(h) if h.isdigit() else None,
        "size_bytes": file.stat().st_size if file.exists() else 0,
    }


def extract_frame(video: Path, out_path: Path, at: float) -> None:
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-ss", f"{at:.3f}", "-i", str(video),
        "-frames:v", "1", "-q:v", "3",
        str(out_path),
    ], check=False)


def run(mode: str, topic: str, minutes: int, language: str) -> dict:
    vertical = (mode == "vertical")
    run_id = f"{int(time.time())}-{mode}-{uuid.uuid4().hex[:6]}"
    out_dir = Path(__file__).resolve().parent / "runs" / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"run_id={run_id} mode={mode} topic={topic!r} minutes={minutes}", flush=True)

    verdict: dict = {
        "run_id": run_id, "mode": mode, "topic": topic, "minutes": minutes,
        "started_at": time.time(),
        "out_dir": str(out_dir),
        "checks": {},
        "errors": [],
    }

    with httpx.Client(timeout=TIMEOUT) as client:
        # 1. Script
        step("1. /script")
        t = time.time()
        script_resp = post(client, f"{PY}/script", {
            "topic": topic, "target_minutes": minutes, "languages": [language],
        })
        (out_dir / "script.json").write_text(json.dumps(script_resp, indent=2)[:60_000], encoding="utf-8")
        narration = script_resp["narration"]
        markers = script_resp["markers"]
        image_markers = [m for m in markers if m["kind"] == "image"]
        verdict["checks"]["script_words"] = script_resp.get("word_count")
        verdict["checks"]["script_image_markers"] = len(image_markers)
        verdict["checks"]["script_seconds_estimated"] = script_resp.get("estimated_seconds")
        verdict["checks"]["script_elapsed"] = round(time.time() - t, 1)
        print(f"  words={script_resp['word_count']} image_markers={len(image_markers)} ({verdict['checks']['script_elapsed']}s)")

        if len(image_markers) < 3:
            verdict["errors"].append("script produced <3 image markers — auto-fill should have kicked in")

        # Free Ollama before TTS
        client.post(f"{PY}/unload?target=ollama").raise_for_status()

        # 2. TTS
        step("2. /tts")
        t = time.time()
        tts_resp = post(client, f"{PY}/tts", {
            "text": narration, "language": "English",
            "speaker": "Vivian", "out_dir": str(out_dir),
        })
        narration_audio = tts_resp["audio_path"]
        audio_seconds = float(tts_resp.get("duration_seconds", 0.0))
        verdict["checks"]["tts_audio_seconds"] = audio_seconds
        verdict["checks"]["tts_elapsed"] = round(time.time() - t, 1)
        print(f"  audio_seconds={audio_seconds:.2f} ({verdict['checks']['tts_elapsed']}s)")
        client.post(f"{PY}/unload?target=tts").raise_for_status()

        # 3. Images (one per image marker)
        step("3. /image (one per marker)")
        img_w, img_h = (720, 1280) if vertical else (1280, 720)
        t = time.time()
        beats: list[dict] = []
        for i, m in enumerate(image_markers):
            prompt = m["prompt"]
            r = post(client, f"{PY}/image", {
                "prompt": prompt, "out_dir": str(out_dir),
                "style_preset": True, "width": img_w, "height": img_h,
            })
            beats.append({"path": r["image_path"], "prompt": prompt})
            print(f"  [{i+1}/{len(image_markers)}] {Path(r['image_path']).name}")
        verdict["checks"]["images_generated"] = len(beats)
        verdict["checks"]["images_elapsed"] = round(time.time() - t, 1)

        # 3b. Beat timeline normalisation (mirrors normalise_beat_timeline in Rust)
        if audio_seconds > 0 and beats:
            n = len(beats)
            segment = audio_seconds / n
            overlap = max(0.4, min(1.5, segment * 0.15))
            overlap = min(overlap, segment * 0.5)
            trans = ["cross", "flash", "cross", "inkwash", "whip"]
            for i, b in enumerate(beats):
                start = i * segment
                end = audio_seconds if i + 1 == n else (i + 1) * segment + overlap
                b["start"] = start
                b["duration"] = max(1.0, end - start)
                b["transition"] = trans[i % len(trans)]
        client.post(f"{PY}/unload?target=image").raise_for_status()

        # 3c. Depth segmentation
        step("3c. /depth/batch")
        t = time.time()
        try:
            d = post(client, f"{PY}/depth/batch", {
                "images": [b["path"] for b in beats],
                "model": "u2net", "inpaint_radius": 12, "feather_pixels": 4,
            })
            for i, r in enumerate(d.get("results", [])):
                if i < len(beats) and r.get("bg_path") and r.get("fg_path"):
                    beats[i]["path"] = r["bg_path"]
                    beats[i]["foreground_path"] = r["fg_path"]
            verdict["checks"]["depth_layered"] = sum(1 for b in beats if "foreground_path" in b)
        except Exception as e:
            verdict["errors"].append(f"depth: {e}")
        verdict["checks"]["depth_elapsed"] = round(time.time() - t, 1)
        client.post(f"{PY}/unload?target=depth").raise_for_status()

        # 4. Music
        step("4. /music")
        t = time.time()
        music_resp = post(client, f"{PY}/music", {
            "mood": "epic", "duration_seconds": audio_seconds, "use_musicgen": False,
        })
        music_path = music_resp.get("music_path") or music_resp.get("path") or music_resp.get("audio_path")
        verdict["checks"]["music_elapsed"] = round(time.time() - t, 1)
        client.post(f"{PY}/unload?target=music").raise_for_status()

        # 5. Render via Node sidecar (HyperFrames primary)
        step("5. /render/narrative (Node)")
        t = time.time()
        video_out = out_dir / "video.mp4"
        try:
            r = client.post(f"{NODE}/render/narrative", json={
                "project_id": run_id,
                "title": f"Smoke {mode} {topic}",
                "vertical": vertical,
                "narration_path": narration_audio,
                "music_path": music_path,
                "music_volume": 0.32,
                "music_ducking": True,
                "out_path": str(video_out),
                "images": [
                    {
                        "path": b["path"],
                        "foreground_path": b.get("foreground_path"),
                        "start": b["start"],
                        "duration": b["duration"],
                        "transition": b.get("transition"),
                        "fx": "mist",
                        "light_rays": True,
                    }
                    for b in beats
                ],
                "cinematic": "full",
            }, timeout=httpx.Timeout(60 * 60.0, connect=10.0))
            r.raise_for_status()
            verdict["checks"]["render_engine"] = "HyperFrames"
        except Exception as e:
            verdict["errors"].append(f"render hyperframes: {e}")
            print("  Node render failed -> falling back to Python /render")
            beats_for_py = [
                {"image_path": b["path"], "duration": b["duration"]}
                for b in beats
            ]
            r = post(client, f"{PY}/render", {
                "images": beats_for_py,
                "narration_path": narration_audio,
                "music_path": music_path,
                "out_path": str(video_out),
                "vertical": vertical,
            })
            verdict["checks"]["render_engine"] = "FFmpeg-direct"
        verdict["checks"]["render_elapsed"] = round(time.time() - t, 1)

        # 6. ffprobe self-validation
        step("6. ffprobe verdict on video.mp4")
        meta = ffprobe_meta(video_out)
        verdict["checks"]["video_meta"] = meta
        if meta["video_seconds"] and meta["container_seconds"]:
            ratio = meta["video_seconds"] / meta["container_seconds"]
            verdict["checks"]["video_container_ratio"] = round(ratio, 4)
            if ratio < 0.95 or ratio > 1.05:
                verdict["errors"].append(
                    f"video/container desync: video={meta['video_seconds']:.2f} container={meta['container_seconds']:.2f}"
                )
        if meta["audio_seconds"] and audio_seconds:
            audio_ratio = meta["audio_seconds"] / audio_seconds
            verdict["checks"]["audio_match_ratio"] = round(audio_ratio, 4)
            if audio_ratio < 0.95:
                verdict["errors"].append(
                    f"output audio truncated: {meta['audio_seconds']:.2f}s vs source {audio_seconds:.2f}s"
                )
        if meta["width"] != (720 if vertical else 1920) or meta["height"] != (1280 if vertical else 1080):
            # narrative.html composition is 1920×1080 (or 1080×1920); the
            # request `width/height` only controls the IMAGE generation.
            # So we don't fail here, just record.
            verdict["checks"]["video_dimensions_warn"] = f"{meta['width']}x{meta['height']}"

        # 7. Frame dump for visual audit
        if meta["container_seconds"]:
            extract_frame(video_out, out_dir / "frame-start.jpg", 0.5)
            extract_frame(video_out, out_dir / "frame-mid.jpg", meta["container_seconds"] / 2)
            extract_frame(video_out, out_dir / "frame-end.jpg", max(0.0, meta["container_seconds"] - 1.0))

        # 8. Subtitles + burn-in
        step("8. /subtitles")
        t = time.time()
        subs = post(client, f"{PY}/subtitles", {
            "audio_path": narration_audio,
            "source_language": "en",
            "target_languages": ["en"],
            "out_dir": str(out_dir),
            "vertical": vertical,
            "style": "xianxia",
        })
        verdict["checks"]["subs_elapsed"] = round(time.time() - t, 1)
        ass_path = next((s["ass_path"] for s in subs["subtitles"] if s["language"] == "en"), None)
        if ass_path:
            burned = out_dir / "video.subs.mp4"
            try:
                r = post(client, f"{PY}/subtitles/burn-in", {
                    "video_path": str(video_out),
                    "ass_path": ass_path,
                    "out_path": str(burned),
                    "cinematic": "off",  # already applied in HyperFrames pass
                })
                burned_meta = ffprobe_meta(burned)
                verdict["checks"]["burned_meta"] = burned_meta
                extract_frame(burned, out_dir / "frame-burned-mid.jpg", (burned_meta.get("container_seconds") or 1) / 2)
            except Exception as e:
                verdict["errors"].append(f"burn-in: {e}")

    verdict["finished_at"] = time.time()
    verdict["total_elapsed"] = round(verdict["finished_at"] - verdict["started_at"], 1)
    verdict["status"] = "ok" if not verdict["errors"] else "fail"
    (out_dir / "verdict.json").write_text(json.dumps(verdict, indent=2), encoding="utf-8")
    print(f"\n=== verdict ===")
    print(json.dumps(verdict, indent=2))
    return verdict


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("mode", choices=["horizontal", "vertical"])
    p.add_argument("--topic", default="Sea of Stars and Lone Cultivator")
    p.add_argument("--minutes", type=int, default=2)
    p.add_argument("--language", default="en")
    args = p.parse_args()
    v = run(args.mode, args.topic, args.minutes, args.language)
    return 0 if v["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
