from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import traceback

import cache
import lyrics
import translate
import youtube

load_dotenv()
cache.init()

LOG_PATH = Path(__file__).parent / "musical.log"

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
        t = translations.get(idx, {"direct": "", "romantic": ""})
        lines.append(
            {
                "start": round(p["start"], 3),
                "end": round(end, 3),
                "original": p["text"],
                "translation_direct": t["direct"],
                "translation_romantic": t["romantic"],
            }
        )

    return {
        "videoId": meta["videoId"],
        "title": meta.get("title"),
        "artist": meta.get("artist"),
        "lang": None,
        "source": "lrc",
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

    try:
        meta = youtube.get_metadata(req.url)
        meta["videoId"] = video_id

        lrc = lyrics.search_synced(
            meta.get("artist"), meta.get("track"), meta.get("title") or ""
        )

        if not lrc:
            import transcribe

            try:
                transcribe.transcribe(req.url)
            except NotImplementedError as e:
                raise HTTPException(status_code=404, detail=str(e))
            raise HTTPException(
                status_code=500, detail="Transcription path is not wired yet (Slice 2)."
            )

        record = build_record(meta, lrc)
    except HTTPException:
        raise
    except Exception as e:
        with open(LOG_PATH, "a") as f:
            f.write(traceback.format_exc() + "\n")
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")

    cache.put(record)
    return record
