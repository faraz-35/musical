from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import align
import agent_resync
import cache
import captions
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

# Written into every record the API returns so the extension can tell the
# current contract from stale copies lingering in browser.storage.local (which
# is not versioned). Stamped at the API boundary rather than stored: the cache
# persists only the lines array, and a schema bump would needlessly wipe it.
# v2 = verse-length line grouping + this marker itself.
RECORD_VERSION = 2


def _with_v(rec):
    rec["v"] = RECORD_VERSION
    return rec


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


# Transcription line grouping. A pause split alone is not enough: sung audio
# rarely pauses >= SPLIT_GAP_S between phrases, so words chain into one cue
# holding a whole verse (observed: an entire song in a single 106s cue) and
# the overlay shows a paragraph. Lines are therefore also capped by word count
# and span, and an over-cap line splits at its largest internal inter-word
# gap — the closest thing to a phrase boundary.
SPLIT_GAP_S = 1.5
MAX_LINE_WORDS = 12
MAX_LINE_DUR_S = 8.0


def group_words_into_lines(words):
    """Group Whisper word dicts ({text, start, end}) into verse-length lines.

    Returns a list of line texts, in word order. A line ends at a pause of
    >= SPLIT_GAP_S; a line that would grow past MAX_LINE_WORDS or
    MAX_LINE_DUR_S splits at its largest internal gap instead.
    """
    lines = []
    cur = []

    def emit_through(i):
        # Close a line from cur[0..i]; the rest stays as the working line.
        lines.append(" ".join(w["text"] for w in cur[: i + 1]))
        del cur[: i + 1]

    for w in words:
        if cur and w["start"] - cur[-1]["end"] >= SPLIT_GAP_S:
            emit_through(len(cur) - 1)
        cur.append(w)
        if len(cur) < MAX_LINE_WORDS and w["end"] - cur[0]["start"] <= MAX_LINE_DUR_S:
            continue
        # Over cap: split at the most phrase-like internal gap — the largest,
        # nudged toward the middle so an evenly-sung run (flat gaps) splits
        # into even halves instead of at an arbitrary edge.
        n = len(cur)
        best_i, best_score = 0, None
        for i in range(n - 1):
            gap = cur[i + 1]["start"] - cur[i]["end"]
            score = gap - 0.5 * abs((i + 1) / n - 0.5)
            if best_score is None or score > best_score:
                best_i, best_score = i, score
        emit_through(best_i)
    if cur:
        emit_through(len(cur) - 1)
    return lines


def build_record_from_transcription(meta):
    """Slice 2 path: no synced lyrics, so the audio itself provides both the
    lyric text and the per-line timing via Groq Whisper.

    Word-level timestamps from Whisper are grouped into verse-length lines by
    group_words_into_lines (pause splits + word/span caps). The grouped text is
    then translated by GLM like any other lyric.
    """
    words = transcribe.transcribe(meta["url"])
    line_texts = group_words_into_lines(words)

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
    return _with_v(rec)


@app.post("/process")
def process(req: ProcessRequest):
    video_id = youtube.extract_video_id(req.url)
    if not video_id:
        raise HTTPException(
            status_code=400, detail="Could not parse a YouTube video id from the url."
        )

    cached = cache.get(video_id)
    if cached:
        return _with_v(cached)

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
    return _with_v(record)


@app.post("/resync")
def resync(req: ResyncRequest):
    """Re-align a cached record's timing against the actual audio.

    Used by the extension's "Re-sync from audio" button when synced-lyric
    timestamps drift from the audio (common for music videos whose LRC was
    timed to a different edit). Two paths, best-evidence-first:

      1. Agentic (when the opencode CLI is installed): gather every timing
         source — fresh Groq Whisper words, the video's caption track, and the
         cached lines — into an evidence bundle and let an LLM agent
         adjudicate them (e.g. measuring a constant caption offset against
         acoustic anchors). See prompts/resync_agent.md. Its timing.json is
         validated + monotonicity-repaired before use.
      2. Algorithmic fallback (align.align_lines) — also used whenever the
         agent is unavailable, times out, or returns output that fails
         validation, and when only Whisper evidence exists.

    Both paths overwrite start/end only; lyric text and translations are never
    touched (transcription/caption text is timing evidence, never trusted).
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

    # --- gather evidence; every source is optional except where noted ------
    words = None
    words_error = None
    try:
        # Pass the trusted lyric text as Whisper's `prompt` so it transcribes in
        # the SAME script (e.g. Latin-romanized) as our lyrics. Otherwise Whisper
        # freely chooses Devanagari/Gurmukhi for Hindi/Punjabi audio and align.py
        # scores zero token overlap -> resync becomes a silent no-op.
        words = transcribe.transcribe(url, prompt=" ".join(line_texts))
    except transcribe.TranscriptionError as e:
        words_error = e
        print(f"[musical] resync: transcription failed: {e}", flush=True)

    caps = None
    try:
        caps = captions.fetch_best(url, line_texts)
        if caps:
            primary = caps["primary"]
            print(
                "[musical] resync: captions: "
                + (
                    f"primary {primary['track']} score={primary['score']} "
                    f"({len(primary['cues'])} cues)"
                    if primary
                    else "no lyric-matching track"
                )
                + f"; {len(caps['alternates'])} tracks total",
                flush=True,
            )
    except captions.CaptionError as e:
        print(f"[musical] resync: captions unavailable: {e}", flush=True)

    duration = None
    try:
        duration = youtube.get_metadata(url).get("duration")
    except Exception as e:
        print(f"[musical] resync: metadata unavailable: {e}", flush=True)

    # --- agentic path: propose timings, then validate ----------------------
    spans = None
    if words is not None or caps is not None:
        bundle = agent_resync.build_bundle(
            rec, words=words, captions=caps, duration=duration
        )
        output = agent_resync.run_agent(bundle)
        spans = agent_resync.validated_spans(output, len(rec["lines"]), duration)
        if spans is not None:
            print(
                f"[musical] resync: applied agentic timing ({len(spans)} lines)",
                flush=True,
            )

    # --- deterministic fallback (needs Whisper words) ----------------------
    if spans is None:
        if words is None:
            raise HTTPException(status_code=502, detail=str(words_error))
        spans = agent_resync.clamp_spans(
            align.align_lines(line_texts, words, hints=hints), duration
        )
        print("[musical] resync: applied algorithmic alignment", flush=True)

    for ln, span in zip(rec["lines"], spans):
        ln["start"] = span["start"]
        ln["end"] = span["end"]

    cache.put(rec)
    return _with_v(rec)
