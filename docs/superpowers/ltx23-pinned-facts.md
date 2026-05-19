# LTX-2.3 pinned facts (verificado upstream 2026-05-19)

Fuentes: model card `huggingface.co/Lightricks/LTX-2.3`, repo GGUF
`huggingface.co/unsloth/LTX-2.3-GGUF`, `docs.comfy.org/tutorials/video/ltx/ltx-2-3`,
`github.com/Lightricks/ComfyUI-LTXVideo`. Núcleo **empíricamente verificado**
por los benchmarks de esta sesión (los agentes descargaron y ejecutaron
estos ficheros reales en la RTX 4060 8GB → datos medidos, no asumidos).

## Modelo y variantes

LTX-2.3 = **22B** parámetros, DiT audio+vídeo. Líneas: `-dev` (base) y
`-distilled-1.1` (8 pasos, rápida — recomendada para producción).

| Concepto | Valor exacto | Fuente |
|---|---|---|
| Repo full/FP8 | `Lightricks/LTX-2.3` → `ltx-2.3-22b-dev.safetensors` (BF16 ~42 GB), `ltx-2.3-22b-dev-fp8.safetensors` (FP8) | HF model card |
| Repo GGUF | `unsloth/LTX-2.3-GGUF` | HF (benchmark descargó de aquí) |
| GGUF Q2_K | `ltx-2.3-22b-dev-Q2_K` 10.9 GB · `…-UD-Q2_K` 7.94 GB · (distilled-1.1-Q2_K ≈ 7.4 GB, medido) | unsloth |
| GGUF Q3_K_M | `ltx-2.3-22b-dev-Q3_K_M` 10.6 GB · UD 13.4 GB | unsloth |
| GGUF Q4_K_M | `ltx-2.3-22b-dev-Q4_K_M` 14.2 GB · UD 16.4 GB | unsloth |
| GGUF Q5/Q6 | 15–17.8 GB | unsloth |
| GGUF Q8_0 | `ltx-2.3-22b-dev-Q8_0` 22.8 GB | unsloth |
| Video VAE | `vae/ltx-2.3-22b-dev_video_vae.safetensors` (~1.35 GB, medido) | unsloth |
| Audio VAE | `vae/ltx-2.3-22b-dev_audio_vae.safetensors` (~0.35 GB, medido) | unsloth |
| Embeddings connector | `text_encoders/ltx-2.3-22b-dev_embeddings_connectors.safetensors` (~2.2 GB) | unsloth |
| Text encoder (OBLIGATORIO Gemma-3) | GGUF: `gemma-3-12b-it-qat-UD-Q4_K_XL.gguf` · ComfyUI safetensors: `gemma_3_12B_it_fp4_mixed.safetensors` · + `mmproj-BF16.gguf` | unsloth / docs.comfy |
| Spatial upscaler (opcional) | `ltx-2.3-spatial-upscaler-x2-1.0.safetensors` → `models/latent_upscale_models/` | docs.comfy |
| Nodos ComfyUI | repo `Lightricks/ComfyUI-LTXVideo` commit `229437c` (2026-05-11) + `ComfyUI-GGUF` v2.0.0 (`UnetLoaderGGUF`/`CLIPLoaderGGUF`) para GGUF. **Nombres de clase de nodo img2video: confirmar leyendo el workflow JSON oficial / nodos instalados en Task 4** (la doc no los lista; el benchmark confirmó que ComfyUI core 0.20.1 + estos custom nodes cargan el modelo). | github |

## Hecho duro (medido en 4060 8GB esta sesión)

- T5-XXL NO sustituye al text encoder: LTX-2.3 exige Gemma-3 (hidden 4096);
  con T5 (2048) crashea en conditioning pre-denoise. **Gemma-3-12B es
  obligatorio** (~8 GB Q4 / más en fp4-mixed).
- LTX-2.3 Q2_K (7.4 GB) fijó VRAM en 7.444/8.188 MiB y crasheó antes de
  denoise en 8 GB. Stack mínimo real (modelo + VAE 1.4 + connector 2.2 +
  Gemma-3-12B ~8-12 + activaciones) ≈ 23-30 GB.
- Oficial Lightricks: **32 GB+ VRAM** (24 GB "eficiente").

## Umbrales decididos (conservadores, GPU-only, sin CPU offload)

La fase LTX debe caber GPU-resident tras liberar las demás fases. Sumando
diffusion + VAE + connector + Gemma-3-12B + activaciones:

- **`Full` (FP8/BF16): VRAM ≥ 32 GB.** (`ltx-2.3-22b-dev-fp8.safetensors` + deps.)
- **`Gguf` (Q4_K_M/Q5): VRAM ≥ 24 GB.** (Q4_K_M 14.2 GB + VAE 1.4 + connector 2.2 + Gemma-3-12B ~8 + activaciones ≈ 26-28 GB → exige ≥24 GB con holgura; por debajo no es seguro GPU-resident.)
- **`None`: VRAM < 24 GB.** Incluye la 4060 8 GB del usuario → LTX nunca se ofrece ahí (probado imposible). Default = Z-Image+HyperFrames.

> Estos umbrales son el contrato para `hardware.rs::ltx_capability_for_vram`
> (Task 2) y el `Component` (Task 3). Variante a auto-instalar: `Gguf` →
> `ltx-2.3-22b-distilled-1.1` Q4_K_M GGUF (mejor calidad/VRAM en ≥24 GB);
> `Full` → `ltx-2.3-22b-dev-fp8.safetensors`. Más VAE vídeo + connector +
> `gemma_3_12B_it_fp4_mixed.safetensors` + nodos ComfyUI-LTXVideo/GGUF.
