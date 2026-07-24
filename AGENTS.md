# AGENTS.md

Guidance for AI agents working on **musical** — a local tool that adds
sing-along English subtitles to YouTube songs (Persian / Arabic /
French / etc.).

## What it is

A Python backend pre-processes a song once (fetches synced lyrics, translates
them via Z.ai **GLM-4.6** into a romanized line + a direct translation + a
plain-English meaning), caches the result, and a Firefox extension overlays the
three timed lines on the YouTube player. Process-once, replay-forever.

## Architecture

```
backend/    FastAPI service (Python 3.13, venv at backend/.venv)
  youtube.py     yt-dlp metadata extraction (single video only)
  lyrics.py      syncedlyrics LRC lookup + LRC parser
  translate.py   GLM-4.6 batched translation (romanized + direct + meaning)
  cache.py       SQLite cache keyed by videoId
  main.py        FastAPI app: /health, /process, /subtitles/{videoId}, /resync
  transcribe.py  Groq Whisper transcription: download_audio + transcribe (word-level)
  align.py       forced alignment of known lyric lines to Whisper word timestamps

extension/  Firefox MV3
  manifest.json  content script + background script
  content.js     overlay rendering + trigger button, syncs to <video> timeupdate;
                 per-line timing editor (global + per-line nudge);
                 "Re-sync from audio" button (re-transcribes via Groq)
  background.js  performs the backend fetch (NOT the content script — see gotchas)
  overlay.css    subtitle + sync-panel styling
```

Pipeline: `YouTube URL → yt-dlp metadata → syncedlyrics LRC → GLM-4.6 translation → SQLite cache → extension overlay`.

When synced lyrics are missing (Slice 2 fallback): `YouTube URL → yt-dlp metadata → Groq Whisper transcription (word-level) → line grouping on pauses → GLM-4.6 translation → SQLite cache`.

## Commands

All backend commands run from `backend/` with the venv:

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn main:app --port 8765          # run the server
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
curl -s -X POST http://localhost:8765/process -H 'Content-Type: application/json' -d '{"url":"https://www.youtube.com/watch?v=<ID>"}'
```

Backend runtime errors (tracebacks) are written to `backend/musical.log` (gitignored).

## Decisions / conventions

- **Translation model is GLM-4.6 only.** Do NOT fall back to the free Flash
  models — the user explicitly wants GLM-4.6 quality.
- **Three subtitle fields**, all shown on screen: `romanized` (phonetic
  sing-along guide, `null` when the original is English), `translation_direct`
  (literal), and `meaning` (plain-English paraphrase that strips metaphor,
  idiom and cultural references down to the underlying sentiment). There is no
  separate "poetic / romantic" line — `meaning` replaces that role.
- **Romanization is phonetic, sing-along-friendly** in the Latin alphabet,
  aimed at an English speaker. It is NOT a transliteration-only step: Latin-script
  non-English languages (French, Spanish, …) are romanized for pronunciation too
  (e.g. "Je t'aime" → "zhuh tem"). Only English lines skip it (`romanized: null`).
- **Explicit trigger only**: the extension generates subtitles when the user
  clicks the 🎵 button. Do not add auto-processing on page load.
- **Local-only**: no cloud mirror. Cache lives in SQLite (backend) +
  `browser.storage.local` (extension).
- **Transcription is timing-only, never trusted text.** When no synced LRC
  exists (Slice 2 fallback), Groq Whisper provides both the lyric text and the
  timing. But for the **re-sync** path (`/resync`), Whisper is used ONLY for
  timing — the trusted LRC text and GLM translations are preserved, and
  `align.py` re-pins their `start`/`end` to fresh word timestamps. This matters
  because Whisper transcribes sung Persian/Arabic poorly and often emits
  "موسیقی" (music) placeholders for instrumentals; we never want that text.
- **Forced alignment carries drift forward.** `align.align_lines` takes the
  existing per-line start times as *hints* but tracks a running offset: when a
  line is confidently matched, its `matched_start - hint` is smoothed into a
  drift estimate that shifts the next line's search window. This lets it track
  whole-song shifts (e.g. a live recording lagging the studio LRC by ~80s)
  while tolerating per-line wobble and skipping intro narration / instrumental
  breaks. Scoring rewards token coverage (prefix-tolerant for Whisper's phonetic
  near-misses) and penalizes window length, with a coverage threshold that
  guards against matching noise.
- **Subtitle timing** (extension-only): synced lyrics are often out of step
  with the YouTube audio. The ⚙ sync panel exposes both a **global offset**
  (shifts every line) and **per-line start/end nudging** (fixes drift or a
  mistimed line). All edits are **non-destructive** — original LRC timestamps
  in the record are never modified; the render path computes effective time as
  `original + global + perLineDelta` (see `effectiveStart`/`effectiveEnd` in
  `content.js`). Persisted under a **separate** key, `musical:sync:<videoId>`,
  as an object `{ global: <number>, lines: [{ s, e }, ...] }`, so it survives
  re-processing (which overwrites the subtitle record) and cache version wipes.
  The loader (`normalizeSyncData`) migrates the legacy bare-number format
  (treated as `global`) and pads `lines` to match the record. Not synced to the
  backend. **Re-sync from audio clears these deltas** — since it rebuilds base
  timings from the audio, old manual offsets are meaningless.
- **Cache schema is versioned.** `cache.CACHE_VERSION` is bumped whenever the
  record shape changes; `cache.init()` DROPs and recreates the table under an
  older version (a plain `DELETE` left stale column sets in place, so new
  columns like `url` never appeared). Extension-side `browser.storage.local`
  is not versioned — old records there simply won't render the new fields, so
  the user should click 🎵 again after a schema change.
- **The record stores its source `url`** so `/resync` can re-download the audio
  without the extension re-sending it.
- Cache record shape (shared contract between backend and extension):
  ```json
  { "videoId": "...", "title": "...", "artist": "...", "lang": null,
    "source": "lrc" | "transcription", "url": "https://www.youtube.com/watch?v=...",
    "lines": [ { "start": 12.5, "end": 16.0, "original": "...",
                 "romanized": "...", "translation_direct": "...", "meaning": "..." } ] }
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
5. **Audio download must use a fresh temp path + `%(id)s.%(ext)s`.** Pre-creating
   a temp file makes yt-dlp skip it ("already downloaded"), and forcing an
   `.m4a` extension clashes when it selects an opus/webm format. Use a temp
   *directory* with the `%(id)s.%(ext)s` template (see `transcribe.download_audio`).
6. **YouTube rate-limits rapid re-downloads** with transient 403s. A single
   download per song is fine; back-to-back test runs against the same video may
   fail. `transcribe.transcribe` cleans up its temp dir on any path (success or
   failure).
7. **Whisper labels sung audio as "موسیقی" (music).** Whisper-large-v3 is a
   speech model: it treats vocals-with-instrumentation as non-speech and emits
   "music"/"موسیقی" placeholders instead of transcribing. This is why the
  re-sync path uses transcription for TIMING ONLY and never trusts its text
  (see `align.py`).

## Status

- Slice 1 (done): metadata, synced-lyrics lookup, GLM-4.6 translation, SQLite
  cache, Firefox overlay.
- Slice 2 (done): `transcribe.py` — Groq Whisper transcription fallback when no
  synced lyrics exist, plus `align.py` forced alignment + `/resync` endpoint
  for the "Re-sync from audio" button.
- Later: styling polish, per-language translation prompts, a toggle to hide
  the romanized or meaning lines.
