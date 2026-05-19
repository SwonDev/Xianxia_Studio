"""Test minimal — 1 sola síntesis, x_vector_only para descartar ICL.

Aprendizajes del test A/B/C anterior:
  - 3 generaciones secuenciales con `_ensure_list` interno reescriben prompt
    items y son mucho más lentas que los WAV de Adrián (50 s vía sidecar).
  - Sin flash-attn la inferencia con grafo grande (Base) es 5-10x más lenta.
  - Sospecha: sidecares zombi compitiendo por VRAM (ya matados).

Test: 1 generación, ref corto, x_vector_only=True. Si suena femenino → el
bug está en mi código (probablemente ICL+ref_text mojibake corruptos).
Si suena masculino → algún parámetro upstream se nos escapa o el modelo
no clona timbres femeninos con ref tan corto.
"""
import os, time
from pathlib import Path

REF_SHORT = r"C:\Users\swon_\AppData\Roaming\xianxia\XianxiaStudio\data\voice_clones\3542c4a905\ref_short.wav"
TEXT = "Hola. Soy una voz clonada. ¿Suena femenino?"
OUT = Path(r"C:\Users\swon_\OneDrive\Documentos\PROYECTOS\VIBECLAUDE\Xianxia_Studio\tests\proof\voice-synth\clone-minimal-xvec.wav")
OUT.parent.mkdir(parents=True, exist_ok=True)

print("=== loading model ===")
import sys, torch
from qwen_tts import Qwen3TTSModel
import soundfile as sf

repo_id = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
device = "cuda:0" if torch.cuda.is_available() else "cpu"
dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
print(f"  device={device}", flush=True)

t0 = time.time()
try:
    model = Qwen3TTSModel.from_pretrained(repo_id, device_map=device, dtype=dtype, local_files_only=True, attn_implementation="flash_attention_2")
    print("  flash-attn 2 OK", flush=True)
except Exception as e:
    print(f"  flash-attn fallback ({e!r})", flush=True)
    model = Qwen3TTSModel.from_pretrained(repo_id, device_map=device, dtype=dtype, local_files_only=True)
print(f"  loaded in {time.time()-t0:.1f}s", flush=True)
print(f"  tts_model_type = {model.model.tts_model_type}", flush=True)
print(f"  device of model = {next(model.model.parameters()).device}", flush=True)

print("\n=== synth x_vector_only=True ===", flush=True)
t = time.time()
wavs, sr = model.generate_voice_clone(
    text=TEXT, language="Spanish",
    ref_audio=REF_SHORT, ref_text=None,
    x_vector_only_mode=True,
)
print(f"  done in {time.time()-t:.1f}s · sr={sr} · samples={len(wavs[0])}", flush=True)
sf.write(str(OUT), wavs[0], sr)
print(f"  → {OUT}", flush=True)
print(f"  size={OUT.stat().st_size} bytes · duration={len(wavs[0])/sr:.1f}s")
