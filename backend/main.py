from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import align
import cache
import lyrics
import transcribe
import translate
import youtube


def _friendly_process_error(e: Exception) -> HTTPException:
    """Map a raw yt-dlp / requests / translate exception from the /process
    pipeline to a user-facing message + status. The extension surfaces
    `detail` verbatim in its status toast, so these strings are what the user
    reads. Keep them short and actionable."""
    msg = str(e)
    # yt-dlp rate-limit: YouTube 429'd us for rapid re-requests.
    if "rate-limit" in msg or "rate limit" in msg:
        return HTTPException(
            status_code=429,
            detail="YouTube rate-limited this request (too many in a row). "
            "Wait ~an hour and try again.",
        )
    # yt-dlp: video gone/private/region-blocked.
    if "is not available" in msg or "not available" in msg.lower():
        return HTTPException(
            status_code=404,
            detail="That video isn't available (private, removed, or region-blocked).",
        )
    # Z.ai translation timed out (requests.exceptions.ReadTimeout / ConnectTimeout).
    if "timed out" in msg.lower():
        return HTTPException(
            status_code=504,
            detail="The translation API timed out. Try again in a moment.",
        )
    # Translation network error more generally.
    if "connection" in msg.lower() or "max retries" in msg.lower():
        return HTTPException(
            status_code=502,
            detail="Couldn't reach the translation service. Check your connection.",
        )
    # Fallback: surface the exception class so it's at least identifiable.
    return HTTPException(
        status_code=500, detail=f"Processing failed: {type(e).__name__}."
    )

load_dotenv()
cache.init()

app = FastAPI(title="musical")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

DEFAULT_LINE_GAP = 4.0


class ProcessRequest(BaseModel):
    url: str


class ResyncRequest(BaseModel):
    videoId: str


def build_record(meta, lrc_text):
    parsed = lyrics.parse_lrc(lrc_text)
    if not parsed:
        raise ValueError("No timed lines could be parsed from the lyrics.")

    items = [{"i": idx, "text": p["text"]} for idx, p in enumerate(parsed)]
    translations = translate.translate_lines(items)

    n = len(parsed)
    lines = []
    for idx, p in enumerate(parsed):
        end = parsed[idx + 1]["start"] if idx + 1 < n else p["start"] + DEFAULT_LINE_GAP
        t = translations.get(idx, {"romanized": None, "direct": "", "meaning": ""})
        lines.append(
            {
                "start": round(p["start"], 3),
                "end": round(end, 3),
                "original": p["text"],
                "romanized": t["romanized"],
                "translation_direct": t["direct"],
                "meaning": t["meaning"],
            }
        )

    return {
        "videoId": meta["videoId"],
        "title": meta.get("title"),
        "artist": meta.get("artist"),
        "lang": None,
        "source": "lrc",
        "url": meta.get("url"),
        "lines": lines,
    }


def build_record_from_transcription(meta):
    """Slice 2 path: no synced lyrics, so the audio itself provides both the
    lyric text and the per-line timing via Groq Whisper.

    Word-level timestamps from Whisper are grouped into lines on pauses: a gap
    of >= SPLIT_GAP seconds between words ends a line. The grouped text is then
    translated by GLM-4.6 like any other lyric.
    """
    SPLIT_GAP = 1.5
    words = transcribe.transcribe(meta["url"])

    # Group words into lines on inter-word gaps.
    line_texts = []
    cur = []
    last_end = None
    for w in words:
        if last_end is not None and w["start"] - last_end >= SPLIT_GAP and cur:
            line_texts.append(" ".join(cur))
            cur = []
        cur.append(w["text"])
        last_end = w["end"]
    if cur:
        line_texts.append(" ".join(cur))

    if not line_texts:
        raise HTTPException(
            status_code=422, detail="Transcription produced no usable lines."
        )

    items = [{"i": idx, "text": t} for idx, t in enumerate(line_texts)]
    translations = translate.translate_lines(items)

    n = len(words)
    lines = []
    wi = 0  # running index into the flat word list
    prev_end = None
    for idx, text in enumerate(line_texts):
        tokens = text.split()
        start = words[wi]["start"]
        end = words[min(wi + len(tokens) - 1, n - 1)]["end"]
        wi += len(tokens)
        # Mirror align._enforce_monotonic: Whisper occasionally returns a word
        # whose end <= start (degenerate timestamp), and grouped lines inherit
        # that. Force a usable, monotonic span so the overlay never sees a
        # backwards/empty line. (The /resync path gets this for free via align.)
        if end <= start:
            end = start + DEFAULT_LINE_GAP
        if prev_end is not None and start < prev_end:
            start = prev_end
            if end <= start:
                end = start + DEFAULT_LINE_GAP
        t = translations.get(idx, {"romanized": None, "direct": "", "meaning": ""})
        lines.append(
            {
                "start": round(start, 3),
                "end": round(end, 3),
                "original": text,
                "romanized": t["romanized"],
                "translation_direct": t["direct"],
                "meaning": t["meaning"],
            }
        )
        prev_end = end

    return {
        "videoId": meta["videoId"],
        "title": meta.get("title"),
        "artist": meta.get("artist"),
        "lang": None,
        "source": "transcription",
        "url": meta.get("url"),
        "lines": lines,
    }


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/subtitles/{video_id}")
def get_subtitles(video_id: str):
    rec = cache.get(video_id)
    if not rec:
        raise HTTPException(
            status_code=404,
            detail="No cached subtitles for this video. POST /process first.",
        )
    return rec


@app.post("/process")
def process(req: ProcessRequest):
    video_id = youtube.extract_video_id(req.url)
    if not video_id:
        raise HTTPException(
            status_code=400, detail="Could not parse a YouTube video id from the url."
        )

    cached = cache.get(video_id)
    if cached:
        return cached

    url = f"https://www.youtube.com/watch?v={video_id}"
    try:
        meta = youtube.get_metadata(url)
        meta["videoId"] = video_id
        meta["url"] = url

        lrc = lyrics.search_synced(
            meta.get("artist"), meta.get("track"), meta.get("title") or ""
        )

        record = None
        if lrc:
            try:
                record = build_record(meta, lrc)
            except translate.InputTooLarge as e:
                raise HTTPException(status_code=413, detail=str(e))

        if record is None:
            # Slice 2 fallback: no synced lyrics — transcribe the audio.
            try:
                record = build_record_from_transcription(meta)
            except transcribe.TranscriptionError as e:
                raise HTTPException(status_code=502, detail=str(e))

    except HTTPException:
        raise
    except Exception as e:
        # yt-dlp (DownloadError), requests (ReadTimeout/ConnectionError), etc.
        raise _friendly_process_error(e)

    cache.put(record)
    return record


@app.post("/resync")
def resync(req: ResyncRequest):
    """Re-align a cached record's timing against the actual audio.

    Used by the extension's "Re-sync from audio" button when synced-lyric
    timestamps drift from the audio (common for live recordings). Re-transcribes
    the source audio via Groq and aligns the existing lyric texts to the fresh
    word timestamps, overwriting start/end while preserving the text and all
    translations.
    """
    rec = cache.get(req.videoId)
    if not rec:
        raise HTTPException(
            status_code=404,
            detail="No cached subtitles for this video. POST /process first.",
        )
    url = rec.get("url") or f"https://www.youtube.com/watch?v={req.videoId}"
    line_texts = [ln["original"] for ln in rec["lines"]]
    hints = [ln["start"] for ln in rec["lines"]]

    try:
        # Pass the trusted lyric text as Whisper's `prompt` so it transcribes in
        # the SAME script (e.g. Latin-romanized) as our lyrics. Otherwise Whisper
        # freely chooses Devanagari/Gurmukhi for Hindi/Punjabi audio and align.py
        # scores zero token overlap -> resync becomes a silent no-op.
        words = transcribe.transcribe(url, prompt=" ".join(line_texts))
    except transcribe.TranscriptionError as e:
        raise HTTPException(status_code=502, detail=str(e))

    spans = align.align_lines(line_texts, words, hints=hints)
    for ln, span in zip(rec["lines"], spans):
        ln["start"] = span["start"]
        ln["end"] = span["end"]

    cache.put(rec)
    return rec
