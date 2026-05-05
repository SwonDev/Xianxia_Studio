"""Prompt templates for the LLM phases."""

SCRIPT_PROMPT_TEMPLATE = """You are a master narrator for a YouTube channel about Chinese mythology, xianxia, wuxia, and cultivation lore. Your tone is epic, mystical, and accessible to Western audiences.

Write a complete narration script of approximately {minutes} minutes about: {topic}

Rules:
- Write in flowing English prose, in second-person occasional address ("imagine you stand…").
- Insert image markers as [IMAGE: detailed cinematic xianxia scene description] every 12-25 seconds of narration.
- Insert music mood markers as [MUSIC: mood=epic|serene|mystic|emotional] at chapter boundaries.
- Insert chapter markers as [CHAPTER: Title] every 2-4 minutes.
- Use ~150 words per minute. Total: ~{minutes}50 words approx.
- DO NOT use any meta language ("In this video", "Today we'll talk about"). Open in medias res.
- Image prompts must include style cues: "cinematic, jade mountains, swirling qi, golden light, photorealistic, ultra detailed".

Begin the script now:
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

SHORTS_DETECTION_PROMPT = """Given the following xianxia narration script with timestamps and the audio waveform energy peaks, identify the {n} most viral 15-60 second moments.

Return JSON: [{{ "start": <sec>, "end": <sec>, "hook": "<short text>", "score": <0-1> }}]
"""
