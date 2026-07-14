import json
import os

import requests

ZAI_URL = "https://api.z.ai/api/paas/v4/chat/completions"
MODEL = "glm-4.6"

SYSTEM = """You are an expert literary translator specializing in song lyrics \
from Persian (Farsi), Arabic, French and other languages into English.

For EVERY input line you produce three fields:

- romanized: a phonetic sing-along guide written in the Latin alphabet, aimed at \
an English speaker who wants to pronounce and sing the line. Approximate the \
sounds using English spelling conventions (e.g. Persian "خ" -> "kh", French \
"Je t'aime" -> "zhuh tem", "rue" -> "roo"). Mark stress only if it aids singing.
- translation_direct: a faithful, literal translation that preserves the exact \
meaning as plainly and accurately as possible.
- meaning: a plain-English restatement of what the line actually says, with \
metaphor, cultural reference, idiom and poetic imagery stripped away to the \
underlying sentiment. If the line is already plain and literal, just restate it \
in clear everyday English. Keep it short.

Rules:
- Preserve the input order and the EXACT number of lines.
- Keep proper nouns and place names (romanized for pronunciation, kept as-is \
in translation_direct and meaning).
- If a line is entirely in English, set romanized to null (the line needs no \
pronunciation guide) and copy the line verbatim into translation_direct and \
meaning.
- If a line is a vocalization / interjection with no literal meaning, set \
translation_direct to a bracketed romanization (e.g. "[oylum oy]"), give \
romanized the sing-along form, and put an evocative equivalent in meaning.
- Do not merge or split lines.

Return ONLY a JSON object of the form:
{"lines": [{"i": <int>, "romanized": "..." or null, "translation_direct": "...", "meaning": "..."}]}
"""


def translate_lines(items, lang_hint="auto"):
    """Translate a batch of lines.

    items: list of {"i": int, "text": str}
    returns: dict {i: {"romanized": str or None, "direct": str, "meaning": str}}
    """
    if not items:
        return {}
    key = os.environ.get("ZAI_API_KEY")
    if not key:
        raise RuntimeError("ZAI_API_KEY is not set.")

    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {
                "role": "user",
                "content": json.dumps(
                    {"language_hint": lang_hint, "lines": items}, ensure_ascii=False
                ),
            },
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.7,
    }
    resp = requests.post(
        ZAI_URL,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json=payload,
        timeout=180,
    )
    resp.raise_for_status()
    content = resp.json()["choices"][0]["message"]["content"]
    data = json.loads(content)

    out = {}
    for ln in data.get("lines", []):
        romanized = ln.get("romanized")
        out[ln["i"]] = {
            "romanized": romanized if isinstance(romanized, str) and romanized.strip() else None,
            "direct": ln.get("translation_direct", ""),
            "meaning": ln.get("meaning", ""),
        }
    return out
