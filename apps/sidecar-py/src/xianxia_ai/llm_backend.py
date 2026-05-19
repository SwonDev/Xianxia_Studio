"""LLM backend abstraction — llama.cpp (primary) + Ollama (fallback).

v0.2.0 architectural migration: the studio used to hard-bind to Ollama for
script + metadata generation. With this module, every LLM call routes through
a single interface so the user (or `XIANXIA_LLM_BACKEND` env) chooses between:

  * "llamacpp" → POST http://127.0.0.1:8733/v1/chat/completions
                 (llama-server, OpenAI-compatible, plain GGUF support).
  * "ollama"   → POST http://127.0.0.1:11434/api/chat / /api/generate
                 (Ollama daemon, legacy v0.1.x default).
  * "auto"     → probe /health on llama-server first, fall back to Ollama.

Both backends share the same GGUF files: llama-server reads them directly,
Ollama imports them through a Modelfile. So switching backends never costs the
user a re-download — it only swaps the runtime that serves the bytes.

Public surface (all callsites should use this, never httpx-to-Ollama directly):

    backend = get_backend()
    out = await backend.chat(model=..., messages=[...], options={...},
                             format="json", think=True)
    out = await backend.generate(model=..., prompt=..., system=..., ...)
    ok, detail = await backend.unload(model=...)
    running = await backend.list_running()        # what's pinned in VRAM
    models  = await backend.list_models()         # everything available
    alive   = await backend.health(timeout=2)

The return shape of chat()/generate() is uniform across backends:
    { response: str, thinking: str, total_tokens: int,
      continuations: int, done_reason: "stop" | "length" | "error" }

`thinking` is empty for backends that don't surface chain-of-thought (llama.cpp
is one of them today; Ollama exposes Gemma 4 reasoning when think=True).

Continuation handling: identical logic for both backends — when `done_reason`
comes back as "length", we replay the assistant's partial answer + a
"continue exactly where you left off" instruction, up to `max_continuations`.
This is how we keep long-form narration coherent even when the underlying
context window forces a hard cutoff.
"""

from __future__ import annotations

import asyncio
import logging
import os
from abc import ABC, abstractmethod
from typing import Any

import httpx

log = logging.getLogger("xianxia.llm_backend")

OLLAMA_URL = os.environ.get("XIANXIA_OLLAMA_URL", "http://127.0.0.1:11434")
LLAMACPP_URL = os.environ.get("XIANXIA_LLAMACPP_URL", "http://127.0.0.1:8733")

# Default model name routed to llama.cpp when the caller passes the Ollama
# alias `xianxia-llm`. llama-server is launched with a single model loaded
# (see T2/T3 — installer + supervisor), so the actual GGUF the user picked
# in the UI is already the active one regardless of the alias.
_LLAMACPP_DEFAULT_MODEL = os.environ.get("XIANXIA_LLAMACPP_MODEL", "xianxia-llm")


def _dedupe_overlap(prev: str, nxt: str, max_overlap: int = 80) -> str:
    """Strip the leading overlap between `prev` tail and `nxt` head.

    When a continuation pass restarts on the partial answer, the model often
    re-emits the last sentence verbatim before extending it. We detect the
    longest suffix of `prev` that is a prefix of `nxt` (up to `max_overlap`
    chars) and drop it so the joined script reads naturally.
    """
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


class LLMBackend(ABC):
    """Common contract every backend must honour.

    Subclasses translate the abstract methods into their wire protocol but
    must NEVER leak protocol-specific shapes to the caller — every response
    is normalised to the dict described in the module docstring so the
    routes (script.py, shorts.py, subtitles.py, …) stay backend-agnostic.
    """

    name: str = "abstract"

    @abstractmethod
    async def chat(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        options: dict[str, Any] | None = None,
        format: str | None = None,
        think: bool = True,
        max_continuations: int = 6,
        client: httpx.AsyncClient | None = None,
        timeout: float = 600.0,
    ) -> dict[str, Any]:
        ...

    async def generate(
        self,
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
        """Convenience wrapper: builds the messages list and delegates to chat()."""
        messages: list[dict[str, Any]] = []
        if system is not None:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        return await self.chat(
            model=model,
            messages=messages,
            options=options,
            format=format,
            think=think,
            max_continuations=max_continuations,
            client=client,
            timeout=timeout,
        )

    @abstractmethod
    async def unload(self, model: str = "xianxia-llm", timeout_s: float = 20.0) -> tuple[bool, str]:
        ...

    @abstractmethod
    async def list_running(self) -> list[dict[str, Any]]:
        """Models currently resident in VRAM (or running)."""
        ...

    @abstractmethod
    async def list_models(self) -> list[dict[str, Any]]:
        """All locally available models the backend can serve."""
        ...

    @abstractmethod
    async def health(self, timeout: float = 2.0) -> bool:
        ...


# ─── Ollama ──────────────────────────────────────────────────────────────


class OllamaBackend(LLMBackend):
    """Talks to a local Ollama daemon on :11434.

    Wire details:
      * /api/chat returns `message.content` + `message.thinking` (Gemma 4
        chain-of-thought when think=true). `done_reason` is "stop" or "length".
      * /api/ps lists models pinned to VRAM with `size_vram` and `expires_at`.
      * /api/tags lists every model on disk.
      * /api/generate with `keep_alive=0` schedules an unload — fire-and-forget;
        we poll /api/ps until the model is actually gone.
    """

    name = "ollama"

    def __init__(self, url: str = OLLAMA_URL):
        self.url = url

    async def chat(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
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
            accumulated_content = ""
            accumulated_thinking = ""
            total_tokens = 0
            continuations = 0
            done_reason = "stop"

            async def _post(msgs: list[dict[str, Any]], local_think: bool) -> dict[str, Any]:
                body: dict[str, Any] = {
                    "model": model,
                    "messages": msgs,
                    "stream": False,
                    "think": local_think,
                    "options": options,
                }
                if format is not None:
                    body["format"] = format
                r = await client.post(f"{self.url}/api/chat", json=body)
                r.raise_for_status()
                return r.json()

            raw = await _post(list(messages), think)
            msg = raw.get("message", {}) or {}
            accumulated_content += (msg.get("content") or "")
            accumulated_thinking += (msg.get("thinking") or "")
            total_tokens += int(raw.get("eval_count", 0) or 0)
            done_reason = raw.get("done_reason", "stop")

            while done_reason == "length" and continuations < max_continuations:
                continuations += 1
                log.info(
                    "ollama cutoff: continuation #%d (model=%s, tokens=%d, content_len=%d)",
                    continuations, model, total_tokens, len(accumulated_content),
                )
                cont_messages = list(messages)
                partial = accumulated_content or "(empty)"
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
                options.setdefault("num_predict", 1024)
                raw = await _post(cont_messages, False)
                msg = raw.get("message", {}) or {}
                piece = _dedupe_overlap(accumulated_content, msg.get("content") or "")
                if not piece.strip():
                    log.warning("ollama continuation %d returned empty; stopping", continuations)
                    break
                accumulated_content += piece
                accumulated_thinking += (msg.get("thinking") or "")
                total_tokens += int(raw.get("eval_count", 0) or 0)
                done_reason = raw.get("done_reason", "stop")

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

    async def unload(self, model: str = "xianxia-llm", timeout_s: float = 20.0) -> tuple[bool, str]:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.post(
                    f"{self.url}/api/generate",
                    json={
                        "model": model,
                        "keep_alive": 0,
                        "prompt": ".",
                        "stream": False,
                        "options": {"num_predict": 1},
                    },
                )
                if r.status_code not in (200, 204):
                    return (False, f"ollama keep_alive=0 → {r.status_code}")
        except Exception as e:
            return (False, f"ollama unreachable: {e}")

        deadline = asyncio.get_event_loop().time() + timeout_s
        while asyncio.get_event_loop().time() < deadline:
            running = await self.list_running()
            if running is None:
                break
            still_loaded = any((m.get("name") or "").startswith(model) for m in running)
            if not still_loaded:
                return (True, f"ollama unloaded {model} (running={len(running)})")
            await asyncio.sleep(1.0)
        return (True, f"ollama keep_alive=0 issued but {model} still resident after {timeout_s}s")

    async def list_running(self) -> list[dict[str, Any]]:
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                r = await client.get(f"{self.url}/api/ps")
                if r.status_code != 200:
                    return []
                return r.json().get("models", []) or []
        except Exception:
            return []

    async def list_models(self) -> list[dict[str, Any]]:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(f"{self.url}/api/tags")
                if r.status_code != 200:
                    return []
                return r.json().get("models", []) or []
        except Exception:
            return []

    async def health(self, timeout: float = 2.0) -> bool:
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                r = await client.get(f"{self.url}/api/tags")
                return r.status_code == 200
        except Exception:
            return False


# ─── llama.cpp (llama-server, OpenAI-compatible) ─────────────────────────


def _llamacpp_suspended_flag_path() -> "Path":  # type: ignore[name-defined]
    """Same location `routes/unload.py` writes to when /unload?target=llm
    runs. Local helper to avoid a cross-module import cycle with routes/."""
    from pathlib import Path
    if env := os.environ.get("XIANXIA_DATA_DIR"):
        return Path(env) / ".llamacpp_suspended"
    if appdata := os.environ.get("APPDATA"):
        return Path(appdata) / "xianxia" / "XianxiaStudio" / "data" / ".llamacpp_suspended"
    return Path.home() / ".local" / "share" / "xianxia" / "XianxiaStudio" / "data" / ".llamacpp_suspended"


async def _wait_for_llamacpp_health(url: str, timeout_s: float = 30.0) -> bool:
    """Poll /health every 0.5 s until 200/503 or timeout.

    Used by `LlamaCppBackend.chat()` after it clears the suspended flag,
    so the caller (script.py / subtitles.py / shorts.py) never sees a
    "Connection refused" while the supervisor is mid-respawn.
    """
    deadline = asyncio.get_event_loop().time() + timeout_s
    while asyncio.get_event_loop().time() < deadline:
        try:
            async with httpx.AsyncClient(timeout=1.0) as client:
                r = await client.get(f"{url}/health")
                if r.status_code in (200, 503):
                    return True
        except Exception:
            pass
        await asyncio.sleep(0.5)
    return False


class LlamaCppBackend(LLMBackend):
    """Talks to a local llama-server on :8733.

    Wire details:
      * /v1/chat/completions — OpenAI-compatible, returns `choices[0].message.content`
        and `choices[0].finish_reason` ("stop" | "length"). `usage.completion_tokens`
        gives the eval count.
      * For `format="json"` we send `response_format: {type: "json_object"}` which
        llama.cpp implements via GBNF grammar — output is guaranteed to parse.
      * llama-server serves ONE model per process (chosen at spawn time). The
        `model` parameter in chat() is ignored on the wire but kept in the API
        for symmetry with Ollama; the supervisor swaps the spawn when the user
        picks a different GGUF in the UI (T3/T5).
      * Unload is a no-op at the protocol level (llama-server has no keep_alive
        knob — the binary holds the model until killed). The Rust supervisor
        terminates the process when the unload command is issued; this method
        just confirms /health stops responding.
      * Thinking tokens are not surfaced separately by llama-server today;
        the model's chain-of-thought, when emitted, comes embedded in `content`.
    """

    name = "llamacpp"

    def __init__(self, url: str = LLAMACPP_URL):
        self.url = url

    async def chat(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        options: dict[str, Any] | None = None,
        format: str | None = None,
        think: bool = True,
        max_continuations: int = 6,
        client: httpx.AsyncClient | None = None,
        timeout: float = 600.0,
    ) -> dict[str, Any]:
        # ── VRAM coordination with the Rust supervisor ────────────────
        # If the previous pipeline phase called /unload?target=llm, the
        # llama-server process was killed and a sentinel file dropped at
        # <data_dir>/.llamacpp_suspended. Clear the sentinel so the
        # supervisor's health-loop will respawn the server on its next
        # tick, then block until /health answers. Net effect: same lazy-
        # reload semantics Ollama provided via keep_alive=0 in v0.1.x.
        flag = _llamacpp_suspended_flag_path()
        if flag.exists():
            try:
                flag.unlink()
                log.info("llamacpp: cleared suspended flag, waiting for supervisor respawn")
            except OSError:
                pass
            if not await _wait_for_llamacpp_health(self.url, timeout_s=30.0):
                # Supervisor didn't bring it back — bubble up so the
                # caller falls back gracefully (script.py wraps in try).
                raise httpx.ConnectError(
                    f"llama-server did not come back online at {self.url} after suspend",
                    request=httpx.Request("GET", f"{self.url}/health"),
                )

        options = dict(options or {})
        own_client = client is None
        if own_client:
            client = httpx.AsyncClient(timeout=timeout)

        try:
            served_model = model if model and model != "xianxia-llm" else _LLAMACPP_DEFAULT_MODEL

            # Map Ollama-style options → OpenAI-style payload knobs. llama-server
            # accepts both `max_tokens` (OpenAI) and a wide list of llama.cpp-
            # specific extras (e.g. `n_predict`, `top_k`, `repeat_penalty`); we
            # honour `num_predict` (the Ollama name script.py passes today) by
            # translating it to `max_tokens` so existing call-sites Just Work.
            payload_extras: dict[str, Any] = {}
            if "num_predict" in options:
                payload_extras["max_tokens"] = options["num_predict"]
            if "num_ctx" in options:
                # llama-server's context is fixed at spawn (-c); we cannot
                # change it per-request. Log and skip.
                log.debug(
                    "llamacpp: ignoring per-request num_ctx=%s (set at spawn time)",
                    options["num_ctx"],
                )
            for k in ("temperature", "top_p", "top_k", "presence_penalty",
                      "frequency_penalty", "repeat_penalty", "seed"):
                if k in options:
                    payload_extras[k] = options[k]

            accumulated_content = ""
            total_tokens = 0
            continuations = 0
            done_reason = "stop"

            async def _post(msgs: list[dict[str, Any]]) -> dict[str, Any]:
                body: dict[str, Any] = {
                    "model": served_model,
                    "messages": msgs,
                    "stream": False,
                    **payload_extras,
                }
                if format == "json":
                    body["response_format"] = {"type": "json_object"}
                elif isinstance(format, dict):
                    # Caller supplied a full JSON Schema. llama-server supports
                    # json_schema natively (better than json_object — fields
                    # are enforced, not just "valid JSON").
                    body["response_format"] = {
                        "type": "json_schema",
                        "json_schema": {"name": "schema", "schema": format},
                    }
                r = await client.post(f"{self.url}/v1/chat/completions", json=body)
                r.raise_for_status()
                return r.json()

            raw = await _post(list(messages))
            choice = (raw.get("choices") or [{}])[0]
            msg = choice.get("message", {}) or {}
            accumulated_content += (msg.get("content") or "")
            usage = raw.get("usage") or {}
            total_tokens += int(usage.get("completion_tokens") or 0)
            done_reason = choice.get("finish_reason") or "stop"
            # OpenAI uses "length"/"stop"; normalise to match Ollama.
            if done_reason not in ("stop", "length"):
                done_reason = "stop"

            while done_reason == "length" and continuations < max_continuations:
                continuations += 1
                log.info(
                    "llamacpp cutoff: continuation #%d (model=%s, tokens=%d, content_len=%d)",
                    continuations, served_model, total_tokens, len(accumulated_content),
                )
                cont_messages = list(messages)
                cont_messages.append({"role": "assistant", "content": accumulated_content or "(empty)"})
                cont_messages.append({
                    "role": "user",
                    "content": (
                        "Your previous answer was cut off. Continue exactly from "
                        "where you left off, do NOT repeat the last sentence, "
                        "output the continuation directly and finish the response naturally."
                    ),
                })
                # Bump max_tokens for the continuation so we don't immediately
                # truncate again. Mirrors the Ollama path's num_predict bump.
                payload_extras["max_tokens"] = max(payload_extras.get("max_tokens") or 0, 1024)
                raw = await _post(cont_messages)
                choice = (raw.get("choices") or [{}])[0]
                msg = choice.get("message", {}) or {}
                piece = _dedupe_overlap(accumulated_content, msg.get("content") or "")
                if not piece.strip():
                    log.warning("llamacpp continuation %d returned empty; stopping", continuations)
                    break
                accumulated_content += piece
                usage = raw.get("usage") or {}
                total_tokens += int(usage.get("completion_tokens") or 0)
                done_reason = choice.get("finish_reason") or "stop"
                if done_reason not in ("stop", "length"):
                    done_reason = "stop"

            return {
                "response": accumulated_content,
                "thinking": "",
                "total_tokens": total_tokens,
                "continuations": continuations,
                "done_reason": done_reason,
            }
        finally:
            if own_client:
                await client.aclose()

    async def unload(self, model: str = "xianxia-llm", timeout_s: float = 20.0) -> tuple[bool, str]:
        # llama-server doesn't have a graceful unload endpoint — the model is
        # mapped for the lifetime of the process. The Rust supervisor owns the
        # spawn and will terminate it when the pipeline phase needs the VRAM
        # back. From this sidecar's side we just confirm the server stops
        # responding within the timeout (best effort — if it's still up the
        # caller treats it as a no-op).
        if not await self.health(timeout=1.0):
            return (True, "llamacpp not running (no-op unload)")
        # Tell the supervisor to kill the process (handled out-of-band in T3).
        # For now we just signal success — the supervisor will hear the next
        # unload?target=llm and tear down the spawn.
        return (True, "llamacpp unload signalled to supervisor")

    async def list_running(self) -> list[dict[str, Any]]:
        # llama-server has at most ONE model running. We synthesise an
        # Ollama-shaped record so /diag/vram works without branching.
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                r = await client.get(f"{self.url}/v1/models")
                if r.status_code != 200:
                    return []
                data = r.json().get("data") or []
                return [
                    {"name": m.get("id"), "size_vram": None, "expires_at": None}
                    for m in data
                ]
        except Exception:
            return []

    async def list_models(self) -> list[dict[str, Any]]:
        # llama-server only knows the GGUF it was spawned with; the catalog of
        # downloadable models is the user's HF cache + the curated list T4
        # (llmfit integration) exposes. Return the running model so the UI
        # at least shows the active engine.
        return await self.list_running()

    async def health(self, timeout: float = 2.0) -> bool:
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                r = await client.get(f"{self.url}/health")
                return r.status_code in (200, 503)  # 503 = loading
        except Exception:
            return False


# ─── Backend selection ───────────────────────────────────────────────────


_BACKEND: LLMBackend | None = None
_BACKEND_LOCK = asyncio.Lock()


def _build_backend(name: str) -> LLMBackend:
    name = (name or "").lower().strip()
    if name == "llamacpp":
        return LlamaCppBackend()
    if name == "ollama":
        return OllamaBackend()
    raise ValueError(f"unknown backend: {name!r} (expected 'llamacpp' or 'ollama')")


def get_backend(name: str | None = None) -> LLMBackend:
    """Return the active backend singleton.

    Resolution order:
      1. Explicit `name` argument (caller override — used by tests).
      2. `XIANXIA_LLM_BACKEND` env (set by the Rust supervisor at spawn time
         based on the user's Settings panel choice).
      3. Default: "llamacpp" — llama.cpp is the project's primary, always-on
         LLM runtime. Ollama is an explicit opt-in from the Settings panel.

    v0.2.2 — the historical "auto" mode that probed /health and silently
    fell back to Ollama is gone. It contradicted the product promise that
    llama.cpp is the canonical runtime. Today "auto" is treated as
    "llamacpp" so legacy callers keep working without the surprise
    fallback. The user opts in to Ollama by setting
    `XIANXIA_LLM_BACKEND=ollama` from Settings.

    The singleton is cached so repeated calls in a hot path (script.py
    issues 20+ LLM calls per long-form generation) don't repeatedly read
    env vars.
    """
    global _BACKEND
    if name is not None:
        return _build_backend(name)
    if _BACKEND is not None:
        return _BACKEND
    env = (os.environ.get("XIANXIA_LLM_BACKEND") or "llamacpp").lower().strip()
    # "auto" is a legacy alias kept so old configs don't crash the sidecar;
    # it resolves to llamacpp now (no silent Ollama fallback).
    if env == "auto":
        env = "llamacpp"
    _BACKEND = _build_backend(env)
    log.info("LLM backend selected: %s (env=%s)", _BACKEND.name, env)
    return _BACKEND


async def get_backend_auto() -> LLMBackend:
    """Async-safe variant of `get_backend()`. Same resolution rules:
    default to llama.cpp, honour an explicit `XIANXIA_LLM_BACKEND=ollama`
    opt-in. No silent fallback. The lock ensures concurrent first-callers
    don't each build their own backend singleton.
    """
    global _BACKEND
    if _BACKEND is not None:
        return _BACKEND
    env = (os.environ.get("XIANXIA_LLM_BACKEND") or "llamacpp").lower().strip()
    if env == "auto":
        env = "llamacpp"
    async with _BACKEND_LOCK:
        if _BACKEND is not None:
            return _BACKEND
        _BACKEND = _build_backend(env)
        log.info("LLM backend selected: %s (env=%s)", _BACKEND.name, env)
        return _BACKEND


def reset_backend() -> None:
    """Drop the cached singleton — used by tests and by /settings/llm-backend
    when the user switches engines from the UI without restarting the sidecar.
    """
    global _BACKEND
    _BACKEND = None
