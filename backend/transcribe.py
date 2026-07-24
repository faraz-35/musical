"""Whisper transcription via Groq's free API (Slice 2).

Two roles:
  1. Fallback in /process when no synced LRC is found — the transcribed text
     becomes the lyric text, and the word timestamps define line timing.
  2. Re-sync from audio (/resync) — the transcription provides fresh timing
     that is aligned against the already-trusted lyric text in the cache.

Groq hosts OpenAI's Whisper models on their hardware; the free tier allows
~2000 requests/day with a 25MB file cap. A typical song is 3-8MB as 16kHz mono
opus/m4a, well under the cap. We request word-level timestamps so align.py can
pin our lyrics to the actual audio.

Audio is downloaded with yt-dlp using the same noplaylist + canonical-URL
pattern as youtube.py (see gotcha #2 in AGENTS.md).
"""

import os
import tempfile
from pathlib import Path

import requests

import youtube

GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
MODEL = "whisper-large-v3"


class TranscriptionError(RuntimeError):
    """Raised when audio download or transcription fails."""


def download_audio(url, timeout=180):
    """Download a YouTube video's audio to a temp 16kHz mono file.

    Returns a Path to the downloaded file (caller should unlink it). Uses the
    noplaylist + canonical watch-URL pattern from youtube.get_metadata so the
    radio-mix playlist can't trigger a full extraction (gotcha #2).
    """
    import yt_dlp

    vid = youtube.extract_video_id(url)
    target = f"https://www.youtube.com/watch?v={vid}" if vid else url

    # Use a temp *directory* with %(id)s.%(ext)s so yt-dlp picks the right
    # extension (opus/webm/m4a depending on the selected format) and there's
    # no pre-existing file for it to skip over.
    tmpdir = Path(tempfile.mkdtemp(prefix="musical-audio-"))
    outtmpl = str(tmpdir / "%(id)s.%(ext)s")

    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "format": "bestaudio/best",
        "outtmpl": outtmpl,
        # Convert to 16kHz mono — Whisper's expected input, and keeps the file
        # well under Groq's 25MB cap.
        "postprocessor_args": ["-ar", "16000", "-ac", "1"],
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([target])
    except Exception as e:
        _cleanup_dir(tmpdir)
        raise TranscriptionError(f"Audio download failed: {e}") from e

    # Find the first non-empty media file yt-dlp produced.
    for c in sorted(tmpdir.iterdir()):
        if c.is_file() and c.stat().st_size > 0:
            return c
    raise TranscriptionError("Audio download produced no output file.")


def _cleanup_dir(d):
    """Best-effort removal of a temp dir and its contents."""
    try:
        for f in d.iterdir():
            f.unlink(missing_ok=True)
        d.rmdir()
    except Exception:
        pass


def transcribe(url):
    """Download audio for `url` and transcribe it via Groq Whisper.

    Returns a list of {"start": float, "end": float, "text": str} (one entry
    per transcribed word, in order). Raises TranscriptionError on failure.
    """
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        raise TranscriptionError("GROQ_API_KEY is not set.")

    audio = download_audio(url)
    try:
        with open(audio, "rb") as f:
            resp = requests.post(
                GROQ_URL,
                headers={"Authorization": f"Bearer {key}"},
                files={"file": (audio.name, f)},
                data={
                    "model": MODEL,
                    "response_format": "verbose_json",
                    "timestamp_granularities[]": "word",
                },
                timeout=300,
            )
    finally:
        _cleanup_dir(audio.parent)

    if resp.status_code != 200:
        raise TranscriptionError(
            f"Groq transcription failed (HTTP {resp.status_code}): {resp.text[:300]}"
        )

    data = resp.json()
    words = data.get("words") or []
    out = []
    for w in words:
        try:
            start = float(w.get("start", 0.0))
            end = float(w.get("end", start))
        except (TypeError, ValueError):
            continue
        text = (w.get("word") or w.get("text") or "").strip()
        if not text:
            continue
        out.append({"start": round(start, 3), "end": round(end, 3), "text": text})
    if not out:
        raise TranscriptionError("Transcription returned no words.")
    return out
