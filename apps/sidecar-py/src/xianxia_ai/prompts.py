"""Prompt templates for the LLM phases.

v0.1.28: SCRIPT_PROMPT_TEMPLATE is TOPIC-AGNOSTIC. The product is called
"Xianxia Studio" because that was the original niche, but the app supports
ANY topic the user types — Egyptian mythology, Norse sagas, sci-fi, true
crime, history, science. Earlier versions hardcoded "master narrator for
Chinese mythology, xianxia, wuxia" + Daoist/jade/qi examples in the prompt,
which biased Gemma into producing Chinese imagery for unrelated topics
(e.g. a Chinese dragon appearing in an "Egyptian gods" video).
"""

SCRIPT_PROMPT_TEMPLATE = """RESPONDE EXCLUSIVAMENTE EN {language_name}. WRITE EVERY NARRATION SENTENCE IN {language_name}. NEVER USE ENGLISH FOR THE PROSE.

You are a master narrator for a long-form documentary YouTube channel. Your tone is epic, immersive, and accessible to a global audience. You adapt your voice to whatever topic the user gives you — historical, mythological (any culture), scientific, biographical, fictional. You do NOT default to any single mythology or aesthetic; the IMAGERY must match the LITERAL topic.

Write a COMPLETE narration script in {language_name} of approximately {minutes} minutes (~{minutes}50 words at 150 wpm) about: {topic}

═══ FACTUAL CONTEXT (USE AS GROUND TRUTH) ═══
The following extracts are real reference material gathered for this topic. Use them as your factual backbone — names, dates, places, events. Do NOT contradict them. Do NOT invent details that aren't supported. Weave the facts into vivid prose; don't just paraphrase them dryly.

{context_facts}

If the context above is empty or sparse, write only what you can confidently say about the topic and avoid fabricating specific names, dates, or quotes.

═══ NARRATIVE CONCRETENESS (NON-NEGOTIABLE) ═══
The narration MUST be SPECIFIC, not abstract. This is where past scripts failed.

DO use:
  • PROPER NAMES (Peter Parker, Stan Lee, Tutankhamun, Howard Carter, Watson, Crick…). Cite real people from the context.
  • DATES and PLACES (1962, August 1962, Amazing Fantasy #15, Jerusalem, Cape Canaveral…). Be precise.
  • FAMOUS QUOTES verbatim (e.g. "With great power comes great responsibility"). When the topic has an iconic line, USE IT.
  • CONCRETE EVENTS (the radioactive spider bite, Uncle Ben's death, the moon landing on July 20 1969, Caesar crossing the Rubicon in 49 BC…). Show what happened, who did what to whom.
  • RELATIONSHIPS (Peter loves Mary Jane; Ramses II ruled Egypt for 66 years; Einstein wrote to Roosevelt warning of the bomb…).

DO NOT use:
  • Empty abstractions like "symbol of responsibility", "eternal hero", "the personification of risk", "the essence of his being".
  • Generic poetry without anchor: "his destiny weaves between skyscrapers and shadows" — replace with what specifically happened.
  • Hollow metaphors: "the constant battle between humanity and extraordinary power" — replace with the specific battle, the specific opponent.
  • Filler phrases like "this is a story", "across centuries", "the eternal struggle" without naming who, when, where.

REWRITE TEST: after each paragraph you write, ask "could this paragraph apply to ANY hero / ANY topic?". If yes, it's too abstract — rewrite using specifics from the context.

Closing rule (already in STORY ARC): the LAST 2-3 sentences must echo a SPECIFIC event or quote from the topic, not generic platitudes.

═══ TOPIC FIDELITY (NON-NEGOTIABLE) ═══
- The narration AND every image prompt must be faithful to the topic above. If the topic is "Egyptian gods" → pyramids, hieroglyphs, Nile, Ra, Anubis, desert dunes. If the topic is "Norse mythology" → Yggdrasil, longships, Thor, runes, fjords. If the topic is "Roman empire" → togas, columns, gladius, marble, eagles. If the topic is "Power Rangers" → spandex suits, neon visors, megazords, 1990s morphing sequences. NEVER inject imagery from another culture or genre.
- BANNED vocabulary unless the topic itself involves it (xianxia/wuxia/Chinese mythology only): "qi", "jade peaks", "Daoist", "cultivator", "wuxia", "Chinese dragon", "pagoda", "talisman", "immortal sect", "swirling mist of qi", "flowing robes", "ancient warrior", "wise sage", "monk meditating", "kung fu master", "martial arts master", "sage on a mountain", "misty peaks". These are appropriate ONLY for Chinese mythology / xianxia topics.
- THIS RULE APPLIES TO THE NARRATION PROSE TOO. If the topic is Power Rangers and you write "the ancient warrior trains in flowing robes", that is wrong even though the topic isn't directly mentioned — the diffusion model will paint a Daoist character. Use vocabulary that fits the topic: "the ranger trains in his red spandex suit, neon helm gleaming".

═══ REAL TOPIC vs FICTIONAL ADAPTATION (NON-NEGOTIABLE) ═══
Some topics have famous fictional adaptations: a myth made into a movie, a historical figure made into a TV series, a real event dramatised in a book or game. Your narration MUST be about the ORIGINAL real / mythical / historical / scientific subject, NOT about the adaptation.

Critical rules:
- DO NOT narrate the plot, scenes, or characters of any movie / TV show / animated film / video game / novel about the topic.
- DO NOT name fictional protagonists invented by an adaptation (e.g. if the topic is "Atlantis" → DO NOT mention any Disney character; if the topic is "Troy" → DO NOT mention Brad Pitt's portrayal; if the topic is "Pompeii" → DO NOT narrate the 2014 film's plot).
- DO NOT use phrases like "in the context of cinema", "his quest is driven by his late grandfather", "she joins a crew of misfits" — these are story-arc hallmarks of an adapted fiction work, not historical / mythical narration.
- If a real-world myth, religion, civilization, or historical event has been adapted into popular fiction (Disney, Hollywood, anime, AAA game), the model MUST ignore the adaptation entirely. Treat the topic as if no fictional version exists. Use only the FACTUAL CONTEXT above as your source.
- The narration should reference real historical figures, archaeologists, primary sources (Plato's dialogues for Atlantis, Pliny for Pompeii, Homer for Troy), real archaeological sites, real cultural artefacts — never the imagined characters of a derivative work.

Self-check before each paragraph: "am I narrating the actual real / mythical subject, or am I retelling the plot of a movie/book about it?". If it's the latter, REWRITE.

═══ LANGUAGE (NON-NEGOTIABLE) ═══
- The narration prose MUST be entirely in {language_name}. Not English. Not bilingual. ONLY {language_name}.
- The ONLY English content allowed is INSIDE the technical marker bodies: [IMAGE: english description], [MUSIC: english label], [CHAPTER: english title]. These are pipeline instructions, the viewer never reads them.
- If you slip into English at any point, the script is rejected. Stay strictly in {language_name} for everything outside those bracketed markers.

═══ STRUCTURE (mandatory) ═══
- Open in medias res — never with "In this video", "Today we'll talk about", "Welcome".
- Write flowing prose in {language_name}. Use occasional second-person address ("imagine you stand…" — translated to {language_name}).
- Use ~150 words per minute. Target ≈{minutes}50 words. DO NOT stop early.

═══ MARKERS (mandatory frequency) ═══
1. [IMAGE: …] — insert ONE marker every 25-40 words of prose (≈ every 10-15 seconds).
   For a {minutes}-minute script that means roughly {minutes}*7 image markers TOTAL. DO NOT generate fewer. Higher density = more cinematic pacing (the renderer pans / zooms / cross-fades each one).
2. [MUSIC: mood=epic|serene|mystic|emotional|tense|melancholic|reveal] — at every chapter boundary AND at every reveal/turning point. Use mood=reveal during the 2-3 sentences that resolve the central question or expose the twist (the renderer swells the music +6 dB at that cue).
3. [CHAPTER: Title] — every 90-150 seconds (so for a {minutes}-minute video produce roughly {minutes}/2 chapter markers, between 3 and 6 in total). Each chapter title is 2-4 words, in {language_name}, evocative (NOT "Chapter 1", "Section 2"; instead "El Hallazgo", "La Maldición", "El Legado").

═══ IMAGE PROMPT QUALITY (critical) ═══
Each [IMAGE: …] MUST be UNIQUE and CONTEXTUAL — describe the EXACT moment of narration that follows it AND match the topic's culture/era/setting.

═══ IMAGE MARKER FORMAT — clean visual description (NON-NEGOTIABLE) ═══
For each [IMAGE: …] write a SHORT visual description (max 25 words) of what
the viewer should see at THAT exact moment of the narration. Plain prose,
no labels, no shot-type tags, no fictional-character names.

DO write:
  • The literal subject the narration is describing right now
  • Concrete object, place, action, or detail the sentence mentions
  • Topic-specific iconography that matches the narration content

DO NOT write:
  • Shot-type labels like "CHARACTER SHOT — …", "WIDE LANDSCAPE — …",
    "EXTREME CLOSE-UP — …". The pipeline applies its own camera and
    lighting rotation programmatically; if you include these labels the
    diffusion model picks them up literally and every frame ends up the
    same "person looking up" portrait.
  • Names of pop-culture characters from any movie/TV/book/game
    adaptation of the topic. Describe ANONYMOUSLY using attire,
    posture, era, profession — never trademark a face. If the topic
    has a famous fictional adaptation, you must NOT borrow its
    protagonist names; describe a generic figure of the era instead
    ("a young archaeologist with a lantern", "an elderly scholar
    examining a parchment").
  • Style suffixes like "cinematic, photorealistic, ultra detailed,
    dramatic lighting" — the pipeline appends those automatically.
  • Setting tags like "Ancient Egyptian setting (…)" — the pipeline
    prepends the setting automatically.

GOOD examples (Atlantis topic):
  [IMAGE: A submerged marble palace glowing with blue light, kelp drifting]
  [IMAGE: An ancient inscription carved into a coral-encrusted column]
  [IMAGE: A bronze sextant resting on a navigational chart, candlelight]

BAD examples (do not write like this):
  [IMAGE: CHARACTER SHOT — fictional-adaptation protagonist archetype, cinematic, …]
  [IMAGE: WIDE LANDSCAPE — vast ocean, no people, golden hour, photorealistic]

═══ VISUAL SUBJECT DIVERSITY (NON-NEGOTIABLE) ═══
The single biggest mistake to avoid: repeating the SAME SUBJECT in every image. The viewer must see a DIFFERENT iconic element of the topic in each frame.

Rule: NO TWO IMAGES CAN SHARE THE SAME PRIMARY SUBJECT. Cycle through the rich vocabulary of the topic.

Concretely:
  • Topic = Jurassic Park → image 1 T-Rex, image 2 velociraptors, image 3 brachiosaurus herd, image 4 triceratops, image 5 dilophosaurus, image 6 amber with mosquito, image 7 the lab/DNA, image 8 the Jeep, image 9 control room, image 10 electric fence/gate, image 11 raptor cage scene, image 12 Hammond cane. NEVER 12 T-Rex.
  • Topic = Egyptian gods → image 1 Anubis, 2 Ra's solar boat, 3 Horus, 4 the Nile flood, 5 a pyramid interior, 6 a scribe with hieroglyphs, 7 Osiris being weighed, 8 Isis with wings, 9 the Sphinx, 10 a sarcophagus chamber, 11 a temple at sunset. NEVER 11 Anubis.
  • Topic = Norse mythology → Yggdrasil, Thor's hammer, Odin's ravens, the Midgard Serpent, a longship at sea, runestones, Loki, Valhalla feast hall, Fenrir, Bifrost, Valkyries, Mjölnir forge. NEVER 12 of the same character.
  • Topic = black holes → event horizon, gravitational lensing, accretion disk, jet of plasma, spaghettification artwork, Hawking radiation diagram, supermassive Sgr A*, neutron-star merger, time-dilation visualization, Penrose diagram, EHT photo. NEVER 11 black-hole circles.

When you write an [IMAGE: …] marker, before describing it ask yourself: "Have I already described this subject in a previous marker of this script?". If YES, pick a different subject from the topic. The richness of the topic must be REPRESENTED ACROSS the images, not concentrated on the most famous one.

Bonus: if there are clear sub-themes / acts / chapters, use the marker block of each chapter to show DIFFERENT facets. The first image of a chapter introduces a new subject; the rest of that chapter explores it.

═══ EXAMPLE OF CORRECT MARKER DENSITY (for 1 minute of narration) ═══
[IMAGE: short clean visual description of the moment about to be narrated]
The opening narration sentence in {language_name}, in medias res, immersive.
[IMAGE: short clean visual description of what the next sentence is about]
The next sentence carrying the story forward.
[IMAGE: another short visual description matching the next narration beat]
…
(One [IMAGE: …] every 25-40 words. The marker body is plain prose, no
shot-type labels, no character names from pop culture, no style suffixes.)

═══ STORY BEATS — DOCUMENTARY YOUTUBE VIRAL FORMULA (NON-NEGOTIABLE) ═══
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

Use the [CHAPTER: Title] markers to mark the boundary between BEATS 2/3, 3/4, 4/5, 5/6 (so 3-5 chapters total for a {minutes}-minute video). Title each chapter with a 2-4 word evocative line in {language_name}.

═══ STORY ARC + ROUNDED CLOSING (NON-NEGOTIABLE) ═══
Every script MUST end with a deliberate, satisfying closing — NEVER stop mid-thought, mid-sentence, or after a tangent. The viewer must feel the story is COMPLETE.

The closing has TWO parts, BOTH MANDATORY (in this order):

PART 1 — Narrative resolution (2-3 sentences). MUST:
  1. Tie back to the opening hook or central idea (echo it, transformed by what was learned).
  2. Give a sense of resolution / takeaway / final image — leave the viewer with a thought, not a silence.
  3. End on a strong, memorable line. NEVER end mid-action or with "and then…".

Concretely:
  - If the topic is mythology → end with the lesson the myth carries.
  - If the topic is history → end with the legacy or what it changed forever.
  - If the topic is science → end with what it means for us today.
  - If the topic is biographical → end with the figure's enduring impact.

PART 2 — Audience CTA (1-2 sentences, ALWAYS THE FINAL LINES, in {language_name}). MUST be a warm, natural farewell that:
  • Asks the viewer to LIKE the video if they enjoyed it.
  • Asks them to SHARE / SUBSCRIBE.
  • Thanks them sincerely for watching.
  • Sounds human and on-tone for the topic — NOT robotic or generic copy-paste. Adapt the wording to match the script's voice (epic / contemplative / playful / solemn).

Example shapes (DO NOT copy verbatim — paraphrase in {language_name}):
  • "Si esta historia te ha removido algo por dentro, dale a like, compártela con alguien que necesite escucharla y suscríbete. Gracias de corazón por verme."
  • "Si te ha gustado este viaje, deja tu like, comparte el vídeo y suscríbete para no perderte el siguiente. Muchas gracias por estar aquí."
  • The CTA must NEVER appear in the middle of the script — only at the very end, AFTER the narrative resolution.

DO NOT stop early because of token budget. If you sense you are getting close to the limit, START WRAPPING UP and deliver BOTH the narrative resolution AND the CTA within the remaining tokens — abrupt cut-offs are rejected.

═══ FINAL REMINDER ═══
Last reminder before you write: every word of narration must be in {language_name}. Markers stay in English. Every IMAGE prompt must match the topic's culture and era — no foreign motifs sneaking in. The script MUST end with the two-part closing (narrative resolution + audience CTA), never abrupt. Begin now.

Begin the FULL script now in {language_name} (do not stop until you reach ~{minutes}50 words AND have delivered a rounded closing):
"""

METADATA_PROMPT_TEMPLATE = """Given the following narration script, produce YouTube metadata as strict JSON.

═══ TITLE FORMULA (NON-NEGOTIABLE) ═══
The `title_en` MUST follow ONE of these three viral templates used by top-performing documentary-essay channels (HP Theory / Star Wars Theory / Joe Scott / Modern History TV). Pick whichever fits the script BEST:

  Template A — QUESTION  →  "Why Was X SO Y?", "What Really Happened to X?", "How Did X Become Y?"
                              (e.g. "Why Was Tutankhamun's Tomb SO Untouched?")
  Template B — AUTHORITATIVE EXPLAINER  →  "The True Story of X", "The History of X", "Inside X"
                              (e.g. "The True Story of Tutankhamun's Curse")
  Template C — DEFINITIVE / SUPERLATIVE  →  "The X That Changed Y Forever", "The Day X Was Found",
                              "X's Greatest Secret"
                              (e.g. "The Tomb That Rewrote History")

Rules for ALL templates:
  • 5-9 words long. Title Case. NEVER all-caps shouting (only the emphasis word — see below).
  • EXACTLY 1 or 2 words IN ALL-CAPS for emphasis (e.g. "SO Untouched", "REWROTE History"). These caps tokens are short (≤ 7 letters), placed where the surprise lives. Do NOT shout the whole title.
  • No clickbait emojis, no brackets except "(Compilation)" / "(Documentary)" rare cases.
  • Must be specific to the topic — NEVER generic ("Amazing Mystery Revealed!").
  • Under 60 chars TOTAL (including caps tokens).

═══ JSON SHAPE ═══
{{
  "title_en": "viral title following one of templates A/B/C above, with 1-2 ALL-CAPS emphasis words",
  "title_zh": "the same title concept rendered in Chinese, ≤ 30 chars, no all-caps (Chinese has no case)",
  "description": {{
    "en": "full English description: opens with the same hook as the narration, summarises the central question, lists 3-5 key facts viewers will learn, ends with a soft subscribe CTA. 1500-3000 chars. Includes a 'Chapters:' block with timestamps copied verbatim from the script's [CHAPTER: ...] markers.",
    "es": "translation of the English description, same structure",
    "zh": "translation of the English description, same structure"
  }},
  "tags": ["12-20 topic-specific tags drawn from named entities (people, places, dates, events) actually mentioned in the script. Avoid generic ones like 'history' or 'mystery' alone — combine: 'tutankhamun tomb 1922', 'howard carter discovery'"],
  "chapters": [
    {{ "timestamp_seconds": 0, "title": "Opening title verbatim from the [CHAPTER: ...] marker (NOT 'Introduction')" }}
  ]
}}

Script:
{script}

Return ONLY valid JSON, no commentary."""


# v0.2.14 — SEO metadata PACK. The LLM only produces the parts that need
# language understanding (title ideas, keywords, per-language hook / what
# you'll learn / about paragraph). ALL the SEO mechanics — title length
# optimisation, tag de-dup + 500-char budget, hashtag rules, chapters
# from the REAL [CHAPTER:] markers, scoring — are done deterministically
# in routes/seo.py (no API, fully local, topic-agnostic).
SEO_PROMPT_TEMPLATE = """You write YouTube SEO metadata. From the narration below produce STRICT JSON only.

Topic (verbatim, may be empty): {topic}
Target languages (ISO codes): {languages}

Rules:
  • Be SPECIFIC to the actual narration — use the real people, places, dates and events mentioned. Never generic ("Amazing Story!").
  • `title_candidates`: 6 distinct titles, 40-65 characters each, Title Case, no emojis, no surrounding quotes. Mix question / authoritative / definitive angles. Each must read naturally and contain the core subject.
  • `primary_keyword`: the single best 2-4 word search phrase a viewer would type to find this video.
  • `secondary_keywords`: 6-10 more search phrases (named entities + topic combinations), all genuinely relevant.
  • For EACH requested language, in `lang`:
      - `hook`: ONE punchy sentence (< 115 characters) — the single most compelling reason to keep watching. Written natively in that language.
      - `learn`: 4-6 very short phrases (3-8 words) of concrete things the viewer will learn.
      - `about`: 2-3 natural sentences describing the video for search (keyword-rich but human).
  • Everything in a language must be written natively in THAT language (not translated word-for-word).

JSON SHAPE (keys exactly; one entry in `lang` per requested code):
{{
  "title_candidates": ["...", "...", "...", "...", "...", "..."],
  "primary_keyword": "...",
  "secondary_keywords": ["...", "..."],
  "lang": {{
    "en": {{ "hook": "...", "learn": ["...", "..."], "about": "..." }}
  }}
}}

Narration:
{script}

Return ONLY valid JSON, no commentary, no markdown fences."""


SHORTS_DETECTION_PROMPT = """You are picking the most viral 15–60 second moments from a long-form narration to extract as YouTube Shorts. The narration's topic could be ANY subject (mythology of any culture, history, science, biography…). Match your hook style to the actual topic — don't impose xianxia framing on, e.g., an Egyptian or Norse video.

Pick the {n} BEST moments based on these criteria, in order:
  1. A clear hook in the first 3 seconds (cliffhanger, shocking line, paradox)
  2. Self-contained narrative (works without external context)
  3. Strong visual or dramatic beat (revelation, betrayal, turning point)
  4. Endable on a satisfying note (resolution, twist, or open question)

Avoid:
  - Pure exposition without action
  - Mid-sentence cuts
  - Moments shorter than 15s or longer than 60s

Return ONLY a JSON array, no commentary, no markdown:
[{{ "start": <sec>, "end": <sec>, "hook": "<<=80 char teaser line>", "score": <0.0-1.0>, "reason": "<why viral>" }}]
"""

OUTLINE_PROMPT_TEMPLATE = """You are the story architect for a {minutes}-minute long-form documentary narration about: {topic}.

{context_facts}

Design a chapter outline of EXACTLY {n_chapters} chapters that STAGES the topic like a mystery (hook → setup → escalation → reveal → resolution), NOT a flat list. Each chapter must move the narrative forward and not overlap the others.

Return ONLY a JSON object, no prose, no code fence:
{{"chapters":[{{"index":1,"title":"<2-4 evocative words in {language_name}, NOT 'Chapter 1'>","synopsis":"<2-3 sentences, what this chapter covers>","target_words":<int ~ {minutes}*150/{n_chapters}>,"beats":["<concrete beat>","<concrete beat>"]}}]}}"""

CHAPTER_PROMPT_TEMPLATE = """You are narrating chapter {chapter_index} of a long-form documentary in {language_name} about: {topic}.

FULL OUTLINE (for global coherence — do NOT re-tell other chapters):
{outline_block}

WHAT HAS ALREADY BEEN NARRATED (running summary — continue from here, never repeat it):
{running_summary}

Write ONLY chapter {chapter_index} — "{chapter_title}".
Synopsis: {chapter_synopsis}
Beats to hit, in order: {chapter_beats}
Length: about {target_words} words.

Rules:
- Open the chapter with the marker [CHAPTER: {chapter_title}] on its own line.
- Insert [IMAGE: english visual description] every 25-40 words, matching the LITERAL narrated content.
- Insert [MUSIC: mood=epic|serene|mystic|emotional|tense|melancholic|reveal] at mood shifts.
- Narration prose in {language_name}; marker bodies in English.
- Stay strictly on topic. Do NOT summarise other chapters. Do NOT write a closing/CTA unless told this is the final chapter.
{final_clause}"""

SUMMARY_PROMPT_TEMPLATE = """Summarise the documentary narration so far so the next chapter can continue coherently WITHOUT repeating anything.

NARRATION SO FAR (chapters 1..{chapter_index}):
{running_summary}

NEW CHAPTER JUST WRITTEN:
{new_chapter}

Return ONLY a JSON object, no prose:
{{"told":"<=120 words, the storyline covered so far>","open_threads":["<unresolved hook/question>"],"used_facts":["<specific fact/name/date already used>"],"last_paragraph":"<verbatim last paragraph of the new chapter, for voice continuity>"}}"""


# ─── v0.7.0 — Video preset support ────────────────────────────────────
#
# `PRESET_SCRIPT_PROMPT_TEMPLATE` is the system prompt template used by
# every preset OTHER than `narrative_epic`. It's derived dynamically
# from `SCRIPT_PROMPT_TEMPLATE` so there's a single source of truth for
# the common sections (language, factual context, image markers,
# visual diversity rules…). The STORY BEATS + STORY ARC section of
# the original template is replaced by a `{style_directive}` slot that
# the preset fills with its own structure / tone / hook / CTA rules.
#
# `narrative_epic` uses `SCRIPT_PROMPT_TEMPLATE` UNCHANGED — byte-for-
# byte the same string the v0.6.x pipeline used — guaranteeing zero
# regression for any caller that doesn't pass a preset_id.

_STORY_BEATS_MARKER = "═══ STORY BEATS — DOCUMENTARY YOUTUBE VIRAL FORMULA (NON-NEGOTIABLE) ═══"
_FINAL_REMINDER_MARKER = "═══ FINAL REMINDER ═══"

_HEADER, _, _AFTER_HEADER = SCRIPT_PROMPT_TEMPLATE.partition(_STORY_BEATS_MARKER)
_, _, _FOOTER_WITH_FINAL = _AFTER_HEADER.partition(_FINAL_REMINDER_MARKER)
_FOOTER = _FINAL_REMINDER_MARKER + _FOOTER_WITH_FINAL

# If the markers were ever removed from SCRIPT_PROMPT_TEMPLATE this
# assembly would silently lose the footer or header. Guard with a hard
# assertion at import time so the deploy fails loud instead of producing
# broken prompts at runtime.
assert _AFTER_HEADER, (
    "prompts.py: STORY BEATS marker missing from SCRIPT_PROMPT_TEMPLATE — "
    "PRESET_SCRIPT_PROMPT_TEMPLATE cannot be derived"
)
assert _FOOTER_WITH_FINAL, (
    "prompts.py: FINAL REMINDER marker missing — preset assembly broken"
)

PRESET_SCRIPT_PROMPT_TEMPLATE = _HEADER + "{style_directive}\n\n" + _FOOTER


def build_script_prompt(
    preset_id: str | None,
    *,
    topic: str,
    minutes: int,
    language_name: str,
    context_facts: str,
) -> str:
    """Return the system prompt string to send to Gemma for /script.

    Branches by preset:
    - `narrative_epic` (or unknown / None): the v0.6.x verbatim
      `SCRIPT_PROMPT_TEMPLATE` filled with the same placeholders →
      byte-identical to the legacy behaviour (zero regression).
    - Any other preset: the dynamically-derived `PRESET_SCRIPT_PROMPT_TEMPLATE`
      with the preset's `llm_style_directive` substituted into the
      STORY BEATS slot.

    The helper lives in prompts.py (not presets.py) so prompts.py stays
    the single owner of all prompt template strings.
    """
    # Import lazily to avoid a circular dependency at module load.
    from .presets import get_preset

    preset = get_preset(preset_id)
    if preset.id == "narrative_epic":
        template = SCRIPT_PROMPT_TEMPLATE
    else:
        # Splice the directive's literal text into the {style_directive}
        # slot BEFORE calling .format(...), so any placeholders the
        # directive carries (e.g. `{language_name}` in CTA lines) are
        # expanded in the single final format pass. Otherwise .format
        # would treat them as literal text and the directive would
        # ship with un-expanded curly-brace tokens to the LLM.
        template = PRESET_SCRIPT_PROMPT_TEMPLATE.replace(
            "{style_directive}", preset.llm_style_directive
        )
    return template.format(
        topic=topic,
        minutes=minutes,
        language_name=language_name,
        context_facts=context_facts,
    )
