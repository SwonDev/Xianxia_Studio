"""Test directo a Qwen3TTSModel.generate_voice_clone — bypass del sidecar.

Objetivo: descartar si el problema está en cómo invoca tts.py, o si el modelo
genuinamente no clona el timbre de mujer del ref del shorts.

Ejecuta TRES síntesis con el mismo ref para A/B/C:
  - A: ICL mode (ref_audio + ref_text)
  - B: x_vector_only_mode=True (sólo embedding)
  - C: ICL mode SIN ref_text (debería fallar; verifica path)

Nota: corre con el python del sidecar bundled, donde qwen_tts está instalado.
"""
import sys, time, os
from pathlib import Path

REF = r"C:\Users\swon_\AppData\Roaming\xianxia\XianxiaStudio\data\voice_clones\3542c4a905\ref.wav"
REF_SHORT = r"C:\Users\swon_\AppData\Roaming\xianxia\XianxiaStudio\data\voice_clones\3542c4a905\ref_short.wav"
TEXT = "Hola. Soy una voz clonada. Si todo funciona, esta voz debería sonar femenina."
OUT_DIR = Path(r"C:\Users\swon_\OneDrive\Documentos\PROYECTOS\VIBECLAUDE\Xianxia_Studio\tests\proof\voice-synth")
OUT_DIR.mkdir(parents=True, exist_ok=True)

REF_TEXT = (
    "¿Sabes lo que pone aquí? Esta es la transcripción fonética de la palabra "
    "magia. O sea, te está diciendo cómo se pronuncia esta palabra."
)

print("=== Loading Qwen3-TTS-Base directly ===")
import torch
from qwen_tts import Qwen3TTSModel
import soundfile as sf

repo_id = os.environ.get("XIANXIA_TTS_BASE_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
device = "cuda:0" if torch.cuda.is_available() else "cpu"
dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
print(f"  device={device} dtype={dtype} repo={repo_id}")

t0 = time.time()
try:
    model = Qwen3TTSModel.from_pretrained(
        repo_id, device_map=device, dtype=dtype, local_files_only=True,
        attn_implementation="flash_attention_2",
    )
except Exception:
    model = Qwen3TTSModel.from_pretrained(
        repo_id, device_map=device, dtype=dtype, local_files_only=True,
    )
print(f"  loaded in {time.time()-t0:.1f}s")
print(f"  tts_model_type = {model.model.tts_model_type}")
print(f"  tts_model_size = {model.model.tts_model_size}")

def synth(label, ref, ref_text_arg, xvec):
    print(f"\n--- {label} ---")
    print(f"  ref:      {Path(ref).name}")
    print(f"  ref_text: {'(none)' if ref_text_arg is None else ref_text_arg[:40]+'...'}")
    print(f"  xvec:     {xvec}")
    t = time.time()
    wavs, sr = model.generate_voice_clone(
        text=TEXT, language="Spanish",
        ref_audio=ref, ref_text=ref_text_arg,
        x_vector_only_mode=xvec,
    )
    dt = time.time() - t
    out = OUT_DIR / f"clone-direct-{label}.wav"
    sf.write(str(out), wavs[0], sr)
    print(f"  ✓ {dt:.1f}s · sr={sr} · samples={len(wavs[0])} ({len(wavs[0])/sr:.1f}s) → {out}")
    return out

A = synth("A_icl_full",     REF_SHORT, REF_TEXT, False)
B = synth("B_xvec_only",    REF_SHORT, None,     True)
C = synth("C_icl_full_long", REF,      REF_TEXT, False)

print("\n=== ALL DONE ===")
print(f"A: {A}")
print(f"B: {B}")
print(f"C: {C}")
