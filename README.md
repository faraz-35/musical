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

1. Load it. Two options:
   - **Temporary** (vanishes on restart): `about:debugging#/runtime/this-firefox` →
     "Load Temporary Add-on..." → select `extension/manifest.json`.
   - **Persistent** (survives restart + auto-updates): see below.
2. Open a YouTube song, click the **🎵 musical** button (bottom-right).

### Persistent install (signed + auto-updating)

Firefox Release won't keep an unsigned add-on across restarts, so the temporary
load disappears each session. This path gets you a **self-distributed signed**
XPI that installs permanently and **auto-updates** from a public GitHub repo.

One-time setup:

1. Create AMO API credentials: <https://addons.mozilla.org/developers/> →
   **API Keys** → generate a key/secret pair.
2. Put them in `.env`:
   ```
   WEB_EXT_API_KEY=user:your_jwt_issuer
   WEB_EXT_API_SECRET=your_jwt_secret
   ```
3. Auth `gh` (done already if `gh auth status` shows your account).

First release + install:

```
npm run release
```

This signs via AMO (unlisted), pushes `updates.json` to the repo, and publishes
the signed XPI to a GitHub Release. Then install it once, manually:

`about:addons` → gear → **Install Add-on From File** → pick the `.xpi` from
`web-ext-artifacts/`. It now sticks across restarts, and its `update_url` points
at the hosted manifest — future versions arrive automatically.

Shipping an update:

1. Bump `version` in `extension/manifest.json` (AMO rejects duplicate versions).
2. `npm run release`. Installed copies upgrade within ~a day, or immediately via
   `about:addons` → gear → **Check for Updates**.

(The repo must be public: Firefox fetches the update manifest/XPI
unauthenticated, and the XPI is the source zipped anyway. No secrets are in the
repo — `backend/.env` and `.env` are gitignored; keys load via `os.environ`.)

Other commands: `npm run lint` (excludes the dev-only `make_icons.py`),
`npm run build`, `npm run sign`.

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
