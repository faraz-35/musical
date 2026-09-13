import json
import os
import time

import requests

ZAI_URL = "https://api.z.ai/api/paas/v4/chat/completions"
MODEL = "glm-5.3-flash"

# glm-5.3-flash always reasons (the API rejects thinking=disabled, error 1210);
# "low" is the cheapest effort, which is all lyric translation needs.
THINKING = {"type": "enabled", "reasoning": "low"}

# Hard ceiling on the total input size sent to the LLM in one request, in
# characters. A normal song sits well under this; exceeding it almost always
# means a garbage/wrong LRC rather than a real song. We refuse rather than
# risk a large, accidental API spend.
MAX_INPUT_CHARS = 20_000

# A reasoning model can still run long on big songs; 300s headroom avoids the
# ReadTimeout we saw on long tracks. One retry on a transient timeout/
# connection error covers Z.ai's occasional blips.
ZAI_TIMEOUT_S = 300
ZAI_MAX_ATTEMPTS = 2
ZAI_RETRY_BACKOFF_S = 4


class InputTooLarge(ValueError):
    """Raised when the lyrics input exceeds MAX_INPUT_CHARS."""

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
- Each field must be a single short line, about as long as the input line \
itself. Never a paragraph; never two sentences when the input line is one. \
These lines are sung one at a time on screen.

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

    total_chars = sum(len(it.get("text", "")) for it in items)
    if total_chars > MAX_INPUT_CHARS:
        raise InputTooLarge(
            f"Lyrics input too large ({total_chars} chars > {MAX_INPUT_CHARS}); "
            "refusing to send to LLM."
        )

    key = os.environ.get("ZAI_API_KEY")
    if not key:
        raise RuntimeError("ZAI_API_KEY is not set.")

    payload = {
        "model": MODEL,
        "thinking": THINKING,
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

    # Retry transient transport errors (timeouts, connection resets). A 4xx from
    # Z.ai is NOT retried — raise_for_status surfaces it immediately, since it's
    # almost certainly a bad request / auth issue that won't fix itself.
    last_err = None
    for attempt in range(1, ZAI_MAX_ATTEMPTS + 1):
        try:
            resp = requests.post(
                ZAI_URL,
                headers={
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=ZAI_TIMEOUT_S,
            )
            resp.raise_for_status()
            break
        except (requests.Timeout, requests.ConnectionError) as e:
            last_err = e
            if attempt < ZAI_MAX_ATTEMPTS:
                time.sleep(ZAI_RETRY_BACKOFF_S * attempt)
                continue
            raise
    else:
        # Loop exhausted without break: only reachable if a transient error
        # recurred on every attempt. Re-raise the last one.
        if last_err:
            raise last_err

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
