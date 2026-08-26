"""YouTube caption-track fetching: a second timing source for /resync.

Uploader-authored tracks are human-timed against THIS video's own clock, which
makes them the best source for line structure, splits and pacing. Two caveats
the consumer (the resync agent) must handle:

  - The whole track can carry a CONSTANT offset vs the audio (a real case
    measured +5.04s late) — absolute times need cross-checking against
    acoustic onsets.
  - Videos often carry several manually-timed TRANSLATION tracks, each timed
    independently (different segmentation AND different offsets). Only the
    lyric-language track is useful, so fetch_best ranks tracks by lexical
    overlap with the lyric text (same-language cues share most tokens,
    translations share almost none) and returns one PRIMARY track in full,
    the rest as short samples.

Subtitles are fetched via the DEFAULT client chain: mweb discards subtitle
formats without a GVS PO token, so no player_client override here (the media
403 problem only affects format downloads, not caption data). Auto (ASR)
captions are only used when no manual track exists — noisy timing, and the
translation matrix would explode the bundle, so just the original-language
track is taken.
"""

import html
import re
import tempfile
from pathlib import Path

import yt_dlp

import align
import youtube


class CaptionError(RuntimeError):
    """Raised when a caption track exists but can't be downloaded or parsed."""


_TS = re.compile(r"(\d+):(\d+):(\d+\.\d+)\s*-->\s*(\d+):(\d+):(\d+\.\d+)")
_TAG = re.compile(r"<[^>]+>")


def _canonical(url):
    vid = youtube.extract_video_id(url)
    return f"https://www.youtube.com/watch?v={vid}" if vid else url


def _auto_lang(pool):
    """The original-audio auto-caption track ('<lang>-orig'), else first."""
    for lang in sorted(pool):
        if lang.endswith("-orig"):
            return lang
    return sorted(pool)[0]


def _parse_vtt(text):
    """Parse a WebVTT caption file into [{start, end, text}] cues."""
    cues = []
    for block in text.split("\n\n")[1:]:
        m = _TS.search(block)
        if not m:
            continue
        g = [float(x) for x in m.groups()]
        raw = " ".join(ln.strip() for ln in block.splitlines()[1:] if ln.strip())
        raw = html.unescape(_TAG.sub("", raw))
        if not raw:
            continue
        cues.append(
            {
                "start": round(g[0] * 3600 + g[1] * 60 + g[2], 3),
                "end": round(g[3] * 3600 + g[4] * 60 + g[5], 3),
                "text": raw,
            }
        )
    return cues


def _overlap(track_cues, line_texts):
    """Fraction of a track's cue tokens that appear in the lyric text.

    Same-language cues share most tokens with the lyrics; translations share
    almost none — a clean separator (observed 0.6+ vs 0.005 on a real video).
    Cross-script pairs (romanized lyrics vs native-script cues) score ~0 for
    every track; that case is detected and surfaced rather than guessed.
    """
    cue_tokens = set()
    for cue in track_cues:
        cue_tokens.update(align.tokenize(cue["text"]))
    lyric_tokens = set()
    for text in line_texts:
        lyric_tokens.update(align.tokenize(text))
    if not cue_tokens or not lyric_tokens:
        return 0.0
    return len(cue_tokens & lyric_tokens) / len(cue_tokens)


def fetch_best(url, line_texts):
    """Return the caption evidence for the agent bundle:

        {
          "primary":   {"track": "fr-xyz (manual)", "score": 0.62, "cues": [...]}
                       | None  (no track confidently matches the lyrics),
          "alternates": [{"track": "de-… (manual)", "score": 0.005,
                          "sample": [first 5 cues]}]
        }

    `line_texts` (the cached lyric lines) drive primary-track selection.
    Returns None when the video has no caption track at all (a normal
    outcome, not an error); CaptionError means tracks exist but
    downloading/parsing failed.
    """
    target = _canonical(url)
    list_opts = {"quiet": True, "no_warnings": True, "noplaylist": True}
    try:
        with yt_dlp.YoutubeDL(list_opts) as ydl:
            info = ydl.extract_info(target, download=False)
    except Exception as e:
        raise CaptionError(f"Caption listing failed: {e}") from e

    manual = info.get("subtitles") or {}
    auto = info.get("automatic_captions") or {}
    if manual:
        kind = "manual"
        langs = sorted(manual)
    elif auto:
        kind = "auto"
        langs = [_auto_lang(auto)]
    else:
        return None

    with tempfile.TemporaryDirectory(prefix="musical-captions-") as td:
        outtmpl = str(Path(td) / "%(id)s.%(ext)s")
        opts = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "skip_download": True,
            "writesubtitles": kind == "manual",
            "writeautomaticsub": kind == "auto",
            "subtitleslangs": langs,
            "subtitlesformat": "vtt/best",
            "outtmpl": outtmpl,
        }
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([target])
        except Exception as e:
            raise CaptionError(f"Caption download failed: {e}") from e

        tracks = []
        for vtt in sorted(Path(td).glob("*.vtt")):
            # Filenames look like <videoId>.<lang>.vtt — recover the track id.
            lang = vtt.name.split(".", 1)[1][: -len(vtt.suffix)]
            cues = _parse_vtt(vtt.read_text(encoding="utf-8", errors="replace"))
            if cues:
                tracks.append({"track": f"{lang} ({kind})", "cues": cues})

    if not tracks:
        raise CaptionError("Caption tracks downloaded but parsed to zero cues.")

    scored = [(round(_overlap(t["cues"], line_texts), 3), t) for t in tracks]
    scored.sort(key=lambda pair: -pair[0])
    primary = None
    if scored[0][0] >= 0.15:
        score, t = scored[0]
        primary = {"track": t["track"], "score": score, "cues": t["cues"]}
    alternates = [
        {"track": t["track"], "score": score, "sample": t["cues"][:5]}
        for score, t in scored
    ]
    return {"primary": primary, "alternates": alternates}
