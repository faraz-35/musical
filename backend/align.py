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

Two robustness passes run after the raw match, because Whisper transcribes
sung Persian/Arabic poorly and many lines will NOT match confidently:

  1. Interpolation — lines that fell back to their stale hint are re-placed
     proportionally between the nearest surrounding CONFIDENT matches (anchors).
     A whole-song shift can't be recovered by replaying the old LRC time, but
     it CAN be recovered by interpolating between the lines Whisper did hear.
  2. Monotonicity — every line's start is forced to be >= the previous line's
     end (deduping exact-duplicate spans along the way), so the overlay never
     sees overlapping/backwards lines that would make it jump.

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
# Cap on the carried-forward drift. A real whole-song shift is tens of seconds;
# anything beyond this is a spurious match (e.g. matching a repeated chorus
# line far from where it belongs) and shouldn't skew the rest of the song.
OFFSET_MAX = 120.0
# Assumed line length when a matched line has no usable end time, and the floor
# gap enforced between consecutive lines in the monotonicity pass.
DEFAULT_LINE_DUR = 4.0


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


def _score_window(line_texts, words, hints):
    """First pass: for each line, find the best-matching word window.

    Returns a list of dicts, one per line, each with:
      start, end: matched span (or drift-adjusted hint fallback)
      matched: bool — True if this is a CONFIDENT match (an anchor)
      raw_hint: the original hint for this line (pre-drift), kept for interp.
    Never raises.
    """
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
    entries = []
    running_offset = 0.0  # carried-forward (matched_start - hint) drift estimate

    for li, line in enumerate(line_texts):
        l_toks = tokenize(line)
        n = len(l_toks)

        if hints and li < len(hints) and hints[li] is not None:
            raw_hint = float(hints[li])
        else:
            raw_hint = entries[-1]["end"] if entries else 0.0
        # Clamp the carried offset so a single spurious match can't blow up the
        # search window for the rest of the song.
        hint = raw_hint + max(-OFFSET_MAX, min(OFFSET_MAX, running_offset))

        fb_start = hint
        fb_end = fb_start + DEFAULT_LINE_DUR

        if not l_toks or n_words == 0:
            entries.append(
                {"start": fb_start, "end": fb_end, "matched": False, "raw_hint": raw_hint}
            )
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
            entries.append(
                {"start": fb_start, "end": fb_end, "matched": False, "raw_hint": raw_hint}
            )
            continue

        start = w_tokens[best_start]["s"]
        end = w_tokens[best_end]["e"]
        if end <= start:
            end = start + 1.0
        entries.append(
            {"start": start, "end": end, "matched": True, "raw_hint": raw_hint}
        )

        # Update the running drift estimate from this confident match.
        observed = start - raw_hint
        running_offset = OFFSET_SMOOTH * observed + (1 - OFFSET_SMOOTH) * running_offset

    return entries


def _interpolate(entries):
    """Second pass: re-place non-matched lines proportionally between anchors.

    A non-matched line's fallback time is its stale LRC hint (+ drift), which
    for a live recording is often the very thing we're trying to correct. When
    we have confident matches (anchors) on both sides of a run of misses, we
    know the audio is shifted by roughly (anchor_start - anchor_hint) at each
    end — so we distribute the miss lines evenly across the audio span between
    the anchors, instead of trusting the hint.
    """
    n = len(entries)
    if n <= 1:
        return entries

    # Find indices of all confident matches (anchors).
    anchors = [i for i, e in enumerate(entries) if e["matched"]]

    for i, e in enumerate(entries):
        if e["matched"]:
            continue

        # Nearest anchor before and after this line.
        prev_a = None
        for a in anchors:
            if a < i:
                prev_a = a
            else:
                break
        next_a = None
        for a in reversed(anchors):
            if a > i:
                next_a = a
            else:
                break

        if prev_a is not None and next_a is not None:
            # Distribute the gap lines evenly across the audio span between
            # the two anchors (excluding the anchors themselves).
            gap_lines = next_a - prev_a - 1  # miss lines strictly between
            if gap_lines <= 0:
                continue
            span_start = entries[prev_a]["end"]
            span_end = entries[next_a]["start"]
            if span_end <= span_start:
                continue  # anchors overlap oddly; leave the hint fallback
            slot = i - prev_a  # 1..gap_lines
            slot_dur = (span_end - span_start) / gap_lines
            new_start = span_start + (slot - 1) * slot_dur
            new_end = new_start + slot_dur
            entries[i]["start"] = new_start
            entries[i]["end"] = new_end
        # else: misses at the very start/end with no surrounding anchor keep
        # their drift-adjusted hint fallback — nothing better is available.

    return entries


def _enforce_monotonic(entries):
    """Third pass: force every line's start >= previous line's end.

    Also dedupes exact-duplicate spans (a recurring chorus line that matched
    the same Whisper words twice). Output start/end are rounded to 3 decimals
    to match the existing cache record shape. Lines that would be squeezed to
    zero length get a tiny floor so the overlay still shows them.
    """
    out = []
    prev_end = None
    for e in entries:
        start = e["start"]
        end = e["end"]
        if end <= start:
            end = start + 1.0
        if prev_end is not None and start < prev_end:
            # Push this line to start right after the previous one. If its own
            # end would then fall at/below the new start, give it a floor.
            start = prev_end
            if end <= start:
                end = start + DEFAULT_LINE_DUR
        out.append({"start": round(start, 3), "end": round(end, 3)})
        prev_end = end
    return out


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
        matched, then interpolates misses between anchors and enforces strict
        monotonicity. Never raises.
    """
    entries = _score_window(line_texts, words, hints)
    entries = _interpolate(entries)
    return _enforce_monotonic(entries)
