# Diseño — Alineación forzada (WhisperX-grade) + AudioSeal + Auditoría aditiva

Fecha: 2026-05-18 · Releases: v0.2.16 (alineación + consolidación + auditoría) y v0.2.17 (AudioSeal)

## Contexto y origen

Revisión del repo `debpalash/OmniVoice-Studio` (misma familia arquitectónica: Tauri 2 +
Rust + FastAPI + React/Vite, 100% local). Técnicas aprovechables mapeadas a puntos
débiles reales de Xianxia Studio. Descartado: auto-offload a CPU de OmniVoice (viola la
regla dura GPU-only). Descartado: registro pluggable de backends TTS (refactor, riesgo).

## Premisa verificada (regla verificar-upstream)

Runtime real = bundled Python 3.11.15 + torch 2.5.1+cu121. Verificado en
`%APPDATA%\xianxia\XianxiaStudio\data\runtime\python\python\python.exe`:
`torchaudio==2.5.1+cu121` instalado, `torchaudio.functional.forced_align` presente,
`torchaudio.pipelines.MMS_FA` (`Wav2Vec2FABundle`, API `get_model`/`get_tokenizer`/
`get_aligner`, sample_rate 16000). **Cero dependencias nuevas** para v0.2.16. WhisperX
internamente es faster-whisper + alineación forzada wav2vec2; reproducimos la técnica con
deps ya presentes, sin pyannote ni pins conflictivos.

## v0.2.16 — Workstream A: alineación forzada (aditivo, fallback duro)

Nuevo `apps/sidecar-py/src/xianxia_ai/models/aligner.py`:
- Singleton perezoso del bundle `MMS_FA` (model `with_star=False` + tokenizer + aligner),
  CUDA fp16; `unload()` con ritual gc + `empty_cache` + `synchronize` (igual que
  `whisper_model`).
- `refine_words(audio_path, segments, language) -> list[Word] | None`:
  1. VRAM gate (patrón `torch.cuda.mem_get_info()` como music.py); si insuficiente → `None`.
  2. `forced_align` sobre el WAV 16k mono + tokens de los `segments` de faster-whisper.
  3. Conversión token-spans → tiempos por palabra (ratio frames↔samples).
  4. Cualquier excepción / idioma no romanizable / modelo no descargable / gate fallido →
     `None` (log `warning`, **nunca** raise). Fallback per-palabra: si una palabra no
     alinea, conserva su timing original de faster-whisper.

Orden VRAM seguro (evita el conflicto de handles cuDNN del bug v0.1.22 "error 127"):
transcribe faster-whisper → obtener segments → **unload whisper** + sync → load aligner →
align → **unload aligner**. Nunca whisper + wav2vec2 co-residentes.

Integración:
- `subtitles.py`: tras `_do_transcribe()`, `refined = aligner.refine_words(...)`; si no
  `None` → alimenta `_segments_to_srt`/`_flatten_words`; si `None` → ruta actual idéntica.
  El `whisper_model.unload()` previo a traducción queda no-op (ya descargado) — inocuo.
- `shorts_auto.py /from_video`: refinar `words` entre el unload de whisper y
  `_group_into_sentences`. El guard cold-open negro v0.2.15 opera sobre words refinados.
- `/auto`: recibe `req.words` precomputadas; si no hay WAV no se puede alinear → se deja
  igual (sin regresión). Guard de `req.words` vacío/None añadido (defensa).

## v0.2.16 — Workstream C: consolidación faster-whisper

Helper único `whisper_model.transcribe_words(audio, language, *, vad=False)` con los
params permisivos anti-drop de `subtitles.py` (`vad_filter` configurable,
`condition_on_previous_text=False`, `no_speech_threshold=0.05`,
`compression_ratio_threshold=4.0`, `log_prob_threshold=-2.0`, `temperature=0.0`,
`beam_size=5`, `word_timestamps=True`). `shorts_auto.py /from_video` migra a este helper
(hoy usa `vad_filter=True` sin thresholds → riesgo de recorte de apertura, el bug que el
comentario de subtitles documenta). Subtitles mantiene comportamiento idéntico.

## v0.2.16 — Workstream auditoría aditiva (cero cambio observable)

- Dedupe del ritual unload-whisper inline en `subtitles.py` → usa el de `whisper_model`.
- Logging diagnóstico (`reason`/`exc`) en fases best-effort que tragan error (Fase 12 SEO
  y futura Fase 13).
- Guard `req.words` vacío en `/auto`.

## v0.2.17 — AudioSeal watermark (best-effort post-render)

- `requirements-watermark.txt` con `audioseal` + comentario do-not-remove. Import perezoso
  guardado; si ausente/falla → no-op silencioso (procedencia es nice-to-have).
- `routes/watermark.py` → `POST /watermark {video_path}`: extrae audio → AudioSeal
  `get_watermark` + suma → re-mux (copia vídeo, re-encode solo audio). Nunca 500.
- `pipeline/mod.rs` Fase 13 best-effort tras Fase 12 SEO, espejo exacto del patrón SEO
  (emit running → POST → `persist_step(13)` + done; fallo → `skipped`; nunca `?`-propaga).

## Garantías "sin romper nada"

- Todo aditivo con fallback duro: aligner/AudioSeal fallando ⇒ output idéntico al actual.
- parity-check.mjs: invariantes (fallback a `_flatten_words`; Fase 13 no `?`-propaga;
  requirements watermark; helper whisper consolidado).
- Validación 3 capas (directo → bundled → supervisor) por release antes de declarar done.
- 2 releases separadas para acotar superficie de validación.
