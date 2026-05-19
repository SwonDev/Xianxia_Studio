"""Isolated AI-provenance watermark runner (v0.2.17, Meta AudioSeal).

Runs in its OWN process — same isolation discipline as aligner_runner.py:
a clean child whose exit fully releases every CUDA handle and that can
never clash cuDNN with the sidecar's transcription backend.

Hard requirements proven empirically against the bundled runtime:
  - torch dynamo/inductor MUST be disabled: the bundled runtime has no
    MSVC `cl`, so AudioSeal's internal torch.compile aborts otherwise.
  - AudioSeal 0.2 does NOT resample internally. Generate AND detect at
    the audio's NATIVE sample rate (mismatched domains => 0 detection).
  - Watermark the full-quality audio at native sr/channels (same mono
    mark added to every channel) so the published track keeps its
    fidelity; AudioSeal's perturbation is psychoacoustically masked.

Usage:  python -X utf8 watermark_runner.py <in.json> <out.json>
  in.json : {"audio_in": str, "audio_out": str}
  out.json: {"ok": true, "sample_rate": int, "channels": int}
Prints "OK <out.json>" as the last stdout line on success, else "ERR ...".
"""
import json
import os
import sys

os.environ["TORCHDYNAMO_DISABLE"] = "1"
os.environ["TORCH_COMPILE_DISABLE"] = "1"


def main() -> int:
    in_path, out_path = sys.argv[1], sys.argv[2]
    with open(in_path, "r", encoding="utf-8") as f:
        req = json.load(f)
    audio_in = req["audio_in"]
    audio_out = req["audio_out"]

    import torch
    import torchaudio

    try:
        import torch._dynamo

        torch._dynamo.config.suppress_errors = True
        torch._dynamo.config.disable = True
    except Exception:
        pass

    from audioseal import AudioSeal

    wav, sr = torchaudio.load(audio_in)  # [channels, n]
    if wav.dim() == 1:
        wav = wav.unsqueeze(0)
    ch = wav.size(0)

    gen = AudioSeal.load_generator("audioseal_wm_16bits")
    mono = wav.mean(0, keepdim=True).unsqueeze(0)  # [1,1,n]
    with torch.inference_mode():
        wm = gen.get_watermark(mono, sample_rate=sr).squeeze(0).detach()  # [1,n]
    watermarked = (wav + wm.expand(ch, -1)).clamp(-1.0, 1.0).detach()

    # 16-bit PCM intermediate: lossless enough (the mux re-encodes to AAC
    # anyway) and avoids soundfile's 24-bit near-clip warping.
    torchaudio.save(audio_out, watermarked, sr,
                    encoding="PCM_S", bits_per_sample=16)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"ok": True, "sample_rate": int(sr), "channels": int(ch)}, f)
    print(f"OK {out_path}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        print(f"ERR {type(e).__name__}: {str(e)[:300]}")
        sys.exit(1)
