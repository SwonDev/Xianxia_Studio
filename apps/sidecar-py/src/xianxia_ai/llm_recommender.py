"""Hardware-aware sampling/runtime recommendations for a given GGUF.

Inspired by https://github.com/AlexsJones/llmfit — the rules are translated
into Python so the sidecar can compute them without spawning the upstream
Rust CLI. Two things drive the recommendation:

  1. GGUF metadata: architecture, embedding length, block count, training
     context, quantization scheme. We get all of these from `gguf_meta`.
  2. Detected hardware: VRAM (and free VRAM), RAM, CPU cores. The Rust
     supervisor exposes `detect_hardware()`; on the Python side we ping
     `/install/hardware` so the recommender works in both environments.

What we recommend:
  * `gpu_layers` (`-ngl`):
      Estimate per-layer VRAM as (embedding_length × 2 + 1) bytes for
      KV cache + (model_size_bytes / block_count) for the weights, summed
      across all attention heads. Reserve ~1.0 GB for compute + ~0.5 GB
      for the context KV cache scaled by context_size. Offload as many
      layers as fit in (vram_gb − reserved); cap at block_count.
  * `context_size` (`-c`):
      The smaller of GGUF training ctx and what the remaining VRAM
      supports. Default to 8192 when training ctx is unknown.
  * `flash_attention` (`-fa`):
      Enable on Ampere+ (cc 8.0+) NVIDIA cards. We approximate via VRAM
      ≥ 6 GB since cards smaller than that are typically Pascal/Turing.
      On Apple Silicon FA is a no-op but harmless.
  * `chat_template`:
      Use the embedded template from GGUF when present. Family-specific
      fallback name when it's not (Gemma → "gemma", Qwen → "chatml",
      Llama 3 → "llama3", Mistral → "mistral"); llama.cpp ships canonical
      templates under all those names.
  * Sampling parameters:
      Family-tuned defaults. Different model families respond very
      differently to temperature/top_p/repeat_penalty — Gemma 4 likes
      temp=1.0 top_k=64, Qwen3 likes temp=0.7 top_p=0.8, Mistral wants
      temp=0.7 top_p=0.95.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any


# Per-family sampling defaults. Sourced from each upstream's official
# generation_config.json on HuggingFace (verified at v0.2.0 ship time).
# When a model family doesn't match any of these the recommender returns
# a neutral profile and logs which family was detected.
_FAMILY_SAMPLING: dict[str, dict[str, float]] = {
    # google/gemma — Gemma 2/3/4 share the same recommended sampling per
    # the model cards. Adding more numeric suffixes is a no-op because
    # `_resolve_family()` strips trailing digits.
    "gemma": {"temperature": 1.0, "top_p": 0.95, "top_k": 64, "repeat_penalty": 1.0},
    # Qwen/Qwen3 — https://qwen.readthedocs.io/en/latest/inference/
    "qwen":  {"temperature": 0.7, "top_p": 0.8, "top_k": 20, "repeat_penalty": 1.05},
    # Meta Llama 3.x — defaults from generation_config.json.
    "llama": {"temperature": 0.6, "top_p": 0.9, "top_k": 50, "repeat_penalty": 1.1},
    # Mistral / Mixtral — generation_config.json defaults.
    "mistral": {"temperature": 0.7, "top_p": 0.95, "top_k": 50, "repeat_penalty": 1.0},
    # Phi-3 — Microsoft recommendation (greedy decoding for instruction).
    "phi": {"temperature": 0.0, "top_p": 1.0, "top_k": 0, "repeat_penalty": 1.0},
    # DeepSeek family.
    "deepseek": {"temperature": 0.6, "top_p": 0.95, "top_k": 0, "repeat_penalty": 1.0},
}


_FAMILY_TEMPLATE: dict[str, str] = {
    "gemma": "gemma",
    "qwen":  "chatml",
    "llama": "llama3",
    "mistral": "mistral-v3",
    "phi":   "phi3",
    "deepseek": "deepseek",
}


def _resolve_family(arch: str) -> str:
    """Strip the version suffix from an architecture string so the lookup
    tables don't need an entry per minor version.

    Examples:
        gemma4 → gemma
        gemma3 → gemma
        qwen3  → qwen
        qwen2  → qwen
        llama  → llama (unchanged)
        phi3   → phi
        deepseek2 → deepseek

    Architectures that contain alphabetic suffixes (e.g. "llama3_1") are
    progressively shortened until they hit a base entry or run out.
    """
    arch = (arch or "").lower().strip()
    if not arch:
        return ""
    # Greedy strip of trailing digits + underscore digits.
    base = arch
    while base and (base[-1].isdigit() or base[-1] in "._-"):
        base = base[:-1]
    if base in _FAMILY_SAMPLING:
        return base
    # Fallback: try contains-match (e.g. "llama3_1" or "mistral_v3" → "llama"/"mistral").
    for key in _FAMILY_SAMPLING:
        if arch.startswith(key):
            return key
    return ""


@dataclass
class HardwareSnapshot:
    """Subset of the supervisor's hardware report the recommender consumes."""
    vram_gb: float = 0.0
    ram_gb: float = 0.0
    cpu_cores: int = 0
    gpu_vendor: str = ""


@dataclass
class LlmRecommendation:
    """Output of `recommend()`. Maps 1:1 to `LlmModelConfig` on the Rust side."""
    gpu_layers: int
    context_size: int
    flash_attention: bool
    chat_template: str | None
    threads: int | None
    batch_size: int | None
    ubatch_size: int | None
    parallel: int
    sampling: dict[str, float]
    # Diagnostic field — explains WHY we picked these values. Surfaced in
    # the UI so an advanced user can sanity-check the recommendation
    # without diffing llmfit's source.
    rationale: list[str]


def recommend(
    *,
    gguf_path: str | Path,
    meta: "GgufMeta",  # type: ignore[name-defined]  (avoid runtime import cycle)
    hardware: HardwareSnapshot,
    file_size_bytes: int | None = None,
) -> LlmRecommendation:
    """Build a recommendation given the GGUF metadata + hardware snapshot.

    The result is intentionally generated even when fields are missing —
    we always return SOMETHING usable. Missing data falls back to safe
    defaults (cpu-only inference, 8K context, neutral sampling).
    """
    rationale: list[str] = []
    arch = (meta.architecture or "").lower()
    family = _resolve_family(arch)

    # ── Layers ──────────────────────────────────────────────────────
    block_count = meta.block_count or 32
    if file_size_bytes is None:
        try:
            file_size_bytes = Path(gguf_path).stat().st_size
        except OSError:
            file_size_bytes = 0
    file_size_gb = (file_size_bytes or 0) / 1_073_741_824.0

    embed = meta.embedding_length or 4096
    ctx_train = meta.context_length or 8192
    # Per-layer rough cost: model weights amortised across layers + KV cache.
    # KV cache per token = 2 × n_layers × n_kv_heads × head_dim × bytes,
    # but at this granularity we just use (embed × 4 bytes × ctx) split
    # by layer count.
    bytes_per_layer = file_size_bytes / max(block_count, 1) if file_size_bytes else 0
    ctx_target = min(ctx_train, 8192)
    kv_bytes_total = 2 * block_count * embed * ctx_target * 2  # fp16 KV
    kv_bytes_per_layer = kv_bytes_total / max(block_count, 1)

    if hardware.vram_gb <= 0.0:
        gpu_layers = 0
        rationale.append("no GPU detected → CPU-only inference (-ngl 0)")
    elif file_size_gb > 0 and file_size_gb <= hardware.vram_gb * 0.85:
        # **Common case**: model fits whole into VRAM with margin for KV
        # cache. Offload EVERYTHING (-ngl 99 → llama.cpp clamps to block_count
        # internally). The pipeline coordinates VRAM by killing llama-server
        # via /unload?target=llm before image/TTS phases, so we don't have
        # to be conservative here. This is what Ollama did implicitly in
        # v0.1.x and the reason it felt "fast" — full GPU offload + lazy
        # unload between phases.
        gpu_layers = 99
        rationale.append(
            f"VRAM {hardware.vram_gb:.1f} GB · file {file_size_gb:.2f} GB → fits whole, -ngl 99"
        )
    else:
        # Big-model fallback. The model alone doesn't fit; pick how many
        # layers can offload with the remaining VRAM after reserving 1.5
        # GB for KV cache + sampler + compute buffers. This regime is
        # slow (CPU spillover) but the user explicitly chose a model
        # bigger than their card — surface the rationale so they know
        # why it's slow.
        usable_vram = max(hardware.vram_gb - 1.5, 0.0) * 1_073_741_824.0
        per_layer = bytes_per_layer + kv_bytes_per_layer
        if per_layer <= 0:
            per_layer = 0.15 * 1_073_741_824.0
        max_offloadable = int(usable_vram // per_layer)
        gpu_layers = max(0, min(block_count, max_offloadable))
        rationale.append(
            f"VRAM {hardware.vram_gb:.1f} GB · file {file_size_gb:.2f} GB > 85% VRAM · "
            f"{block_count} layers → {gpu_layers}/-ngl (partial CPU spillover — slow)"
        )

    # ── Context size ────────────────────────────────────────────────
    if hardware.vram_gb < 4.0:
        context_size = min(ctx_train, 4096)
    elif hardware.vram_gb < 8.0:
        context_size = min(ctx_train, 8192)
    elif hardware.vram_gb < 16.0:
        context_size = min(ctx_train, 16384)
    else:
        context_size = min(ctx_train, 32768)
    rationale.append(f"context {context_size} (training ctx {ctx_train})")

    # ── Flash attention ─────────────────────────────────────────────
    fa = hardware.gpu_vendor.lower() in ("nvidia", "apple") and hardware.vram_gb >= 6.0
    if fa:
        rationale.append("flash_attention enabled (Ampere+ / Apple Silicon)")

    # ── Chat template ───────────────────────────────────────────────
    embedded = meta.chat_template
    if embedded and not embedded.startswith("<truncated"):
        # Honour the GGUF's authoritative template — pass None so llama-server
        # uses the embedded one directly. Don't try to outguess it.
        chat_template = None
        rationale.append("chat_template: using GGUF-embedded Jinja")
    else:
        chat_template = _FAMILY_TEMPLATE.get(family)
        if chat_template:
            rationale.append(f"chat_template '{chat_template}' (family={family}, arch={arch})")
        else:
            rationale.append(f"WARN no chat_template — unknown arch '{arch}' (resolved family='{family}')")

    # ── Threads / batch ─────────────────────────────────────────────
    threads = max(1, hardware.cpu_cores - 1) if hardware.cpu_cores else None
    # Batch sizes: prompt processing batch big enough to saturate the GPU,
    # ubatch ≤ batch. 512/128 is a reasonable default; raise if VRAM is huge.
    if hardware.vram_gb >= 16.0:
        batch_size, ubatch_size = 1024, 256
    elif hardware.vram_gb >= 6.0:
        batch_size, ubatch_size = 512, 128
    else:
        batch_size, ubatch_size = 256, 64
    rationale.append(f"batch -b {batch_size} -ub {ubatch_size}, threads -t {threads}")

    # ── Sampling ────────────────────────────────────────────────────
    sampling = _FAMILY_SAMPLING.get(family, {
        "temperature": 0.8, "top_p": 0.95, "top_k": 40, "repeat_penalty": 1.05,
    })
    sampling = dict(sampling)  # copy so callers can't mutate the table
    if family:
        rationale.append(f"sampling profile: {family}")
    else:
        rationale.append(f"sampling profile: neutral fallback (arch={arch!r} unknown)")

    return LlmRecommendation(
        gpu_layers=gpu_layers,
        context_size=context_size,
        flash_attention=fa,
        chat_template=chat_template,
        threads=threads,
        batch_size=batch_size,
        ubatch_size=ubatch_size,
        parallel=1,
        sampling=sampling,
        rationale=rationale,
    )


def detect_hardware_locally() -> HardwareSnapshot:
    """Best-effort local hardware probe. Used when the Rust supervisor
    isn't reachable (e.g. unit tests, standalone invocations of the
    recommender from a Python REPL).
    """
    snap = HardwareSnapshot()
    try:
        import psutil  # type: ignore
        snap.ram_gb = psutil.virtual_memory().total / 1_073_741_824.0
        snap.cpu_cores = psutil.cpu_count(logical=False) or psutil.cpu_count() or 0
    except Exception:
        pass
    # GPU detection: prefer torch.cuda, fall back to nvidia-smi parsing.
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            snap.vram_gb = total / 1_073_741_824.0
            try:
                snap.gpu_vendor = torch.cuda.get_device_properties(0).name.split()[0]
            except Exception:
                snap.gpu_vendor = "NVIDIA"
    except Exception:
        pass
    return snap
