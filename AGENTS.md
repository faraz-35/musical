# AGENTS.md

Guidance for AI agents working on **musical** — a local tool that adds
custom romanticized English subtitles to YouTube songs (Persian / Arabic /
French / etc.).

## What it is

A Python backend pre-processes a song once (fetches synced lyrics, translates
them via Z.ai **GLM-4.6** into a direct + a poetic English translation), caches
the result, and a Firefox extension overlays the two timed lines on the YouTube
player. Process-once, replay-forever.

## Architecture

```
backend/    FastAPI service (Python 3.13, venv at backend/.venv)
  youtube.py     yt-dlp metadata extraction (single video only)
  lyrics.py      syncedlyrics LRC lookup + LRC parser
  translate.py   GLM-4.6 batched translation (direct + romanticized)
  cache.py       SQLite cache keyed by videoId
  main.py        FastAPI app: /health, /process, /subtitles/{videoId}
  transcribe.py  Whisper fallback (Slice 2 — currently a NotImplementedError stub)

extension/  Firefox MV3
  manifest.json  content script + background script
  content.js     overlay rendering + trigger button, syncs to <video> timeupdate
  background.js  performs the backend fetch (NOT the content script — see gotchas)
  overlay.css    subtitle styling
```

Pipeline: `YouTube URL → yt-dlp metadata → syncedlyrics LRC → GLM-4.6 translation → SQLite cache → extension overlay`.

## Commands

All backend commands run from `backend/` with the venv:

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn main:app --port 8000          # run the server
```

Load the extension: Firefox → `about:debugging#/runtime/this-firefox` →
"Load Temporary Add-on..." → select `extension/manifest.json`.

## Verification (there is no test suite / linter yet)

Verify changes manually from `backend/`:

```bash
# 1. imports still resolve
.venv/bin/python -c "import main; print('ok')"

# 2. LRC parser sanity
.venv/bin/python -c "import lyrics; print(len(lyrics.parse_lrc('[00:01.00]hi\n[00:03.50]bye')))"

# 3. full pipeline for a real song (needs ZAI_API_KEY in .env, costs ~$0.02)
.venv/bin/python -c "from dotenv import load_dotenv; load_dotenv(); import youtube,lyrics,translate as t; \
m=youtube.get_metadata('https://www.youtube.com/watch?v=<ID>'); \
p=lyrics.parse_lrc(lyrics.search_synced(m.get('artist'),m.get('track'),m.get('title') or '')); \
print(len(p), 'lines')"

# 4. live HTTP path + populates cache
curl -s -X POST http://localhost:8000/process -H 'Content-Type: application/json' -d '{"url":"https://www.youtube.com/watch?v=<ID>"}'
```

Backend runtime errors (tracebacks) are written to `backend/musical.log` (gitignored).

## Decisions / conventions

- **Translation model is GLM-4.6 only.** Do NOT fall back to the free Flash
  models — the user explicitly wants GLM-4.6 quality.
- **Two subtitle fields**, both shown on screen: `translation_direct`
  (literal) and `translation_romantic` (poetic). The "meaning note" field is
  deferred — don't add it without asking.
- **Explicit trigger only**: the extension generates subtitles when the user
  clicks the 🎵 button. Do not add auto-processing on page load.
- **Local-only**: no cloud mirror. Cache lives in SQLite (backend) +
  `browser.storage.local` (extension).
- Cache record shape (shared contract between backend and extension):
  ```json
  { "videoId": "...", "title": "...", "artist": "...", "lang": null, "source": "lrc",
    "lines": [ { "start": 12.5, "end": 16.0, "original": "...",
                 "translation_direct": "...", "translation_romantic": "..." } ] }
  ```

## Critical gotchas (do not regress on these)

1. **YouTube CSP blocks content-script fetches.** All backend calls MUST go
   through `background.js` (which is not bound by the page CSP), with the
   content script using Promise-based `runtime.sendMessage`. Do not move the
   `fetch` back into `content.js`.
2. **yt-dlp + `&list=` URLs.** Always use `noplaylist: True` and a canonical
   `watch?v=<id>` URL (see `youtube.get_metadata`). The radio-mix playlist
   otherwise makes yt-dlp extract the entire mix and YouTube rate-limits the
   IP for ~an hour.
3. **Extension reload order.** After editing extension files: Reload in
   `about:debugging`, THEN reload the YouTube tab — otherwise the content
   script is orphaned from the new background ("receiving end does not exist").
   `content.js` already retries on that error.
4. **RTL / non-Latin lyrics.** syncedlyrics coverage is strong for French /
   Western and spottier for Persian / Arabic — those misses are what Slice 2
  (Whisper) is meant to cover.

## Status

- Slice 1 (done): metadata, synced-lyrics lookup, GLM-4.6 translation, SQLite
  cache, Firefox overlay.
- Slice 2 (pending): `transcribe.py` — `faster-whisper` fallback when no synced
  lyrics exist.
- Later: meaning-note toggle, styling polish, per-language translation prompts.
