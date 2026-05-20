"""v0.7.0 — Video type presets.

A single source of truth for "tipo de vídeo" — the user picks one of 6
presets in the Generator and the whole pipeline (LLM system prompt,
voice descriptor, image-prompt style suffix, music seed, chapter gate)
adapts coherently without the motor itself changing.

Architecture: one frozen registry `PRESETS` keyed by stable id, plus
three mapping tables that translate the abstract dimensions
(voice_tone, music_mood, image_style) into concrete strings used by
the routes. The DEFAULT is `narrative_epic` and its directive is the
verbatim STORY BEATS + STORY ARC block from `prompts.py` so behavior
is **byte-identical** to v0.6.x for any caller that doesn't pass a
preset_id — zero regression.

See `docs/superpowers/specs/2026-05-20-video-presets-design.md` and
`docs/superpowers/plans/2026-05-20-video-presets-plan.md`.
"""

from __future__ import annotations

from dataclasses import dataclass


# ────────────────────────────────────────────────────────────────────
# Mapping tables: abstract dimension → concrete string.
# These live HERE so the routes never hardcode style values; they read
# from the preset's abstract id (voice_tone="dramatic") and resolve it
# through the table at the injection point.
# ────────────────────────────────────────────────────────────────────

VOICE_TONE_TO_DESCRIPTOR: dict[str, str] = {
    "dramatic":          "epic cinematic narrator, intense emotion",
    "didactic_warm":     "warm patient teacher, clear articulation",
    "narrator_measured": "measured documentary narrator, calm authority",
    "analytical":        "balanced analyst, even pacing",
    "analytical_calm":   "thoughtful host, contemplative",
    "energetic":         "upbeat enthusiastic presenter, fast pace",
}

MUSIC_MOOD_TO_PROMPT: dict[str, str] = {
    "epic":            "cinematic orchestral epic, swelling strings, hero theme",
    "sober":           "subtle documentary score, restrained strings + piano",
    "sober_curiosity": "gentle curious score, soft piano + woodwinds",
    "energetic":       "modern upbeat instrumental, light percussion, no vocals",
    "analytical":      "minimalist thoughtful, soft synth pad + piano",
    "neutral":         "ambient bed, very low, non-distracting",
}

# IMAGE_STYLE_BIAS keys map to the IMAGE-prompt "style suffix" that
# replaces the v0.6.x hardcoded `_STYLE_SUFFIX` constant in script.py.
# The "cinematic" entry is byte-identical to the current suffix so
# narrative_epic preserves the exact suffix string.
IMAGE_STYLE_BIAS: dict[str, str] = {
    "cinematic":              "cinematic, photorealistic, ultra detailed, dramatic lighting",
    "documentary":            "documentary photograph, archive-style, period-accurate, naturalistic",
    "editorial_illustrative": "editorial illustration, encyclopedia-style, clear, period-accurate",
    "editorial_dynamic":      "editorial illustration, dynamic composition, infographic feel",
    "editorial_dual":         "editorial split composition, A vs B framing, clean",
    "editorial_documentary":  "editorial documentary photography, illustrative, period-accurate",
}


# ────────────────────────────────────────────────────────────────────
# VideoPreset dataclass — the schema for each registry entry.
# ────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class VideoPreset:
    """A single 'tipo de vídeo' preset.

    The pipeline reads exactly these 11 fields. Adding a new dimension
    means: add the field here, add a mapping table if it's abstract,
    update all 6 PRESETS entries, update the parity invariant.
    """

    id: str
    label_es: str
    description_es: str
    # `llm_style_directive` is the STORY BEATS + STORY ARC block of the
    # system prompt — the part that varies by preset. The common
    # sections (LANGUAGE, FACTUAL CONTEXT, IMAGE MARKER FORMAT, VISUAL
    # DIVERSITY) stay in prompts.py and apply to all presets.
    llm_style_directive: str
    voice_tone: str
    image_style: str
    music_mood: str
    target_minutes_default: int
    markers_per_minute: float
    hook_style: str
    cta_style: str
    use_chapters: bool  # if True, forces long-form chapters even if target < 7 min


# ────────────────────────────────────────────────────────────────────
# Directive blocks (one per preset).
# ────────────────────────────────────────────────────────────────────

# `narrative_epic` keeps the EXACT current STORY BEATS + STORY ARC
# content of prompts.py (lines 143-204 verbatim). This is the contract
# that guarantees byte-identical output for callers that don't pass a
# preset_id. The parity invariant in scripts/parity-check.mjs blinds
# this against drift.
_NARRATIVE_EPIC_DIRECTIVE = """═══ STORY BEATS — DOCUMENTARY YOUTUBE VIRAL FORMULA (NON-NEGOTIABLE) ═══
The narration MUST move through these BEATS in order. They are what makes mid/long-form documentary videos retain attention end-to-end. Don't summarise the topic linearly — STAGE it like a mystery.

  BEAT 1 — HOOK (first 30-45 seconds, ≈ first 90-110 words).
    Open with a paradox, a question, or an unsettling fact that creates an itch the viewer NEEDS scratched. NOT "Today we'll explore…". Examples (do not copy verbatim):
      • Mystery: "Durante 3.245 años nadie supo que estaba allí."
      • Question: "¿Cómo es posible que un faraón olvidado se convirtiera en el más famoso de la historia?"
      • Paradox: "Era el rey menos importante de Egipto. Hoy es el más recordado del mundo."
    Promise the payoff explicitly ("vamos a entender por qué…") so the viewer commits.

  BEAT 2 — SETUP (next 60-90 seconds).
    Ground the viewer in the WHEN/WHERE/WHO. Sensory, vivid, specific. Set the stage with named places, dated events, named people from the FACTUAL CONTEXT block above.

  BEAT 3 — EVIDENCE / FACT STACKING (40-60% of total duration).
    Stack the topic's key facts in 2-4 mini-sections. Each mini-section advances the central question. Use rhythmic escalation: a fact, a fact, a fact-that-changes-things. Don't dump everything at once — release information like a thriller.

  BEAT 4 — ESCALATION (one section, ~60-90s).
    Raise the stakes. Introduce the conflict, the danger, the moment things tilt. The viewer should feel "oh this is getting serious".

  BEAT 5 — REVEAL / PAYOFF (one section, ~60-90s).
    Resolve the central question opened in BEAT 1. This is where the viewer gets the answer they came for. Use an evocative micro-quote ("y entonces, al asomarse a la cámara, Carter susurró: 'veo cosas maravillosas'…"). Insert a [MUSIC: mood=reveal] marker on the sentence before the reveal so the renderer swells the score.

  BEAT 6 — IMPLICATIONS / LEGACY (≈ last 60-90s before CTA).
    Zoom out. What did this change? What does it mean today? Connect the topic to something timeless that lingers after the video ends.

  BEAT 7 — CTA (last 1-2 sentences). See "STORY ARC + ROUNDED CLOSING" below.

═══ STORY ARC + ROUNDED CLOSING (NON-NEGOTIABLE) ═══
Every script MUST end with a deliberate, satisfying closing — NEVER stop mid-thought, mid-sentence, or after a tangent. The viewer must feel the story is COMPLETE.

PART 1 — Narrative resolution (2-3 sentences): tie back to opening hook, give resolution/takeaway/final image, end on a strong memorable line.
PART 2 — Audience CTA (1-2 sentences in {language_name}): warm natural farewell asking for LIKE / SHARE / SUBSCRIBE, thanking viewer sincerely, in-tone with the script's voice (epic / contemplative / playful / solemn)."""


_DOCUMENTARY_DIRECTIVE = """═══ DOCUMENTARY STRUCTURE (NON-NEGOTIABLE) ═══
Write a FAITHFUL DOCUMENTARY narration. Strict factual accuracy from the FACTUAL CONTEXT block. No invented dialogue, no mythic exaggeration, no dramatized "what he must have felt". Voice: measured, knowledgeable, archive-style narrator (BBC / National Geographic).

Structure (in order):
  1. OPENING CONTEXT (~60s) — who, when, where. Anchor the viewer with verified dates, places, names from the FACTUAL CONTEXT.
  2. THREE TO FIVE THEMED SEGMENTS (60-90% of total) — chronological if the topic is historical (event by event), thematic otherwise (politics, religion, art, daily life…). Each segment opens with a [CHAPTER: ...] marker. Each fact must be traceable to the brief.
  3. CLOSING CONTEXT / LEGACY (~60s) — what this means for the historical record, what survives today, what scholars still debate. Avoid speculation; cite uncertainty where the brief shows it ("according to surviving sources…", "what the evidence suggests…").

Image markers: point to real artefacts (statues, manuscripts, archaeological finds), maps, period photographs, period-accurate scenes — NEVER cinematic action sequences or dramatized close-ups.

═══ DOCUMENTARY CLOSING (NON-NEGOTIABLE) ═══
End with a measured closing (not epic): the topic's place in the historical record + a sober line about its lasting significance. Then a natural CTA in {language_name} (like/share/subscribe), warm but professional in tone."""


_EXPLAINER_DIRECTIVE = """═══ EXPLAINER STRUCTURE (NON-NEGOTIABLE) ═══
Write a FAITHFUL, DESCRIPTIVE EXPLAINER. Goals: factual accuracy (use the FACTUAL CONTEXT as ground truth), clarity, concrete examples, smooth pedagogical progression from basic to nuanced. AVOID dramatization, invented dialogue, mythic-narrative framing, "epic story" voice. Write as a confident, warm teacher explaining the subject to a curious adult.

Structure (in order):
  1. HOOK (1 surprising verified fact, ~30s) — open with one specific, surprising, source-backed fact that creates curiosity. NOT a question, NOT a mystery — a CONCRETE FACT.
  2. THREE TO FIVE THEMATIC SECTIONS (60-80% of total) — each section is one self-contained aspect of the topic (e.g. for "Norse culture": origins / society / religion / daily life / legacy). Each section: clear sub-thesis + concrete sub-points + tangible examples. Each opens with a [CHAPTER: ...] marker.
  3. CLOSING SUMMARY + INVITATION (~30s) — brief recap of what was covered + invitation to explore further ("there's more to learn about…").

Image markers: ILLUSTRATIVE (period-accurate scenes, real artefacts, locations on a map, key figures, daily-life vignettes), NOT cinematic dramatizations. Think encyclopedia plates, not movie stills.

═══ EXPLAINER TONE (NON-NEGOTIABLE) ═══
- NO dramatization keywords: avoid "epic", "destiny", "weaves", "mythic battle", "eternal struggle".
- DO use teacher voice: "this means that…", "let's look at how…", "a clear example is…".
- Concrete > abstract. If you write a generic claim, immediately follow with a specific example from the FACTUAL CONTEXT.

═══ EXPLAINER — PROHIBICIONES ESTRICTAS EN ESPAÑOL (NO NEGOCIABLE) ═══
v0.7.3 — porque Gemma genera prosa española mítica por hábito, esta lista
es OBLIGATORIA cuando language_name = Spanish. Si la salida contiene
CUALQUIERA de estas palabras o construcciones, el guion se considera
fallido. PROHIBIDO usar:

  • Palabras dramáticas: "destino", "monumental", "cósmico", "épico",
    "épica", "trascender", "trascendental", "tapiz", "vasto", "vasta",
    "majestuoso", "majestuosa", "glorioso", "gloriosa", "titánico",
    "titánica", "primordial", "eterno", "eterna", "sublime", "divino"
    (como adjetivo enfático), "sagrado" (como adjetivo enfático).
  • Metáforas grandilocuentes: "el corazón del universo", "el orden
    cósmico", "la propia estructura del cosmos", "el tejido del tiempo",
    "el alma de", "el espíritu de", "el latir de", "el aliento de".
  • Frases dramatizadas: "no es solo X, es Y", "más que X, es Y",
    "no era cualquier X", "su grandeza es", "su destino era",
    "su propósito iba más allá de", "se dedicó a", "emerge una",
    "surge una figura", "una figura monumental".
  • Aperturas tipo cuento: "En el vasto", "En tiempos remotos", "Hace
    eones", "Cuenta la leyenda", "Se dice que".

Verbo / construcción permitida en su lugar:
  • "X es una deidad china conocida por…" — DESCRIPCIÓN directa.
  • "El concepto de X surge en el período…" — CONTEXTO histórico.
  • "Para entender X, primero veamos…" — DIDÁCTICO.
  • "Los textos taoístas describen a X como…" — CITA fuente.
  • "Un ejemplo concreto es…" — EJEMPLO.

Tono español obligatorio: profesor universitario claro, sin adornos.
Como un divulgador (estilo Punset, Aberrón, o un buen documental
escrito). Cada frase responde "¿qué es?" o "¿cómo funciona?" o "¿por
qué importa?" — nunca "¡qué grandioso es!".

═══ EXPLAINER CLOSING (NON-NEGOTIABLE) ═══
End with a 1-2 sentence recap + an inviting line about further exploration. Then a warm natural CTA in {language_name} (like/share/subscribe), professorial but enthusiastic — like a teacher who hopes the student will keep learning."""


_LISTICLE_DIRECTIVE = """═══ LISTICLE STRUCTURE (NON-NEGOTIABLE) ═══
Write a LIST-FORMAT video: "N cosas/datos/curiosidades que no sabías de <topic>". Choose N between 5 and 10 based on how rich the FACTUAL CONTEXT is.

Structure:
  1. HOOK (15-25s) — TEASE the most surprising item ("el #1 te va a sorprender") + announce the count ("estos son los X datos que…"). Promise the payoff.
  2. THE N ITEMS — count DOWN from N to 1 (the most surprising goes last). For each item:
     - Open with the number explicitly in {language_name}: "Número cinco:", "Número cuatro:", …, "Y por último, el número uno:".
     - State the surprising/specific fact (1 sentence).
     - Give 1-2 sentences of context from the FACTUAL CONTEXT.
     - Give a concrete example or anecdote when possible.
     - Each item gets its own [IMAGE: …] marker pointing to a SPECIFIC visual element of that fact.
  3. CLOSING RECAP + CTA — quick mention of the top fact + CTA asking which one surprised viewers most (comment-bait).

Each item should be ~30-60s. Insert a [CHAPTER: Número N] marker at each item boundary so the renderer can chapter them.

═══ LISTICLE TONE (NON-NEGOTIABLE) ═══
Voice: dynamic, attention-grabbing, but factually grounded in the brief. Avoid clickbait that the facts can't back up. Energetic pacing.

═══ LISTICLE CLOSING (NON-NEGOTIABLE) ═══
After item #1, brief recap of the most jaw-dropping fact, then CTA in {language_name}: "¿cuál te ha sorprendido más? Cuéntamelo en los comentarios. Si te ha gustado, dale a like y suscríbete." Warm but high-energy."""


_COMPARATIVE_DIRECTIVE = """═══ COMPARATIVE STRUCTURE (NON-NEGOTIABLE) ═══
Write a COMPARATIVE video: <topic> framed as A vs B (the topic should name both, e.g. "Vikings vs Samurai"). If the topic doesn't explicitly name two subjects, pick the most natural pair from the FACTUAL CONTEXT and announce them upfront.

Structure:
  1. HOOK (20-30s) — announce the comparison theatrically ("X vs Y. Dos guerreros legendarios. ¿Cuál habría ganado?") + tease the most fascinating dimension to come.
  2. INTRODUCE BOTH (60-90s) — 30-40s for A, then 30-40s for B. Origin, era, location, what they're famous for. Use FACTUAL CONTEXT for both.
  3. FOUR TO SIX DIMENSIONS OF COMPARISON (60% of total) — pick dimensions natural to the pair (combat / society / religion / technology / philosophy / daily life…). For each dimension:
     - State the dimension as a [CHAPTER: Dimensión] marker.
     - Cover A first (45-60s), then B (45-60s).
     - End the dimension with a sober comparative line (no winner declared yet).
  4. SYNTHESIS (~60s) — honest synthesis: who "wins" on what dimensions, where they're not really comparable, what each represents culturally. NO fanboying.

Image markers: alternate A and B per dimension, ideally split or side-by-side framing when natural ("a Viking longship on left, a Japanese ship on right"). Always grounded in the FACTUAL CONTEXT of both.

═══ COMPARATIVE TONE (NON-NEGOTIABLE) ═══
Analytical, balanced, respectful of both subjects. Avoid the "X destroys Y" energy — this is journalism, not WWE.

═══ COMPARATIVE CLOSING (NON-NEGOTIABLE) ═══
End with the honest synthesis + an open question to the audience ("¿con cuál te quedas tú?"). Then CTA in {language_name} inviting comments + like/subscribe."""


_DEEP_DIVE_DIRECTIVE = """═══ DEEP-DIVE STRUCTURE (NON-NEGOTIABLE) ═══
Write a LONG-FORM ANALYTICAL deep-dive (target 12-20 minutes). This is podcast-style audio essay: a single topic explored thoroughly, with multiple chapters each developing a sub-thesis. Mandatory: use the LONG-FORM CHAPTERS pipeline (chapters with running summary continuity).

Structure (in order):
  1. OPENING — "WHY THIS MATTERS" HOOK (~60s) — not a paradox or mystery, but a genuine question: "why should we care about <topic> today?" Plant the central inquiry.
  2. FOUR TO EIGHT CHAPTERS (80% of total) — each chapter is a self-contained sub-thesis with:
     - A [CHAPTER: Title] marker opening it.
     - A clear opening line ("Capítulo tres: …" or evocative title) that states the sub-thesis.
     - Factual development from the FACTUAL CONTEXT, with multiple concrete examples.
     - A reflective transition to the next chapter ("y esto nos lleva a…").
  3. CLOSING SYNTHESIS + OPEN QUESTION (~90s) — synthesis of what we've learned + an honest open question that invites further reflection (NOT a tidy bow).

Cite the historical record explicitly: "según el registro histórico", "lo que los textos primarios nos dicen", "los arqueólogos coinciden en…" — this is reflective journalism, not myth.

Image markers: editorial documentary mix (real artefacts, period-accurate illustrations, locations, key figures). Slower pace than narrative_epic — ~1 image per 12-15s (markers_per_minute = 4.0).

═══ DEEP-DIVE TONE (NON-NEGOTIABLE) ═══
Voice: calm, deeply curious, analytical — a podcaster who has clearly done the homework. NO dramatic flourishes, NO mythic flavor, NO "shocking truth" hook-baiting. This is grown-up content.

═══ DEEP-DIVE CLOSING (NON-NEGOTIABLE) ═══
Close with synthesis + an open question (deliberately unanswered) inviting the audience to keep thinking. Then a calm CTA in {language_name} — invite to subscribe for more deep-dives, thanking viewers for staying till the end of a long video."""


# ────────────────────────────────────────────────────────────────────
# The 6 presets. Order matters for UI display (left-to-right chips).
# Default is the FIRST entry: narrative_epic.
# ────────────────────────────────────────────────────────────────────

PRESETS: dict[str, VideoPreset] = {
    "narrative_epic": VideoPreset(
        id="narrative_epic",
        label_es="Narrativa épica",
        description_es="Cuento épico cinematográfico (el modo clásico).",
        llm_style_directive=_NARRATIVE_EPIC_DIRECTIVE,
        voice_tone="dramatic",
        image_style="cinematic",
        music_mood="epic",
        target_minutes_default=10,
        markers_per_minute=5.0,  # MATCHES legacy expected_min=target_minutes*5
        hook_style="epic_question",
        cta_style="epic_call",
        use_chapters=False,  # auto-detect by target_minutes ≥ 7 (existing logic)
    ),
    "documentary": VideoPreset(
        id="documentary",
        label_es="Documental",
        description_es="Hechos verificados, voz medida, estilo BBC.",
        llm_style_directive=_DOCUMENTARY_DIRECTIVE,
        voice_tone="narrator_measured",
        image_style="documentary",
        music_mood="sober",
        target_minutes_default=8,
        markers_per_minute=4.5,
        hook_style="context_opening",
        cta_style="documentary_close",
        use_chapters=False,
    ),
    "explainer": VideoPreset(
        id="explainer",
        label_es="Divulgativo",
        description_es="Explicación fidedigna y descriptiva. Tono didáctico.",
        llm_style_directive=_EXPLAINER_DIRECTIVE,
        voice_tone="didactic_warm",
        image_style="editorial_illustrative",
        music_mood="sober_curiosity",
        target_minutes_default=6,
        markers_per_minute=5.0,
        hook_style="fact_hook",
        cta_style="didactic_close",
        use_chapters=False,
    ),
    "listicle": VideoPreset(
        id="listicle",
        label_es="Listicle (Top-N)",
        description_es="\"N cosas que no sabías de…\". Items numerados.",
        llm_style_directive=_LISTICLE_DIRECTIVE,
        voice_tone="energetic",
        image_style="editorial_dynamic",
        music_mood="energetic",
        target_minutes_default=6,
        markers_per_minute=5.5,
        hook_style="tease_top_item",
        cta_style="listicle_recap",
        use_chapters=False,
    ),
    "comparative": VideoPreset(
        id="comparative",
        label_es="Comparativa A vs B",
        description_es="Dos sujetos contrastados, estructura paralela.",
        llm_style_directive=_COMPARATIVE_DIRECTIVE,
        voice_tone="analytical",
        image_style="editorial_dual",
        music_mood="analytical",
        target_minutes_default=8,
        markers_per_minute=5.0,
        hook_style="vs_announce",
        cta_style="synthesis_close",
        use_chapters=False,
    ),
    "deep_dive": VideoPreset(
        id="deep_dive",
        label_es="Deep-dive / Análisis",
        description_es="Análisis largo (12-20 min) con capítulos.",
        llm_style_directive=_DEEP_DIVE_DIRECTIVE,
        voice_tone="analytical_calm",
        image_style="editorial_documentary",
        music_mood="analytical",
        target_minutes_default=15,
        markers_per_minute=4.0,
        hook_style="why_matters",
        cta_style="open_question",
        use_chapters=True,  # FORCED — always uses long-form chapters from v0.5.0
    ),
}

DEFAULT_PRESET_ID = "narrative_epic"


def get_preset(preset_id: str | None) -> VideoPreset:
    """Resolve a preset id to its registry entry.

    Falls back to `narrative_epic` for unknown / missing ids — this is
    the safety net that guarantees every caller (including old clients
    that don't send preset_id, or anything that sends garbage) keeps
    working as v0.6.x.
    """
    if not preset_id:
        return PRESETS[DEFAULT_PRESET_ID]
    return PRESETS.get(preset_id, PRESETS[DEFAULT_PRESET_ID])
