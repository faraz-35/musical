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
  content.js     overlay rendering; injects a native action-bar pill (🎵/⚙);
                 syncs to <video> timeupdate; per-line timing editor (global +
                 per-line nudge); "Re-sync from audio" button (Groq)
  background.js  performs the backend fetch (NOT the content script — see gotchas)
  overlay.css    subtitle + sync-panel styling; injected-pill state overrides
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

Requires **`deno`** on PATH (`brew install deno`) — yt-dlp needs a JS runtime
for YouTube extraction (see gotcha #9). `requirements.txt` pins
`yt-dlp[default]`, which pulls the `yt-dlp-ejs` solver scripts.

`com.faraz.musical.plist` (checked in at repo root) runs the backend as a
**LaunchAgent** that starts at login and auto-restarts on crash/exit
(`KeepAlive`). It is symlinked into `~/Library/LaunchAgents/`. So in normal use
you do NOT need the uvicorn line above — the server is already up at
`http://127.0.0.1:8765`. Verify with `curl http://127.0.0.1:8765/health`.

```sh
launchctl load   ~/Library/LaunchAgents/com.faraz.musical.plist   # install/start
launchctl unload ~/Library/LaunchAgents/com.faraz.musical.plist   # stop + disable
tail -f logs/launchd.out.log logs/launchd.err.log                 # launchd's own log
```

Notes:
- It calls the venv uvicorn directly
  (`backend/.venv/bin/uvicorn`) with `WorkingDirectory=backend/`, because
  launchd starts processes with a near-empty PATH. `main:app` then resolves its
  sibling modules, and `load_dotenv()` (called with no path) searches upward
  from `WorkingDirectory=backend/`; since there is no `backend/.env`, it picks
  up the repo-root `.env` where `ZAI_API_KEY` / `GROQ_API_KEY` live.
- `PATH` is set explicitly to include `/opt/homebrew/bin`: yt-dlp (in
  `youtube.py` + `transcribe.py`) shells out to `ffmpeg`/`ffprobe` there for
  audio extraction.
- The `ThrottleInterval` (10s) guards against a tight restart loop if the
  server fails fast (e.g. port already taken). A manual
  `.venv/bin/uvicorn ...` run still works, but launchd will fight you for the
  port — unload first.

Load the extension: Firefox → `about:debugging#/runtime/this-firefox` →
"Load Temporary Add-on..." → select `extension/manifest.json`.

## Verification (there is no test suite / linter yet)

Verify changes manually from `backend/`:

```bash
# 1. imports still resolve
.venv/bin/python -c "import main; print('ok')"

# 2. LRC parser sanity
.venv/bin/python -c "import lyrics; print(len(lyrics.parse_lrc('[00:01.00]hi\n[00:03.50]bye')))"

# 3. full pipeline for a real song (needs ZAI_API_KEY in the repo-root .env, costs ~$0.02)
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
  clicks the musical pill in YouTube's action bar. Do not add auto-processing
  on page load.
- **The trigger is a native action-bar pill, not a floating button.**
  `injectActionBarButton` clones a real sibling action button (the last child
  of `#top-level-buttons-computed` / `#flexible-item-buttons`) and mutates its
  glyph + label. One element, two states set by `updateActionBtn`: idle (🎵,
  click → generate) and ready (⚙, click → open the sync panel). It cannot be
  dragged — it lives wherever YouTube puts the action bar. The dense sync
  panel stays a floating panel anchored top-right. The older floating/draggable
  🎵 + ⚙ buttons were removed; do not re-add them.
- **Local-only**: no cloud mirror. Cache lives in SQLite (backend) +
  `browser.storage.local` (extension).
- **Transcription is timing-only, never trusted text.** When no synced LRC
  exists (Slice 2 fallback), Groq Whisper provides both the lyric text and the
  timing. But for the **re-sync** path (`/resync`), Whisper is used ONLY for
  timing — the trusted LRC text and GLM translations are preserved, and
  `align.py` re-pins their `start`/`end` to fresh word timestamps. This matters
  because Whisper transcribes sung Persian/Arabic poorly and often emits
  "موسیقی" (music) placeholders for instrumentals; we never want that text.
- **`/resync` passes the lyric text as Whisper's `prompt`.** The cached lyrics
  are often Latin-romanized (e.g. `Rabb manneya tainu`), but left to itself
  Whisper transcribes Hindi/Punjabi audio in Devanagari/Gurmukhi (`रभ मन
  साहिबा`). Since `align.py` matches tokens as strings, the two scripts score
  **zero overlap** → zero confident anchors → interpolation has nothing to work
  from → resync silently becomes a no-op that keeps the stale LRC hints.
  Passing the trusted lyric text as Whisper's `prompt` steers the transcript
  into the SAME script/lexicon as the lyrics, giving the aligner real anchors.
  `main.py` passes `" ".join(line_texts)` (trimmed to 22 tokens inside
  `transcribe.transcribe`, Groq's documented prompt cap).
- **Forced alignment carries drift forward.** `align.align_lines` takes the
  existing per-line start times as *hints* but tracks a running offset: when a
  line is confidently matched, its `matched_start - hint` is smoothed into a
  drift estimate that shifts the next line's search window. This lets it track
  whole-song shifts (e.g. a live recording lagging the studio LRC by ~80s)
  while tolerating per-line wobble and skipping intro narration / instrumental
  breaks. Scoring rewards token coverage (prefix-tolerant for Whisper's phonetic
  near-misses) and penalizes window length, with a coverage threshold that
  guards against matching noise. The carried offset is **capped** (`OFFSET_MAX`)
  so a single spurious match can't blow up the search window for the rest of the
  song. The pipeline runs as **three passes** in `align_lines`:
  1. `_score_window` — raw per-line match against the word stream (the pass
     above). Unmatched lines fall back to the drift-adjusted hint.
  2. `_interpolate` — lines that missed coverage are re-placed **proportionally
     between the nearest surrounding confident matches (anchors)** instead of
     replaying their stale LRC hint. This is what recovers a whole-song shift
     for sung sections Whisper can't transcribe (it emits "موسیقی"/music
     placeholders there); without it most lines would silently keep their old,
     wrong timing and resync would look like a no-op.
  3. `_enforce_monotonic` — forces every line's `start >= prev.end` and dedupes
     exact-duplicate spans (a recurring chorus matched to the same words), so
     the overlay never receives overlapping/backwards lines.
  Never regress the monotonicity pass: an earlier bug shipped a record with 10
  overlapping lines and a 32s backwards jump, which broke the on-screen overlay.
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
8. **Action-bar pill must CLONE a real button, never build one.** YouTube's
   button look lives in build-specific, obfuscated BEM classes
   (`yt-spec-button-shape-next--*`) that change between releases. Building a
   `<button>` from scratch breaks on the next YouTube build. `injectActionBarButton`
   clones the last child of the action bar (`#top-level-buttons-computed` →
   `#flexible-item-buttons` → menu div fallback chain) and mutates its glyph +
   aria-label. The bar is recreated on every `yt-navigate-finish`, so
   `ensureActionBarButton` retries injection on a backoff. Stamp our injected
   node with `data-musical` so we can find/avoid duplicating it. If the bar
   ever fails to be found, the pill simply won't appear — the page otherwise
   works. (This is the same technique Return YouTube Dislike uses.)
9. **yt-dlp needs a JS runtime (Deno) + the `yt-dlp[default]` extra.** YouTube
   extraction now requires executing JS (nsig / player challenges). Without a
   runtime, every fetch fails with the misleading **"This video is not
   available"** — a generic message that masks the real cause. Fix:
   `requirements.txt` pins `yt-dlp[default]` (pulls `yt-dlp-ejs`, the solver
   scripts), and `brew install deno` provides the runtime — auto-detected by
   yt-dlp on PATH (the launchd plist's PATH includes `/opt/homebrew/bin`, so the
   launchd-run backend finds it too). Symptom that exposed this: subtitle
   generation returned nothing; `backend/musical.log` showed the yt-dlp
   `No supported JavaScript runtime could be found` warning.

## Status

- Slice 1 (done): metadata, synced-lyrics lookup, GLM-4.6 translation, SQLite
  cache, Firefox overlay.
- Slice 2 (done): `transcribe.py` — Groq Whisper transcription fallback when no
  synced lyrics exist, plus `align.py` forced alignment + `/resync` endpoint
  for the "Re-sync from audio" button.
- Later: styling polish, per-language translation prompts, a toggle to hide
  the romanized or meaning lines.
