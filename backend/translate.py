import json
import os

import requests

ZAI_URL = "https://api.z.ai/api/paas/v4/chat/completions"
MODEL = "glm-4.6"

SYSTEM = """You are an expert literary translator specializing in song lyrics \
from Persian (Farsi), Arabic, French and other languages into English.

For EVERY input line you produce TWO English translations:
- translation_direct: a faithful, literal translation that preserves the exact \
meaning as plainly and accurately as possible.
- translation_romantic: a poetic, evocative, singable rendering that captures \
the emotion, imagery and spirit of the original line.

Rules:
- Preserve the input order and the EXACT number of lines.
- Keep proper nouns and place names.
- If a line is a vocalization / interjection with no literal meaning, set \
translation_direct to a bracketed romanization (e.g. "[oylum oy]") and give \
translation_romantic an evocative equivalent.
- Do not merge or split lines.

Return ONLY a JSON object of the form:
{"lines": [{"i": <int>, "translation_direct": "...", "translation_romantic": "..."}]}
"""


def translate_lines(items, lang_hint="auto"):
    """Translate a batch of lines.

    items: list of {"i": int, "text": str}
    returns: dict {i: {"direct": str, "romantic": str}}
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
        out[ln["i"]] = {
            "direct": ln.get("translation_direct", ""),
            "romantic": ln.get("translation_romantic", ""),
        }
    return out
