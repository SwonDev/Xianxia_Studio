# LTX-2.3 pinned facts (verificado upstream 2026-05-19)

Fuentes: model card `huggingface.co/Lightricks/LTX-2.3`, repo GGUF
`huggingface.co/unsloth/LTX-2.3-GGUF`, `docs.comfy.org/tutorials/video/ltx/ltx-2-3`,
`github.com/Lightricks/ComfyUI-LTXVideo`. Núcleo **empíricamente verificado**
por los benchmarks de esta sesión (los agentes descargaron y ejecutaron
estos ficheros reales en la RTX 4060 8GB → datos medidos, no asumidos).

**CORRECCIÓN 2026-05-19**: la tabla de assets de la versión anterior conflaba
nombres de `unsloth/LTX-2.3-GGUF` con los nombres canónicos que espera
ComfyUI. Se ha reemplazado por el set canónico derivado directamente del
example workflow instalado (`LTX-2.3_T2V_I2V_Single_Stage_Distilled_Full.json`)
y del código fuente de los nodos (`nodes_lt_audio.py`, `ComfyUI-GGUF/nodes.py`,
`folder_paths.py`). Ahora los tres artefactos (installer, workflows, este doc)
son consistentes.

## Modelo y variantes

LTX-2.3 = **22B** parámetros, DiT audio+vídeo. Líneas: `-dev` (base) y
`-distilled-1.1` (8 pasos, rápida — recomendada para producción).

## Set canónico de assets por tier

> **Invariante**: para cada tier, todo nombre de fichero referenciado por el
> workflow JSON == el fichero que el instalador descarga y coloca con ese
> nombre exacto en el subdirectorio correcto de `comfyui/models/`.

### Tier Full (VRAM ≥ 32 GB)

Nodo principal: `CheckpointLoaderSimple` (carga modelo + VAE + connector del mismo .safetensors)

| Nombre ComfyUI esperado | HF repo → fichero fuente | Subdir ComfyUI | Nodo que lo consume |
|---|---|---|---|
| `ltx-2.3-22b-dev-fp8.safetensors` | `Lightricks/LTX-2.3` → `ltx-2.3-22b-dev-fp8.safetensors` | `models/checkpoints/` | `CheckpointLoaderSimple.ckpt_name` |
| `comfy_gemma_3_12B_it.safetensors` | `Lightricks/LTX-2.3` → `comfy_gemma_3_12B_it.safetensors` | `models/text_encoders/` | `LTXAVTextEncoderLoader.text_encoder` |
| `ltx-2.3-22b-dev-fp8.safetensors` | (mismo fichero — ya descargado arriba) | `models/checkpoints/` | `LTXAVTextEncoderLoader.ckpt_name` |

**Nota Full tier**: `CheckpointLoaderSimple` devuelve (model, clip, vae) en slots 0/1/2.
El VAE viene embebido en el mismo checkpoint FP8; no se necesita `VAELoader` por separado.
`LTXAVTextEncoderLoader.ckpt_name` apunta al mismo archivo FP8 para extraer los
embeddings connector weights (`text_embedding_projection.*` keys).

### Tier Gguf (VRAM ≥ 24 GB)

Nodo principal: `UnetLoaderGGUF` + `VAELoader` separado

| Nombre ComfyUI esperado | HF repo → fichero fuente | Subdir ComfyUI | Nodo que lo consume |
|---|---|---|---|
| `ltx-2.3-22b-dev-Q4_K_M.gguf` | `unsloth/LTX-2.3-GGUF` → `ltx-2.3-22b-dev-Q4_K_M.gguf` | `models/diffusion_models/` | `UnetLoaderGGUF.unet_name` |
| `ltx-2.3-22b-dev_video_vae.safetensors` | `unsloth/LTX-2.3-GGUF` → `vae/ltx-2.3-22b-dev_video_vae.safetensors` | `models/vae/` | `VAELoader.vae_name` |
| `comfy_gemma_3_12B_it.safetensors` | `Lightricks/LTX-2.3` → `comfy_gemma_3_12B_it.safetensors` | `models/text_encoders/` | `LTXAVTextEncoderLoader.text_encoder` |
| `ltx-2.3-22b-dev_embeddings_connectors.safetensors` | `unsloth/LTX-2.3-GGUF` → `text_encoders/ltx-2.3-22b-dev_embeddings_connectors.safetensors` | `models/checkpoints/` | `LTXAVTextEncoderLoader.ckpt_name` |

**Nota Gguf tier**: `UnetLoaderGGUF` de ComfyUI-GGUF registra la clave `unet_gguf`
que `folder_paths` mapea a `models/diffusion_models/`. El VAE (slot 0 de `VAELoader`)
se pasa a `LTXVImgToVideoConditionOnly` y `LTXVTiledVAEDecode`. `LTXAVTextEncoderLoader`
espera su `ckpt_name` en `models/checkpoints/` según la definición de `execute()` en
`comfy_extras/nodes_lt_audio.py`: `folder_paths.get_full_path("checkpoints", ckpt_name)`.

**No se incluyen**: `gemma-3-12b-it-qat-UD-Q4_K_XL.gguf` ni `mmproj-BF16.gguf` —
estos son assets de `unsloth/LTX-2.3-GGUF` usados para inferencia local con llama.cpp,
no son los ficheros que `LTXAVTextEncoderLoader` (ComfyUI) espera. El workflow canónico
usa `comfy_gemma_3_12B_it.safetensors` (formato safetensors de Lightricks).

## Mapeo de directorios ComfyUI (`folder_paths.py`)

| Clave folder_paths | Directorio real |
|---|---|
| `checkpoints` | `comfyui/models/checkpoints/` |
| `text_encoders` | `comfyui/models/text_encoders/` o `models/clip/` |
| `diffusion_models` | `comfyui/models/diffusion_models/` o `models/unet/` |
| `vae` | `comfyui/models/vae/` |
| `unet_gguf` (ComfyUI-GGUF) | mapea a `diffusion_models` → `comfyui/models/diffusion_models/` |

## Hecho duro (medido en 4060 8GB esta sesión)

- T5-XXL NO sustituye al text encoder: LTX-2.3 exige Gemma-3 (hidden 4096);
  con T5 (2048) crashea en conditioning pre-denoise. **Gemma-3-12B es
  obligatorio** (~8 GB safetensors comfy).
- LTX-2.3 Q2_K (7.4 GB) fijó VRAM en 7.444/8.188 MiB y crasheó antes de
  denoise en 8 GB. Stack mínimo real (modelo + VAE 1.4 + connector 2.2 +
  Gemma-3-12B ~8-12 + activaciones) ≈ 23-30 GB.
- Oficial Lightricks: **32 GB+ VRAM** (24 GB "eficiente").

## Umbrales decididos (conservadores, GPU-only, sin CPU offload)

La fase LTX debe caber GPU-resident tras liberar las demás fases. Sumando
diffusion + VAE + connector + Gemma-3-12B + activaciones:

- **`Full` (FP8): VRAM ≥ 32 GB.** (`ltx-2.3-22b-dev-fp8.safetensors` + deps.)
- **`Gguf` (Q4_K_M): VRAM ≥ 24 GB.** (Q4_K_M 14.2 GB + VAE 1.4 + connector 2.2 + Gemma-3-12B ~8 + activaciones ≈ 26-28 GB → exige ≥24 GB con holgura; por debajo no es seguro GPU-resident.)
- **`None`: VRAM < 24 GB.** Incluye la 4060 8 GB del usuario → LTX nunca se ofrece ahí (probado imposible). Default = Z-Image+HyperFrames.

> Estos umbrales son el contrato para `hardware.rs::ltx_capability_for_vram`
> (Task 2) y el `Component` (Task 3).
