"""LLM generation helpers — thin compatibility wrapper around `llm_backend`.

History:
  This module was the studio's only LLM entry point during v0.1.x, hard-bound
  to Ollama's /api/chat. The v0.2.0 migration introduces a backend abstraction
  (`llm_backend.py`) that supports both llama.cpp and Ollama transparently.
  We keep `generate(...)` here as a shim so existing callers don't break —
  every call now routes through `get_backend().generate(...)`.

Public API (unchanged signature, normalised response shape):
    generate(*, model, prompt, system=None, options=None, format=None,
             think=True, max_continuations=6, client=None, timeout=600)
        Returns:
          response       — visible answer concatenated across continuations
          thinking       — internal chain-of-thought (Ollama only; "" on llama.cpp)
          total_tokens   — eval_count summed
          continuations  — how many continuation rounds were needed
          done_reason    — terminal reason (stop / length)
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from .llm_backend import OLLAMA_URL, get_backend  # re-export for legacy imports


async def generate(
    *,
    model: str,
    prompt: str,
    system: str | None = None,
    options: dict[str, Any] | None = None,
    format: str | None = None,
    think: bool = True,
    max_continuations: int = 6,
    client: httpx.AsyncClient | None = None,
    timeout: float = 600.0,
) -> dict[str, Any]:
    backend = get_backend()
    return await backend.generate(
        model=model,
        prompt=prompt,
        system=system,
        options=options,
        format=format,
        think=think,
        max_continuations=max_continuations,
        client=client,
        timeout=timeout,
    )


def generate_sync(**kwargs) -> dict[str, Any]:
    return asyncio.run(generate(**kwargs))


__all__ = ["generate", "generate_sync", "OLLAMA_URL", "get_backend"]
