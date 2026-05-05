"""Ollama generation helpers with auto-continuation + Gemma 4 thinking support.

Why this exists:
  - Local LLMs hit `done_reason: "length"` whenever generation touches the
    `num_predict` ceiling. For an end-user "never let generation be partial,
    always keep going" experience we transparently chain continuation calls.
  - Gemma 4 (the xianxia-llm base) has *thinking* capability: it spends part
    of its output budget in <think>...</think> tokens that contain its chain
    of reasoning. Quality of the final answer goes UP with thinking enabled
    (the model literally plans the structure), so we keep it ON by default
    and use Ollama's `/api/chat` which returns `message.thinking` and
    `message.content` separately. That way we get the quality bump without
    losing the visible answer.

Public API:
  - generate(model, prompt, system=None, options=None, format=None,
             think=True, max_continuations=6, client=None, timeout=600)
    Returns:
      response       — the visible answer (concatenated across continuations)
      thinking       — the internal chain-of-thought (concatenated)
      total_tokens   — eval_count summed
      continuations  — how many continuation rounds were needed
      done_reason    — terminal reason (stop / length / error)
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

OLLAMA_URL = "http://127.0.0.1:11434"

log = logging.getLogger("xianxia.llm")


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
    options = dict(options or {})
    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(timeout=timeout)

    try:
        messages: list[dict[str, Any]] = []
        if system is not None:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        accumulated_content = ""
        accumulated_thinking = ""
        total_tokens = 0
        continuations = 0
        done_reason = "stop"

        async def _chat(msgs: list[dict[str, Any]]) -> dict[str, Any]:
            body = {
                "model": model,
                "messages": msgs,
                "stream": False,
                "think": think,
                "options": options,
            }
            if format is not None:
                body["format"] = format
            r = await client.post(f"{OLLAMA_URL}/api/chat", json=body)
            r.raise_for_status()
            return r.json()

        # Initial request
        raw = await _chat(messages)
        msg = raw.get("message", {}) or {}
        accumulated_content += (msg.get("content") or "")
        accumulated_thinking += (msg.get("thinking") or "")
        total_tokens += int(raw.get("eval_count", 0) or 0)
        done_reason = raw.get("done_reason", "stop")

        # Continuation loop. The model sees the partial assistant message and
        # is asked to keep going from where it left off.
        while done_reason == "length" and continuations < max_continuations:
            continuations += 1
            log.info(
                "LLM cutoff: continuation #%d (model=%s, tokens=%d, content_len=%d)",
                continuations, model, total_tokens, len(accumulated_content),
            )
            cont_messages = list(messages)
            # Inject the partial answer as an assistant turn, then prompt to
            # keep going. Skip thinking on continuations to maximise visible
            # output.
            partial = accumulated_content if accumulated_content else "(empty)"
            cont_messages.append({"role": "assistant", "content": partial})
            cont_messages.append({
                "role": "user",
                "content": (
                    "Your previous answer was cut off. Continue exactly from "
                    "where you left off, do NOT repeat the last sentence, "
                    "do NOT use thinking, output the continuation directly "
                    "and finish the response naturally."
                ),
            })
            # Continuation: skip thinking so all tokens go to visible output
            saved_think = think
            saved_options = dict(options)
            options.setdefault("num_predict", 1024)
            try:
                think_save = think
                # Temporarily flip think for the continuation call only
                async def _cont_chat() -> dict[str, Any]:
                    body = {
                        "model": model,
                        "messages": cont_messages,
                        "stream": False,
                        "think": False,
                        "options": options,
                    }
                    if format is not None:
                        body["format"] = format
                    r = await client.post(f"{OLLAMA_URL}/api/chat", json=body)
                    r.raise_for_status()
                    return r.json()
                raw = await _cont_chat()
            finally:
                options = saved_options

            msg = raw.get("message", {}) or {}
            piece = msg.get("content") or ""
            piece = _dedupe_overlap(accumulated_content, piece)
            if not piece.strip():
                log.warning("Continuation %d returned empty visible content; stopping", continuations)
                break
            accumulated_content += piece
            accumulated_thinking += (msg.get("thinking") or "")
            total_tokens += int(raw.get("eval_count", 0) or 0)
            done_reason = raw.get("done_reason", "stop")

        if done_reason == "length" and continuations >= max_continuations:
            log.warning(
                "Hit max_continuations=%d for model=%s (response is still 'length' truncated)",
                max_continuations, model,
            )

        return {
            "response": accumulated_content,
            "thinking": accumulated_thinking,
            "total_tokens": total_tokens,
            "continuations": continuations,
            "done_reason": done_reason,
        }
    finally:
        if own_client:
            await client.aclose()


def generate_sync(**kwargs) -> dict[str, Any]:
    return asyncio.run(generate(**kwargs))


def _dedupe_overlap(prev: str, nxt: str, max_overlap: int = 80) -> str:
    nxt = nxt.lstrip()
    if not nxt:
        return nxt
    tail = prev[-max_overlap:]
    best = 0
    for k in range(min(len(tail), len(nxt)), 0, -1):
        if tail.endswith(nxt[:k]):
            best = k
            break
    return nxt[best:]
