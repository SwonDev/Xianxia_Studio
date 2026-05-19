"""Minimal GGUF metadata reader — zero external dependencies.

Why hand-rolled instead of using the `gguf` pip package:
  The official `gguf` package (part of llama.cpp's python tooling) drags
  in numpy + sentencepiece + a half-megabyte of tokenizer code that the
  studio's sidecar never uses. We only need the KV header, which is the
  first ~50-200 KB of any GGUF file. A tight stdlib reader does the job.

What we extract:
  * general.architecture  ("llama" / "gemma3" / "qwen2" / ...)
  * general.name
  * general.quantization_version (and we infer Q4_K_M / Q5_K_M / ... from filename)
  * <arch>.context_length          → llama-server's `-c` ceiling
  * <arch>.embedding_length        → for VRAM-per-layer heuristics
  * <arch>.block_count             → "num_layers" for `-ngl` sizing
  * <arch>.attention.head_count
  * tokenizer.chat_template        → CRITICAL. Without the right template
    the model returns garbage / refuses to follow instructions. Stored
    in the GGUF as a Jinja2 source string.
  * tokenizer.ggml.eos_token_id, bos_token_id (for diagnostics)

Spec reference:
  https://github.com/ggml-org/ggml/blob/master/docs/gguf.md

Format (v3, all little-endian):
  magic        : "GGUF"           (4 bytes)
  version      : uint32           (currently 3)
  tensor_count : uint64
  kv_count     : uint64
  for kv_count times:
    key        : gguf_string      (uint64 length + utf-8 bytes)
    value_type : uint32           (enum, see GGUFValueType)
    value      : variable, depending on value_type
"""

from __future__ import annotations

import os
import re
import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


# Value type enum from the GGUF spec.
_T_UINT8 = 0
_T_INT8 = 1
_T_UINT16 = 2
_T_INT16 = 3
_T_UINT32 = 4
_T_INT32 = 5
_T_FLOAT32 = 6
_T_BOOL = 7
_T_STRING = 8
_T_ARRAY = 9
_T_UINT64 = 10
_T_INT64 = 11
_T_FLOAT64 = 12

# Map value_type → (struct format, byte length). Strings and arrays are
# handled specially because their length is encoded inline.
_PRIMITIVE: dict[int, tuple[str, int]] = {
    _T_UINT8: ("<B", 1),
    _T_INT8: ("<b", 1),
    _T_UINT16: ("<H", 2),
    _T_INT16: ("<h", 2),
    _T_UINT32: ("<I", 4),
    _T_INT32: ("<i", 4),
    _T_FLOAT32: ("<f", 4),
    _T_BOOL: ("<?", 1),
    _T_UINT64: ("<Q", 8),
    _T_INT64: ("<q", 8),
    _T_FLOAT64: ("<d", 8),
}


@dataclass
class GgufMeta:
    path: str
    version: int
    tensor_count: int
    kv: dict[str, Any] = field(default_factory=dict)

    # Convenience accessors — keep them computed lazily so callers can
    # round-trip the metadata dict without going through these helpers.
    @property
    def architecture(self) -> str | None:
        v = self.kv.get("general.architecture")
        return str(v) if v is not None else None

    @property
    def name(self) -> str | None:
        v = self.kv.get("general.name")
        return str(v) if v is not None else None

    @property
    def context_length(self) -> int | None:
        arch = self.architecture or ""
        return _as_int(self.kv.get(f"{arch}.context_length"))

    @property
    def embedding_length(self) -> int | None:
        arch = self.architecture or ""
        return _as_int(self.kv.get(f"{arch}.embedding_length"))

    @property
    def block_count(self) -> int | None:
        """Number of transformer blocks ≈ what `-ngl` selects from."""
        arch = self.architecture or ""
        return _as_int(self.kv.get(f"{arch}.block_count"))

    @property
    def head_count(self) -> int | None:
        arch = self.architecture or ""
        return _as_int(self.kv.get(f"{arch}.attention.head_count"))

    @property
    def chat_template(self) -> str | None:
        v = self.kv.get("tokenizer.chat_template")
        return str(v) if v is not None else None

    @property
    def eos_token_id(self) -> int | None:
        return _as_int(self.kv.get("tokenizer.ggml.eos_token_id"))

    @property
    def bos_token_id(self) -> int | None:
        return _as_int(self.kv.get("tokenizer.ggml.bos_token_id"))


def _as_int(v: Any) -> int | None:
    if isinstance(v, bool):  # bool is a subclass of int — exclude explicitly
        return int(v)
    if isinstance(v, (int,)):
        return int(v)
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return None


def read_gguf_meta(path: str | os.PathLike, *, max_string_bytes: int = 1_000_000) -> GgufMeta:
    """Read the KV header of a GGUF file. Does NOT touch tensor data.

    `max_string_bytes` caps any single string-typed value so a malformed
    file (or a hostile one) can't make us allocate gigabytes. Realistic
    upper bound today: `tokenizer.chat_template` for big models tops out
    around 30 KB.
    """
    p = Path(path)
    with open(p, "rb") as f:
        magic = f.read(4)
        if magic != b"GGUF":
            raise ValueError(f"not a GGUF file (magic={magic!r}): {p}")
        version = _read_primitive(f, _T_UINT32)
        if version < 1 or version > 3:
            # Future-proof but verbose — older v1/v2 files exist in the
            # wild from early llama.cpp days; the header layout we read
            # here is forward-compatible.
            pass
        tensor_count = _read_primitive(f, _T_UINT64)
        kv_count = _read_primitive(f, _T_UINT64)

        kv: dict[str, Any] = {}
        for _ in range(int(kv_count)):
            key = _read_string(f, max_string_bytes)
            vtype = _read_primitive(f, _T_UINT32)
            try:
                value = _read_value(f, int(vtype), max_string_bytes)
            except Exception as exc:
                # Skip unreadable entries instead of crashing — the rest
                # of the KV table is still useful for the supervisor.
                kv[key] = f"<unreadable: {exc}>"
                continue
            kv[key] = value

    return GgufMeta(
        path=str(p),
        version=int(version),
        tensor_count=int(tensor_count),
        kv=kv,
    )


def _read_primitive(f, vtype: int) -> Any:
    fmt, n = _PRIMITIVE[vtype]
    buf = f.read(n)
    if len(buf) != n:
        raise EOFError(f"short read on primitive type {vtype}")
    return struct.unpack(fmt, buf)[0]


def _read_string(f, max_bytes: int) -> str:
    length = _read_primitive(f, _T_UINT64)
    if length > max_bytes:
        # Skip the body but record the truncation so the caller knows.
        f.seek(int(length), os.SEEK_CUR)
        return f"<truncated string len={length}>"
    data = f.read(int(length))
    if len(data) != length:
        raise EOFError(f"short string read: wanted {length}, got {len(data)}")
    return data.decode("utf-8", errors="replace")


def _read_value(f, vtype: int, max_bytes: int) -> Any:
    if vtype in _PRIMITIVE:
        return _read_primitive(f, vtype)
    if vtype == _T_STRING:
        return _read_string(f, max_bytes)
    if vtype == _T_ARRAY:
        inner_type = _read_primitive(f, _T_UINT32)
        n = _read_primitive(f, _T_UINT64)
        # Common case: array of strings or ints (tokenizer.ggml.tokens,
        # tokenizer.ggml.scores). For values we expose to the caller we
        # truncate huge arrays — the supervisor doesn't need the full
        # vocab to pick `-ngl`.
        cap = min(int(n), 256)
        out: list[Any] = []
        for i in range(int(n)):
            v = _read_value(f, int(inner_type), max_bytes)
            if i < cap:
                out.append(v)
        if int(n) > cap:
            out.append(f"<… {int(n) - cap} more elements truncated>")
        return out
    raise ValueError(f"unknown GGUF value type: {vtype}")


# ── Quantization filename heuristic ─────────────────────────────────
# HF GGUF repos encode the quantization scheme in the filename rather
# than always emitting `general.quantization_version` in the KV header
# (e.g. mradermacher repos drop the KV but keep the suffix). We sniff
# the filename so the UI can show "Q4_K_M" / "Q5_K_M" / "Q8_0" / etc.

_QUANT_RE = re.compile(
    r"\b(IQ\d_\w+|Q\d_\w+|F16|F32|BF16)\b",
    re.IGNORECASE,
)


def quantization_from_filename(path: str | os.PathLike) -> str | None:
    """Returns "Q4_K_M" / "Q5_K_S" / ... derived from the GGUF filename.

    Returns None when the filename doesn't match any known pattern (rare
    today — every llama.cpp-friendly GGUF on HF uses the convention).
    """
    name = Path(path).name
    m = _QUANT_RE.search(name)
    return m.group(1).upper() if m else None
