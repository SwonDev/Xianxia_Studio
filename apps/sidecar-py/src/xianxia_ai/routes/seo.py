"""SEO metadata PACK — upload-ready YouTube metadata, 100 % local.

v0.2.14. Inspired by the *operations layer* of public YouTube-automation
tools, but with the opposite philosophy: NO cloud APIs. The only model
call is the already-running local LLM (llama.cpp / Ollama, the same one
that wrote the script); everything else is deterministic Python so the
result is reproducible and free.

Pipeline: the Rust orchestrator runs this best-effort as the final step
(writes `seo.json` + `seo.txt` next to the MP4, never blocks). It is also
callable standalone from the Library panel for ANY finished project.

Honesty over the tools we took ideas from: chapters come from the REAL
`[CHAPTER:]` markers in the script (timestamps the rest of the pipeline
already uses for the video), never fabricated fixed-duration stamps.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..llm import generate as llm_generate
from ..logging_utils import log_event
from ..prompts import SEO_PROMPT_TEMPLATE
from .script import parse_markers

router = APIRouter()

# YouTube hard limits (2026): title 100 chars, description 5000, tags
# blob 500 chars, ≤15 hashtags counted, first 125 desc chars shown in
# search. Optimal title 50-70.
_TITLE_HARD = 100
_TITLE_LO, _TITLE_HI = 45, 70
_TAGS_BUDGET = 500
_DESC_HARD = 5000
_MAX_HASHTAGS = 15

# Section headers per language (English fallback). Content itself is
# written natively by the LLM; only these fixed labels are localised.
_HDR = {
    "en": ("WHAT YOU'LL SEE", "CHAPTERS", "ABOUT THIS VIDEO", "Music from a royalty-free local library."),
    "es": ("LO QUE VERÁS", "CAPÍTULOS", "SOBRE ESTE VÍDEO", "Música de una biblioteca local libre de derechos."),
    "pt": ("O QUE VOCÊ VAI VER", "CAPÍTULOS", "SOBRE ESTE VÍDEO", "Música de uma biblioteca local livre de direitos."),
    "fr": ("CE QUE VOUS VERREZ", "CHAPITRES", "À PROPOS DE CETTE VIDÉO", "Musique d'une bibliothèque locale libre de droits."),
    "de": ("WAS DICH ERWARTET", "KAPITEL", "ÜBER DIESES VIDEO", "Musik aus einer lokalen, lizenzfreien Bibliothek."),
    "it": ("COSA VEDRAI", "CAPITOLI", "INFORMAZIONI SUL VIDEO", "Musica da una libreria locale royalty-free."),
    "zh": ("本视频内容", "章节", "关于本视频", "音乐来自本地免版税曲库。"),
    "ja": ("この動画の内容", "チャプター", "この動画について", "音楽はローカルのロイヤリティフリー音源です。"),
    "ko": ("영상에서 보게 될 내용", "챕터", "영상 소개", "음악은 로열티 프리 로컬 라이브러리에서 가져왔습니다."),
    "ru": ("ЧТО ВЫ УВИДИТЕ", "ГЛАВЫ", "ОБ ЭТОМ ВИДЕО", "Музыка из локальной библиотеки без лицензионных отчислений."),
    "hi": ("इस वीडियो में", "अध्याय", "इस वीडियो के बारे में", "संगीत एक स्थानीय रॉयल्टी-मुक्त लाइब्रेरी से।"),
    "ar": ("ما الذي ستراه", "الفصول", "حول هذا الفيديو", "موسيقى من مكتبة محلية خالية من الحقوق."),
}

_STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
    "is", "are", "was", "were", "this", "that", "it", "as", "at", "by",
    "from", "his", "her", "their", "its", "be", "but", "not", "you",
}
_GENERIC_HASHTAGS = ["#documentary", "#history", "#story", "#mystery", "#explained"]


# ─── Request / response ────────────────────────────────────────────────────
class SEORequest(BaseModel):
    # Either pass `script` directly, or `project_id` (we read script.txt
    # written by the pipeline at phase 1 inside the project dir).
    script: str | None = None
    project_id: str | None = None
    topic: str = ""
    languages: list[str] = ["en"]
    model: str = "xianxia-llm"
    # When given, also writes seo.json + seo.txt here (the project dir).
    out_dir: str | None = None


class SEOResponse(BaseModel):
    title: str
    title_variants: list[str]
    primary_keyword: str
    secondary_keywords: list[str]
    descriptions: dict[str, str]  # lang -> full upload-ready description
    tags: list[str]
    hashtags: list[str]
    chapters: list[dict]  # [{timestamp: "mm:ss", seconds: int, title: str}]
    seo_score: int
    written_to: str | None = None


# ─── Helpers (deterministic, no API) ───────────────────────────────────────
def _project_dir(project_id: str) -> Path:
    base = os.environ.get("XIANXIA_DATA_DIR")
    if base:
        return Path(base) / "projects" / project_id
    return (
        Path(os.environ.get("APPDATA", ""))
        / "xianxia" / "XianxiaStudio" / "data" / "projects" / project_id
    )


def _resolve_script(req: SEORequest) -> str:
    if req.script and req.script.strip():
        return req.script
    if req.project_id:
        for cand in ("script.txt", "narration.txt"):
            p = _project_dir(req.project_id) / cand
            if p.is_file():
                try:
                    txt = p.read_text(encoding="utf-8", errors="ignore").strip()
                    if txt:
                        return txt
                except Exception:
                    pass
    raise HTTPException(
        422,
        "No script available: pass `script` or a `project_id` whose "
        "project dir contains script.txt",
    )


def _fmt_ts(seconds: float) -> str:
    s = max(0, int(round(seconds)))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"


def _title_case(s: str) -> str:
    small = {"a", "an", "and", "as", "at", "but", "by", "for", "if", "in",
             "of", "on", "or", "the", "to", "via", "vs", "with"}
    words = s.split()
    out = []
    for i, w in enumerate(words):
        lw = w.lower()
        if i != 0 and i != len(words) - 1 and lw in small:
            out.append(lw)
        elif w.isupper() and len(w) <= 7:  # keep intentional emphasis caps
            out.append(w)
        else:
            out.append(w[:1].upper() + w[1:])
    return " ".join(out)


def _clean_title(t: str) -> str:
    t = re.sub(r"\s+", " ", str(t or "").strip().strip('"“”‘’'))
    t = t.rstrip(".")
    if len(t) > _TITLE_HARD:
        t = t[: _TITLE_HARD - 1].rsplit(" ", 1)[0] + "…"
    return t


def _pick_title(cands: list[str], primary: str, topic: str) -> tuple[str, list[str]]:
    seen: list[str] = []
    for c in cands:
        c = _clean_title(c)
        if c and c.lower() not in {x.lower() for x in seen}:
            seen.append(c)
    if not seen:
        base = (topic or primary or "Untitled").strip()
        seen = [_title_case(base)]

    def score(t: str) -> tuple:
        ln = len(t)
        in_range = _TITLE_LO <= ln <= _TITLE_HI
        has_kw = bool(primary) and primary.lower() in t.lower()
        # prefer: keyword present, length in optimal band, closeness to 58
        return (has_kw, in_range, -abs(ln - 58))

    ranked = sorted(seen, key=score, reverse=True)
    best = _title_case(ranked[0])
    variants = [_title_case(x) for x in ranked[1:4]]
    return best, variants


def _norm_kw(s: str) -> str:
    return re.sub(r"\s+", " ", str(s or "").strip().lower()).strip(" ,.;:#")


def _build_tags(primary: str, secondary: list[str], topic: str,
                script_kw: list[str]) -> list[str]:
    ordered: list[str] = []
    seen: set[str] = set()

    def add(raw: str) -> None:
        k = _norm_kw(raw)
        if 2 <= len(k) <= 60 and k not in seen:
            seen.add(k)
            ordered.append(k)

    add(primary)
    t = _norm_kw(topic)
    if t:
        add(t)
    for s in secondary:
        add(s)
    # long-tail (topic/primary-agnostic templates, only if we have a base)
    base = t or _norm_kw(primary)
    if base:
        for tmpl in (f"{base} explained", f"{base} documentary",
                     f"the story of {base}", f"{base} history", f"who was {base}"):
            add(tmpl)
    for k in script_kw:
        add(k)

    # 500-char comma-budget (YouTube counts the joined blob)
    out: list[str] = []
    total = 0
    for tag in ordered:
        extra = len(tag) + (1 if out else 0)
        if total + extra > _TAGS_BUDGET:
            continue
        out.append(tag)
        total += extra
    return out


def _build_hashtags(primary: str, topic: str, secondary: list[str]) -> list[str]:
    tags: list[str] = []
    seen: set[str] = set()

    def add(phrase: str) -> None:
        slug = re.sub(r"[^0-9a-zÀ-￿]", "", _norm_kw(phrase).replace(" ", ""))
        if 2 <= len(slug) <= 30:
            h = "#" + slug
            if h.lower() not in seen:
                seen.add(h.lower())
                tags.append(h)

    add(topic or primary)
    add(primary)
    for s in secondary[:4]:
        add(s)
    for g in _GENERIC_HASHTAGS:
        if g.lower() not in seen:
            seen.add(g.lower())
            tags.append(g)
    return tags[:_MAX_HASHTAGS]


def _chapters_from_markers(script: str) -> list[dict]:
    """Real YouTube chapters from the script's [CHAPTER:] markers.

    YouTube requires: first chapter at 0:00, ≥3 chapters, each ≥10 s.
    If the script doesn't satisfy that we return [] (NEVER fabricate —
    fake timestamps desync from the actual video and break trust)."""
    try:
        _, markers = parse_markers(script)
    except Exception:
        return []
    chs = sorted(
        [m for m in markers if m.kind == "chapter" and m.title],
        key=lambda m: m.timestamp_seconds,
    )
    if len(chs) < 2:
        return []
    out: list[dict] = []
    last = -10.0
    for i, m in enumerate(chs):
        sec = 0.0 if i == 0 else float(m.timestamp_seconds)
        if i > 0 and sec - last < 10.0:
            continue
        title = re.sub(r"\s+", " ", str(m.title).strip())[:90]
        if not title:
            continue
        out.append({"timestamp": _fmt_ts(sec), "seconds": int(round(sec)),
                    "title": title})
        last = sec
    if out and out[0]["seconds"] != 0:
        out[0] = {**out[0], "timestamp": "0:00", "seconds": 0}
    return out if len(out) >= 3 else []


def _build_description(lang: str, hook: str, learn: list[str], about: str,
                       chapters: list[dict], hashtags: list[str]) -> str:
    h_learn, h_chap, h_about, music_credit = _HDR.get(lang, _HDR["en"])
    parts: list[str] = []
    # First ~125 chars matter most for search → lead with the hook.
    if hook:
        parts.append(hook.strip())
    bullets = [f"• {b.strip()}" for b in learn if str(b).strip()][:6]
    if bullets:
        parts.append(f"📺 {h_learn}\n" + "\n".join(bullets))
    if chapters:
        clines = "\n".join(f"{c['timestamp']} {c['title']}" for c in chapters)
        parts.append(f"⏱️ {h_chap}\n{clines}")
    if about and about.strip():
        parts.append(f"📝 {h_about}\n{about.strip()}")
    if hashtags:
        parts.append(" ".join(hashtags))
    parts.append(f"🎵 {music_credit}")
    desc = "\n\n".join(parts).strip()
    return desc[:_DESC_HARD]


def _seo_score(title: str, primary: str, descriptions: dict[str, str],
               tags: list[str], hashtags: list[str],
               chapters: list[dict]) -> int:
    score = 0
    # Title (30)
    if _TITLE_LO <= len(title) <= _TITLE_HI:
        score += 15
    elif len(title) <= _TITLE_HARD:
        score += 7
    if primary and primary.lower() in title.lower():
        score += 10
    if any(ch.isdigit() for ch in title) or "?" in title:
        score += 5
    # Description (35) — judged on the primary language
    d = next(iter(descriptions.values()), "")
    if len(d) >= 250:
        score += 10
    if len(d) >= 700:
        score += 8
    if primary and primary.lower() in d[:125].lower():
        score += 9
    if "⏱️" in d:
        score += 8
    # Tags (20)
    if len(tags) >= 8:
        score += 10
    if len(tags) >= 15:
        score += 5
    if len(set(tags)) == len(tags) and tags:
        score += 5
    # Chapters + hashtags (15)
    if len(chapters) >= 3:
        score += 10
    if 3 <= len(hashtags) <= _MAX_HASHTAGS:
        score += 5
    return max(0, min(100, score))


def _render_txt(r: SEOResponse) -> str:
    """Human, copy-paste-ready pack (one block per language)."""
    L: list[str] = []
    L.append("═══ TÍTULO ═══")
    L.append(r.title)
    if r.title_variants:
        L.append("\n── Variantes ──")
        L.extend(f"  • {v}" for v in r.title_variants)
    for lang, desc in r.descriptions.items():
        L.append(f"\n═══ DESCRIPCIÓN [{lang}] ═══")
        L.append(desc)
    L.append("\n═══ TAGS (pega separadas por comas) ═══")
    L.append(", ".join(r.tags))
    L.append("\n═══ HASHTAGS ═══")
    L.append(" ".join(r.hashtags))
    if r.chapters:
        L.append("\n═══ CAPÍTULOS ═══")
        L.extend(f"{c['timestamp']} {c['title']}" for c in r.chapters)
    L.append(f"\n═══ SEO SCORE: {r.seo_score}/100 ═══")
    L.append(f"Keyword principal: {r.primary_keyword}")
    return "\n".join(L).strip() + "\n"


def _topic_keywords(script: str, limit: int = 12) -> list[str]:
    """Fallback keyword mining straight from the narration when the LLM
    output is unusable — frequency of capitalised / long content words."""
    words = re.findall(r"[A-Za-zÀ-ɏ][\w'-]{3,}", script)
    freq: dict[str, int] = {}
    for w in words:
        lw = w.lower()
        if lw in _STOPWORDS:
            continue
        weight = 2 if w[:1].isupper() else 1
        freq[lw] = freq.get(lw, 0) + weight
    ranked = sorted(freq.items(), key=lambda kv: kv[1], reverse=True)
    return [w for w, _ in ranked[:limit]]


# ─── Route ─────────────────────────────────────────────────────────────────
@router.post("", response_model=SEOResponse)
async def generate_seo(req: SEORequest) -> SEOResponse:
    script = _resolve_script(req)
    langs = [l for l in (req.languages or ["en"]) if l] or ["en"]

    prompt = SEO_PROMPT_TEMPLATE.format(
        topic=(req.topic or "").strip(),
        languages=", ".join(langs),
        script=script[:9000],
    )
    parsed: dict = {}
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            result = await llm_generate(
                model=req.model,
                prompt=prompt,
                format="json",
                options={"temperature": 0.5},
                think=False,
                max_continuations=0,
                client=client,
                timeout=300.0,
            )
        raw = (result.get("response") or "{}").strip()
        # tolerate accidental ```json fences
        raw = re.sub(r"^```(?:json)?|```$", "", raw, flags=re.MULTILINE).strip()
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            parsed = {}
    except (httpx.HTTPError, json.JSONDecodeError, Exception) as e:  # noqa: BLE001
        # Never hard-fail: degrade to narration-mined fallbacks so the
        # pipeline's best-effort SEO step still produces a usable pack.
        log_event("warning", "seo_llm_degraded", error=str(e)[:200])
        parsed = {}

    # ── normalise LLM output (defensive — small models drift) ──────────
    cands = parsed.get("title_candidates")
    if isinstance(cands, str):
        cands = [cands]
    cands = [str(c) for c in cands if str(c).strip()] if isinstance(cands, list) else []

    primary = _norm_kw(parsed.get("primary_keyword") or "")
    sec_raw = parsed.get("secondary_keywords") or []
    if isinstance(sec_raw, str):
        sec_raw = [s.strip() for s in sec_raw.split(",")]
    secondary = [_norm_kw(s) for s in sec_raw if isinstance(s, (str,)) and s.strip()] \
        if isinstance(sec_raw, list) else []

    mined = _topic_keywords(script)
    if not primary:
        primary = _norm_kw(req.topic) or (mined[0] if mined else "story")
    if not cands:
        base = (req.topic or primary).strip().title()
        cands = [base, f"The True Story of {base}", f"What Really Happened: {base}"]

    lang_blocks = parsed.get("lang")
    if not isinstance(lang_blocks, dict):
        lang_blocks = {}

    chapters = _chapters_from_markers(script)
    title, variants = _pick_title(cands, primary, req.topic)
    tags = _build_tags(primary, secondary, req.topic, mined)
    hashtags = _build_hashtags(primary, req.topic, secondary)

    descriptions: dict[str, str] = {}
    for lang in langs:
        blk = lang_blocks.get(lang) if isinstance(lang_blocks.get(lang), dict) else {}
        hook = str(blk.get("hook") or "").strip()
        learn_raw = blk.get("learn") or []
        learn = [str(x) for x in learn_raw if str(x).strip()] \
            if isinstance(learn_raw, list) else []
        about = str(blk.get("about") or "").strip()
        if not hook and not learn and not about:
            # language missing from LLM output → minimal honest fallback
            hook = (req.topic or title).strip()
            learn = [k for k in (secondary[:4] or mined[:4])]
            about = ""
        descriptions[lang] = _build_description(
            lang, hook, learn, about, chapters, hashtags
        )
    if not descriptions:
        descriptions["en"] = _build_description(
            "en", title, secondary[:4] or mined[:4], "", chapters, hashtags
        )

    score = _seo_score(title, primary, descriptions, tags, hashtags, chapters)
    resp = SEOResponse(
        title=title,
        title_variants=variants,
        primary_keyword=primary,
        secondary_keywords=secondary[:10],
        descriptions=descriptions,
        tags=tags,
        hashtags=hashtags,
        chapters=chapters,
        seo_score=score,
        written_to=None,
    )

    # ── persist next to the MP4 (best-effort) ─────────────────────────
    out_dir = req.out_dir
    if not out_dir and req.project_id:
        out_dir = str(_project_dir(req.project_id))
    if out_dir:
        try:
            d = Path(out_dir)
            d.mkdir(parents=True, exist_ok=True)
            (d / "seo.json").write_text(
                json.dumps(resp.model_dump(), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            (d / "seo.txt").write_text(_render_txt(resp), encoding="utf-8")
            resp.written_to = str(d / "seo.txt")
        except Exception as e:  # noqa: BLE001
            log_event("warning", "seo_write_failed", error=str(e)[:200])

    log_event("info", "seo_pack_done", score=score, langs=len(descriptions),
              tags=len(tags), chapters=len(chapters))
    return resp
