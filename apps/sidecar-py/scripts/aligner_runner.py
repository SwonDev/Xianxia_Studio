"""Isolated forced-alignment runner (v0.2.16).

Runs in its OWN process so torchaudio's wav2vec2 cuDNN never coexists
with the whisper transcription backend in the sidecar process — that
coexistence is a hard `cudnnGetLibConfig (error 127)` process abort
(v0.1.22 class of bug, proven by validation to fire even WITH an
in-process whisper unload). Process exit fully releases every CUDA handle.

CONTRACT: imports ONLY json/sys/unicodedata/torch/torchaudio. It must
NEVER import the transcription backend nor the application package, or it
re-creates the very cuDNN clash it exists to avoid.

Usage:  python -X utf8 aligner_runner.py <in.json> <out.json>
  in.json : {"audio_path": str, "words": ["raw word", ...]}
  out.json: {"ok": true, "refined": [[idx, start, end], ...]}
            idx indexes into the input "words" list (only words that
            actually aligned are listed; the rest keep caller timings).
Prints "OK <out.json>" as the last stdout line on success, else "ERR ...".
"""
import json
import sys
import unicodedata

_ALIGN_CHARS = frozenset("abcdefghijklmnopqrstuvwxyz'")


def _norm(w: str) -> str:
    w = unicodedata.normalize("NFKD", w or "")
    w = "".join(c for c in w if not unicodedata.combining(c)).lower()
    return "".join(c for c in w if c in _ALIGN_CHARS)


def _load_audio(path: str, target_sr: int):
    import torch
    import torchaudio

    try:
        wav, sr = torchaudio.load(path)
    except Exception:
        import numpy as np
        import soundfile as sf

        data, sr = sf.read(path, dtype="float32", always_2d=True)
        wav = torch.from_numpy(np.ascontiguousarray(data.T))
    if wav.dim() == 2 and wav.size(0) > 1:
        wav = wav.mean(0, keepdim=True)
    elif wav.dim() == 1:
        wav = wav.unsqueeze(0)
    if sr != target_sr:
        wav = torchaudio.functional.resample(wav, sr, target_sr)
    return wav


def main() -> int:
    in_path, out_path = sys.argv[1], sys.argv[2]
    with open(in_path, "r", encoding="utf-8") as f:
        req = json.load(f)
    words = req.get("words") or []
    audio_path = req["audio_path"]

    align_idx = []
    norm_words = []
    for i, w in enumerate(words):
        nw = _norm(w)
        if nw:
            align_idx.append(i)
            norm_words.append(nw)
    if len(norm_words) < 2:
        print("ERR too few alignable words")
        return 1

    import torch
    import torchaudio

    bundle = torchaudio.pipelines.MMS_FA
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = bundle.get_model(with_star=False).to(device).eval()
    tokenizer = bundle.get_tokenizer()
    aligner = bundle.get_aligner()
    sr = int(bundle.sample_rate)

    wav = _load_audio(audio_path, sr)
    with torch.inference_mode():
        emission, _ = model(wav.to(device))
    token_spans = aligner(emission[0], tokenizer(norm_words))
    if len(token_spans) != len(norm_words):
        print(f"ERR span mismatch {len(token_spans)}!={len(norm_words)}")
        return 1

    num_frames = emission.size(1)
    if num_frames <= 0:
        print("ERR empty emission")
        return 1
    ratio = wav.size(1) / num_frames / sr  # seconds per emission frame

    refined = []
    for spans, idx in zip(token_spans, align_idx):
        if not spans:
            continue
        st = float(spans[0].start) * ratio
        en = float(spans[-1].end) * ratio
        if en > st >= 0.0:
            refined.append([idx, st, en])
    if not refined:
        print("ERR no spans produced")
        return 1

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"ok": True, "refined": refined, "total": len(words)}, f)
    print(f"OK {out_path}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        print(f"ERR {type(e).__name__}: {str(e)[:300]}")
        sys.exit(1)
