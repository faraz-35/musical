"""Whisper fallback transcription (Slice 2).

When synced lyrics are unavailable, this will:
  1. Download audio via yt-dlp as 16kHz mono wav.
  2. Run faster-whisper (large-v3) with word_timestamps=True.
  3. Return a list of {"start": float, "end": float, "text": str}.
"""


def transcribe(url, on_log=None):
    raise NotImplementedError(
        "Transcription fallback is Slice 2 (not implemented yet). "
        "No synced lyrics were found for this video."
    )
