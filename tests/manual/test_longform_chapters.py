"""
E2E smoke test — long-form chapter generation pipeline.

Tests against the LIVE sidecar Python on http://127.0.0.1:8731:

  1. POST /script/outline  → returns 3..6 chapters, each with a real title
     (not literally "Chapter N") and a numeric index.
  2. POST /script/chapter  (one per chapter, threaded running_summary)
     → each response contains [CHAPTER:, has > 50 words.
  3. Consecutive-chapter Jaccard word-overlap < 0.6 (anti-repeat sanity).
  4. Total assembled word count >= 0.7 × (target_minutes × 150).

No mock fallback. If the sidecar is unreachable the script FAILS loudly.
Exit code 0 on full PASS, non-zero on any assertion failure.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
import urllib.error
from typing import Any

# Force UTF-8 output so Spanish accents don't crash under Windows cp1252.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

BASE = "http://127.0.0.1:8731"
TOPIC = "la batalla de las Termópilas"
TARGET_MINUTES = 10
LANGUAGE = "es"
MODEL = "xianxia-llm"

# Lower-bound words per minute for the length assertion
WORDS_PER_MINUTE = 150
# Minimum total words: 70 % of the theoretical floor
MIN_TOTAL_WORDS = int(0.7 * TARGET_MINUTES * WORDS_PER_MINUTE)  # = 1050
# Pathologically-high Jaccard threshold (chapters must NOT be copy-paste)
MAX_JACCARD = 0.60
# Chapter word minimum
MIN_CHAPTER_WORDS = 50

TIMEOUT_OUTLINE = 300   # seconds — outline is fast
TIMEOUT_CHAPTER = 900   # seconds — each chapter goes through the LLM


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _post(path: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        BASE + path,
        data=body,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            elapsed = time.time() - t0
            raw = resp.read().decode("utf-8")
            print(f"  HTTP {resp.status}  ({elapsed:.1f}s)")
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        elapsed = time.time() - t0
        body_err = exc.read().decode("utf-8", errors="replace")
        print(f"  HTTP {exc.code}  ({elapsed:.1f}s)  body: {body_err[:400]}")
        raise


def _get(path: str, timeout: int = 10) -> dict[str, Any]:
    req = urllib.request.Request(BASE + path, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ── Jaccard helper ────────────────────────────────────────────────────────────

def _word_set(text: str) -> set[str]:
    """Lower-case word tokens, stripped of punctuation."""
    import re
    return set(re.sub(r"[^\w\s]", "", text.lower()).split())


def jaccard(a: str, b: str) -> float:
    sa, sb = _word_set(a), _word_set(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


# ── Assertion helper ──────────────────────────────────────────────────────────

def _assert(condition: bool, message: str) -> None:
    if not condition:
        print(f"\nFAIL: {message}")
        sys.exit(1)


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    print("=" * 60)
    print("E2E long-form chapters smoke test")
    print(f"  sidecar : {BASE}")
    print(f"  topic   : {TOPIC}")
    print(f"  minutes : {TARGET_MINUTES}")
    print(f"  language: {LANGUAGE}")
    print(f"  model   : {MODEL}")
    print("=" * 60)

    # ── [0] Health check — fail loudly if the sidecar is down ─────────────────
    print("\n[0] Health check…")
    try:
        health = _get("/health", timeout=10)
    except Exception as exc:
        print(f"\nFAIL: sidecar is NOT reachable at {BASE}  ({exc!r})")
        print("Start the sidecar before running this test.")
        return 1
    print(f"  encoder: {health.get('video_encoder_label', '(unknown)')}")

    # ── [1] POST /script/outline ──────────────────────────────────────────────
    print(f"\n[1] POST /script/outline (topic={TOPIC!r}, minutes={TARGET_MINUTES})…")
    t0 = time.time()
    outline_resp = _post(
        "/script/outline",
        {
            "topic": TOPIC,
            "target_minutes": TARGET_MINUTES,
            "language": LANGUAGE,
            "model": MODEL,
        },
        timeout=TIMEOUT_OUTLINE,
    )
    print(f"  total: {time.time()-t0:.1f}s")

    chapters = outline_resp.get("chapters")
    _assert(isinstance(chapters, list), f"outline.chapters is not a list: {outline_resp!r}")
    _assert(
        3 <= len(chapters) <= 6,
        f"Expected 3..6 chapters, got {len(chapters)}: {chapters}",
    )

    print(f"  chapters returned: {len(chapters)}")
    for c in chapters:
        title = (c.get("title") or "").strip()
        idx = c.get("index")
        _assert(bool(title), f"Chapter {idx} has empty title: {c!r}")
        # Titles should NOT be generic placeholder strings like "Chapter 1"
        _assert(
            "chapter" not in title.lower() or len(title) > 12,
            f"Chapter {idx} title looks like a bare placeholder: {title!r}",
        )
        _assert(idx is not None, f"Chapter missing 'index' field: {c!r}")
        print(f"    [{idx}] {title}")

    # ── [2] POST /script/chapter (sequential, thread running_summary) ─────────
    print(f"\n[2] Generating {len(chapters)} chapters sequentially…")
    chapter_texts: list[str] = []
    running_summary = ""
    last_idx = chapters[-1].get("index")

    for i, ch in enumerate(chapters):
        idx = ch.get("index")
        is_final = (idx == last_idx)
        print(f"\n  Chapter {idx}/{last_idx} ({ch.get('title', '')[:50]})  is_final={is_final}")
        t0 = time.time()
        resp = _post(
            "/script/chapter",
            {
                "topic": TOPIC,
                "language": LANGUAGE,
                "outline": chapters,
                "chapter_index": idx,
                "running_summary": running_summary,
                "is_final": is_final,
                "model": MODEL,
            },
            timeout=TIMEOUT_CHAPTER,
        )
        text = resp.get("text", "")
        words = resp.get("words") or len(text.split())
        running_summary = resp.get("running_summary", running_summary)
        print(f"    words: {words}  elapsed: {time.time()-t0:.1f}s")
        print(f"    first 80 chars: {text[:80]!r}")

        _assert(
            "[CHAPTER:" in text,
            f"Chapter {idx} text does not contain [CHAPTER: marker. Got: {text[:200]!r}",
        )
        _assert(
            words > MIN_CHAPTER_WORDS,
            f"Chapter {idx} is too short: {words} words (minimum {MIN_CHAPTER_WORDS})",
        )
        chapter_texts.append(text)

    # ── [3] Jaccard anti-repeat check ─────────────────────────────────────────
    print("\n[3] Consecutive Jaccard overlap check…")
    max_j = 0.0
    for i in range(len(chapter_texts) - 1):
        j = jaccard(chapter_texts[i], chapter_texts[i + 1])
        max_j = max(max_j, j)
        status = "OK" if j < MAX_JACCARD else "FAIL"
        print(f"  chapters {i+1}↔{i+2}: Jaccard={j:.3f}  [{status}]")
        _assert(
            j < MAX_JACCARD,
            f"Chapters {i+1} and {i+2} are pathologically similar "
            f"(Jaccard={j:.3f} >= {MAX_JACCARD}). "
            "The LLM may be repeating content.",
        )

    # ── [4] Total word count ──────────────────────────────────────────────────
    print("\n[4] Total word count check…")
    assembled = "\n\n".join(chapter_texts)
    total_words = len(assembled.split())
    print(f"  total words: {total_words}  (minimum required: {MIN_TOTAL_WORDS})")
    _assert(
        total_words >= MIN_TOTAL_WORDS,
        f"Assembled text too short: {total_words} words < {MIN_TOTAL_WORDS} "
        f"(= 0.7 × {TARGET_MINUTES} min × {WORDS_PER_MINUTE} wpm)",
    )

    # ── PASS summary ──────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("PASS")
    print(f"  chapters      : {len(chapter_texts)}")
    per_ch = "  |  ".join(
        f"ch{i+1}:{len(t.split())}w" for i, t in enumerate(chapter_texts)
    )
    print(f"  words/chapter : {per_ch}")
    print(f"  total words   : {total_words}  (min {MIN_TOTAL_WORDS})")
    print(f"  max Jaccard   : {max_j:.3f}  (max allowed {MAX_JACCARD})")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
