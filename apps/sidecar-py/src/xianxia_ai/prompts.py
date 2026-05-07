"""Prompt templates for the LLM phases."""

SCRIPT_PROMPT_TEMPLATE = """RESPONDE EXCLUSIVAMENTE EN {language_name}. WRITE EVERY NARRATION SENTENCE IN {language_name}. NEVER USE ENGLISH FOR THE PROSE.

You are a master narrator for a YouTube channel about Chinese mythology, xianxia, wuxia, and cultivation lore. Your tone is epic, mystical, and accessible to a global audience.

Write a COMPLETE narration script in {language_name} of approximately {minutes} minutes (~{minutes}50 words at 150 wpm) about: {topic}

═══ LANGUAGE (NON-NEGOTIABLE) ═══
- The narration prose MUST be entirely in {language_name}. Not English. Not bilingual. ONLY {language_name}.
- The ONLY English content allowed is INSIDE the technical marker bodies: [IMAGE: english description], [MUSIC: english label], [CHAPTER: english title]. These are pipeline instructions, the viewer never reads them.
- If you slip into English at any point, the script is rejected. Stay strictly in {language_name} for everything outside those bracketed markers.

═══ STRUCTURE (mandatory) ═══
- Open in medias res — never with "In this video", "Today we'll talk about", "Welcome".
- Write flowing prose in {language_name}. Use occasional second-person address ("imagine you stand…" — translated to {language_name}).
- Use ~150 words per minute. Target ≈{minutes}50 words. DO NOT stop early.

═══ MARKERS (mandatory frequency) ═══
1. [IMAGE: …] — insert ONE marker every 40-80 words of prose (≈ every 15-30 seconds).
   For a {minutes}-minute script that means roughly {minutes}*4 = {minutes}-many image markers TOTAL. DO NOT generate fewer.
2. [MUSIC: mood=epic|serene|mystic|emotional|tense|melancholic] — at every chapter boundary.
3. [CHAPTER: Title] — every 2-4 minutes (so {minutes}/3 ≈ a few chapters).

═══ IMAGE PROMPT QUALITY (critical) ═══
Each [IMAGE: …] MUST be UNIQUE and CONTEXTUAL — describe the EXACT moment of narration that follows it.

═══ MANDATORY SHOT-TYPE ROTATION ═══
You MUST alternate between these 6 shot types so the video doesn't show
"a person standing in front of mountains" for every beat. Cycle through them:

  Type A — WIDE LANDSCAPE (no people):
    "vast frozen lake at dawn, mist rising, distant pagoda silhouette, no people, cinematic, photorealistic"

  Type B — ACTION MOMENT (movement, energy, conflict):
    "a sword cuts through the air leaving a trail of blue qi, sparks scattering, motion blur, dynamic angle, photorealistic"

  Type C — EXTREME CLOSE-UP (hand, eye, object, symbol):
    "close-up of a calloused hand pressing onto an ancient bronze talisman, golden glyphs igniting around the fingers, shallow depth of field, ultra detailed"

  Type D — CHARACTER SHOT (person doing something specific):
    "an elderly Daoist monk seated cross-legged on a moss-covered stone, eyes closed, faint silver qi spiraling around his shoulders, photorealistic"

  Type E — SYMBOLIC OBJECT (no people, ritual or magical item):
    "an open scroll on a black lacquered table, ink characters smoldering as if alive, candles guttering, low key lighting"

  Type F — ARCHITECTURE / INTERIOR (no people, atmospheric):
    "interior of an abandoned mountain temple, broken statues, vines through the roof, sun rays through cracks, atmospheric"

Pattern for {minutes}-minute video: A → D → C → B → E → D → F → C → ...
NEVER place two TYPE-D character shots in a row.
NEVER use the same character appearance twice unless the narration explicitly returns to that character.

═══ EVERY IMAGE PROMPT MUST INCLUDE ═══
  • SHOT TYPE (one of A–F above) — pick a DIFFERENT one from the previous image
  • SUBJECT — what is the focal point of THIS frame
  • ACTION or STATE — what is happening (or implied)
  • LOCATION — specific place (not just "mountains")
  • MOOD/LIGHT — dawn / dusk / moonlit / lantern-glow / qi-glow / blood-red sunset / overcast
  • STYLE TAG — append: "cinematic, photorealistic, ultra detailed, dramatic lighting"

═══ HARD DIVERSITY RULES ═══
  • If image N had a person → image N+1 MUST be a landscape, object, or close-up (NOT another full-body person shot).
  • If image N was set in mountains → image N+1 must be elsewhere (cave, hall, water, sky, forge, library).
  • If image N had jade-green colour palette → image N+1 must use a DIFFERENT palette (red lanterns, blue moonlight, golden temple light, black ink, snowy white).
  • DO NOT default to "jade mountains, swirling qi, golden light" for every image. That phrase is BANNED unless the narration is literally about jade mountains in that exact moment.

═══ EXAMPLE OF CORRECT MARKER DENSITY (for 1 minute) ═══
[IMAGE: a young cultivator in white robes kneels at the edge of a frozen lake, breath steaming in dawn light, distant peaks reflected on the ice, cinematic, photorealistic]
He had walked seven days through the snow to reach this place. The elders said it was where the first immortal had crossed.
[IMAGE: close-up of the cultivator's hand pressing against ancient stone tablets half-buried in ice, faint qi-glyphs glowing blue beneath his palm, dramatic lighting, ultra detailed]
The tablets answered him before he could speak.
[IMAGE: a translucent dragon-figure made of swirling mist erupts upward from the frozen lake, scattering ice shards into a low golden sun, epic, photorealistic, cinematic]
…

═══ FINAL REMINDER ═══
Last reminder before you write: every word of narration must be in {language_name}. Markers stay in English. Begin now.

Begin the FULL script now in {language_name} (do not stop until you reach ~{minutes}50 words):
"""

METADATA_PROMPT_TEMPLATE = """Given the following xianxia narration script, produce YouTube metadata as strict JSON with this shape:
{{
  "title_en": "compelling English title under 60 chars",
  "title_zh": "标题 in Chinese, also under 30 chars",
  "description": {{
    "en": "full description with hooks, 1500-3000 chars, includes timestamps from chapter markers",
    "es": "Spanish translation",
    "zh": "Chinese translation"
  }},
  "tags": ["xianxia", "cultivation", ...],
  "chapters": [
    {{ "timestamp_seconds": 0, "title": "..." }}
  ]
}}

Script:
{script}

Return ONLY valid JSON, no commentary.
"""

SHORTS_DETECTION_PROMPT = """You are picking the most viral 15–60 second moments from a long xianxia narration to extract as YouTube Shorts.

Pick the {n} BEST moments based on these criteria, in order:
  1. A clear hook in the first 3 seconds (cliffhanger, shocking line, paradox)
  2. Self-contained narrative (works without external context)
  3. Strong visual or dramatic beat (god revealing power, betrayal, ascension)
  4. Endable on a satisfying note (resolution, twist, or open question)

Avoid:
  - Pure exposition without action
  - Mid-sentence cuts
  - Moments shorter than 15s or longer than 60s

Return ONLY a JSON array, no commentary, no markdown:
[{{ "start": <sec>, "end": <sec>, "hook": "<<=80 char teaser line>", "score": <0.0-1.0>, "reason": "<why viral>" }}]
"""
