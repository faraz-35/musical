# musical

Custom romanticized English subtitles for YouTube songs (Persian / Arabic / French / etc.).

A personal, local-only tool: a Python backend pre-processes a song once (fetches synced
lyrics, translates them via Z.ai GLM-4.6 into a direct + a poetic translation), caches the
result, and a Firefox extension overlays the timed subtitles on the YouTube player.

## Architecture

```
musical/
  backend/    FastAPI service (yt-dlp + syncedlyrics + GLM-4.6 + SQLite cache)
  extension/  Firefox MV3 content script (overlay + trigger button)
```

Data flow (process once, replay forever):

```
YouTube URL
  → yt-dlp pulls metadata (artist / track / duration)
  → syncedlyrics fetches synced LRC (LRCLib + Musixmatch + NetEase)
  → GLM-4.6 translates every line → {translation_direct, translation_romantic}
  → stored in SQLite (backend) + browser.storage.local (extension)
  → overlay renders the two timed English lines over the video
```

## Backend setup

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env          # then put your real key in .env
echo "ZAI_API_KEY=sk-..." > .env
.venv/bin/uvicorn main:app --port 8765
```

Requires `ffmpeg` on PATH (for the Slice 2 transcription path). Tested on macOS / Python 3.13.

## Extension setup (Firefox)

1. Go to `about:debugging#/runtime/this-firefox`
2. "Load Temporary Add-on..." → select `extension/manifest.json`
3. Open a YouTube song, click the **🎵 musical** button (bottom-right).

A temporary add-on is removed on Firefox restart. For a permanent install, package with
[`web-ext`](https://github.com/mozilla/web-ext) and load via Developer/nightly builds, or
sign it.

## Endpoints

| Method | Path                  | Purpose                                            |
|--------|-----------------------|----------------------------------------------------|
| GET    | `/health`             | Liveness check.                                    |
| POST   | `/process`            | `{url}` → fetch lyrics + translate, cache, return. |
| GET    | `/subtitles/{videoId}`| Return cached subtitles for a video.               |

Cached record shape:

```json
{
  "videoId": "abc",
  "title": "...", "artist": "...", "lang": null, "source": "lrc",
  "lines": [
    {"start": 12.5, "end": 16.0, "original": "...",
     "translation_direct": "...", "translation_romantic": "..."}
  ]
}
```

## Status — Slice 1

- ✅ Metadata via yt-dlp, synced lyrics via syncedlyrics, GLM-4.6 translation, SQLite cache, Firefox overlay.
- ⏭ Slice 2: `backend/transcribe.py` — `faster-whisper` fallback when no synced lyrics exist (stubbed).
- ⏭ Later: meaning-note toggle, styling polish, per-language translation prompts.

Costs are negligible (~$0.01–0.02 / song with GLM-4.6).

Note: depends on synced-lyrics coverage, which is strong for French/Western music and
spottier for Persian/Arabic — those misses are what Slice 2 transcription covers.
