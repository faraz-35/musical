import re

_TIME_RE = re.compile(r"\[(\d+):(\d+)(?:[.:](\d+))?\]")


def search_synced(artist, track, title):
    """Return a synced LRC string for the song, or None when nothing is found."""
    import syncedlyrics

    term = " ".join(p for p in [artist, track] if p).strip() or title
    if not term:
        return None
    try:
        return syncedlyrics.search(term)
    except Exception:
        return None


def _stamp_to_sec(mm, ss, xx):
    return int(mm) * 60 + int(ss) + (float("0." + xx) if xx else 0.0)


def parse_lrc(lrc):
    """Parse an LRC string into a sorted list of {start: float, text: str}."""
    out = []
    for raw in lrc.splitlines():
        raw = raw.strip()
        if not raw:
            continue
        stamps = _TIME_RE.findall(raw)
        if not stamps:
            continue
        text = _TIME_RE.sub("", raw).strip()
        for mm, ss, xx in stamps:
            out.append({"start": round(_stamp_to_sec(mm, ss, xx), 3), "text": text})
    out.sort(key=lambda x: x["start"])
    seen = set()
    deduped = []
    for item in out:
        key = (item["start"], item["text"])
        if key not in seen:
            seen.add(key)
            deduped.append(item)
    return deduped
