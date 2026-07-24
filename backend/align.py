"""Forced alignment of known lyric lines against Whisper word timestamps.

Whisper (via Groq) returns words with start/end times, but the transcribed
*text* is often imperfect — especially for Persian/Arabic, where the model
may mishear vowels or split words oddly. We trust our own lyric text (from an
LRC or the user) and use the transcription only as a *timing* source.

`align_lines` is used by the /resync path, which ALWAYS has approximate
per-line timing from the existing cached record (the LRC timestamps we want to
correct). That timing is used as a *starting hint*, but the search is made
robust to systematic drift:

  - Each line searches a wide window around its hint (±back/+forward).
  - When a line is confidently matched, the delta between its matched start
    and its hint is carried forward as a running offset. The next line's
    effective hint becomes its original hint + that running offset. This lets
    alignment track whole-song shifts (e.g. a live recording whose audio lags
    the studio-version LRC by 80s) while still allowing per-line wobble.
  - Scoring rewards token coverage and penalizes window length, so a tight
    cluster of real matches always beats a long span of incidental overlap.
    A minimum coverage threshold guards against matching intro narration or
    instrumental placeholders ("موسیقی"/music).

This is what makes alignment reliable even when Whisper labels long sung
sections as non-speech and emits "music" markers instead of transcribing them.
"""

import re
import unicodedata
from bisect import bisect_left

# Matches across Latin + Arabic/Persian/Cyrillic letter ranges. We keep word
# characters (including marks) and apostrophes; everything else is a separator.
_TOKEN_SPLIT = re.compile(r"[^\w'\u0600-\u06FF\u0400-\u04FF]+", re.UNICODE)

# Search window around each line's (offset-adjusted) hint, in seconds. The
# forward window is deliberately wide: sung audio is often shifted well past
# the LRC in live recordings, and the scoring + coverage guard below makes a
# wide search safe (noise never out-scores a real tight match).
HINT_BACK = 6.0
HINT_FORWARD = 90.0
# A lyric line never spans more than this much audio (seconds). Caps the window
# so a single bad line can't swallow a whole verse.
MAX_LINE_DUR = 18.0
# Per-word cost added to a candidate window; rewards tight clusters.
LEN_PENALTY = 0.35
# Minimum token coverage ratio to accept a match (else fall back to hint timing).
MIN_COVERAGE = 0.25
# When a line is matched, carry its (matched_start - hint) forward as the
# expected offset for subsequent lines, blended with the running offset so a
# single noisy match can't derail the whole song.
OFFSET_SMOOTH = 0.6  # weight on the newly-observed offset


def normalize_token(tok):
    """Lowercase, strip diacritics/punctuation, trim Persian/Arabic tatweel."""
    if not tok:
        return ""
    tok = unicodedata.normalize("NFKC", tok).lower().strip()
    # Drop combining marks (Arabic harakat, etc.) so phonetic comparisons line up.
    tok = "".join(
        c for c in unicodedata.normalize("NFD", tok) if not unicodedata.combining(c)
    )
    tok = tok.replace("\u0640", "")  # tatweel
    tok = tok.strip(".,،;:!?\"'()[]{}…-–—")
    return tok


def tokenize(text):
    """Split text into a list of normalized tokens, dropping empties."""
    return [
        t for t in (normalize_token(x) for x in _TOKEN_SPLIT.split(text or "")) if t
    ]


def _token_match(wt, lt):
    """True if a word token matches a line token. Whisper mishears vowels and
    glues/splits words, so beyond exact equality accept prefix matches (>=3
    chars): e.g. "sepid" vs "sepidam", "miyayi" vs "mi"."""
    if wt == lt:
        return True
    if len(wt) >= 3 and len(lt) >= 3 and (wt.startswith(lt) or lt.startswith(wt)):
        return True
    return False


def align_lines(line_texts, words, hints=None):
    """Align known lyric line texts to ordered transcribed words.

    Args:
        line_texts: list of strings (the trusted lyrics, in order).
        words: list of dicts with "word"/"text", "start", "end" (float seconds).
        hints: optional list of approximate start times (one per line) from the
            existing record. When provided, each line's search is confined to a
            window around its hint (drift-adjusted — see module docstring).

    Returns:
        list of {"start": float, "end": float}, one per input line. Falls back
        to the hint timing (or a small gap) when a line can't be confidently
        matched. Never raises.
    """
    # Normalize the word stream once.
    w_tokens = []
    for w in words or []:
        raw = w.get("word") or w.get("text") or ""
        nt = normalize_token(raw)
        if not nt:
            continue
        try:
            start = float(w.get("start", 0.0))
            end = float(w.get("end", start))
        except (TypeError, ValueError):
            continue
        w_tokens.append({"t": nt, "s": start, "e": end})

    word_starts = [w["s"] for w in w_tokens]
    n_words = len(w_tokens)
    results = []
    last_end = 0.0
    running_offset = 0.0  # carried-forward (matched_start - hint) drift estimate

    for li, line in enumerate(line_texts):
        l_toks = tokenize(line)
        n = len(l_toks)

        # Base hint for this line (original LRC start, or last_end if none).
        if hints and li < len(hints) and hints[li] is not None:
            raw_hint = float(hints[li])
        else:
            raw_hint = last_end
        # Apply carried-forward drift so a whole-song shift is tracked.
        hint = raw_hint + running_offset

        # Fallback span (used if no good match): the drift-adjusted hint.
        fb_start = hint
        fb_end = fb_start + 4.0

        if not l_toks or n_words == 0:
            results.append({"start": round(fb_start, 3), "end": round(fb_end, 3)})
            last_end = fb_end
            continue

        lo = bisect_left(word_starts, hint - HINT_BACK)
        hi = bisect_left(word_starts, hint + HINT_FORWARD)
        lo = max(0, min(lo, n_words))
        hi = max(lo, min(hi, n_words))

        best_score = -1e9
        best_start = None
        best_end = None
        best_matched = 0

        for ws in range(lo, hi):
            line_set = list(l_toks)
            matched = 0
            for we in range(ws, hi):
                # Stop extending once the window exceeds the max line duration.
                if w_tokens[we]["s"] - w_tokens[ws]["s"] > MAX_LINE_DUR:
                    break
                wt = w_tokens[we]["t"]
                # Count each line token at most once.
                for j, lt in enumerate(line_set):
                    if lt is not None and _token_match(wt, lt):
                        matched += 1
                        line_set[j] = None
                        break
                window_len = we - ws + 1
                score = matched - LEN_PENALTY * window_len
                if score > best_score:
                    best_score = score
                    best_start = ws
                    best_end = we
                    best_matched = matched

        coverage = best_matched / n if n else 0
        if best_start is None or coverage < MIN_COVERAGE:
            # No confident match — keep the drift-adjusted hint timing and do
            # NOT update the running offset (a miss shouldn't derail drift).
            results.append({"start": round(fb_start, 3), "end": round(fb_end, 3)})
            last_end = fb_end
            continue

        start = w_tokens[best_start]["s"]
        end = w_tokens[best_end]["e"]
        if end <= start:
            end = start + 1.0
        results.append({"start": round(start, 3), "end": round(end, 3)})
        last_end = end

        # Update the running drift estimate from this confident match.
        observed = start - raw_hint
        running_offset = OFFSET_SMOOTH * observed + (1 - OFFSET_SMOOTH) * running_offset

    return results
