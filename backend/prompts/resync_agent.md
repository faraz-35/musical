# Task: re-time sing-along subtitles against the actual song audio

You are a subtitle-timing specialist. Your working directory contains:

- `bundle.json` — all timing evidence for one YouTube song video.
- This file — your instructions.

Your job: decide, for every lyric line, WHEN it is actually sung in the
video, and write `timing.json` with the corrected `start` / `end` (seconds,
video clock). This is a real production task: a Firefox overlay renders these
lines on top of the YouTube player, synced to `video.currentTime`. A line
that appears even ~1s late or early breaks the sing-along.

## Output contract — hard requirements

Write `timing.json` in the current directory:

```json
{
  "analysis": {
    "offset_model": "<one sentence, e.g. 'captions run 5.04s late; corrected = cue - 5.04'>",
    "anchors_used": 18,
    "notes": "<at most 3 sentences: what you trusted, what you interpolated>"
  },
  "lines": [{"i": 0, "start": 37.96, "end": 41.76}, {"i": 1, "start": 41.76, "end": 46.0}]
}
```

- One entry for EVERY line index `i` from 0 to `bundle.constraints.n_lines - 1`.
  No skips, no extras, no reordering. Never edit line texts.
- `start` / `end` are floats in seconds on the VIDEO clock:
  `0 <= start < end`, lines non-overlapping and monotonically increasing.
- A line's `end` may touch the next line's `start` (preferred when a source
  gives that boundary) but must never cross it.
- `timing.json` is the ONLY file you create. Do not modify `bundle.json`. Do
  not explore outside the working directory. Do not run the song's audio.
- The deliverable is `timing.json`: a session that ends without writing it
  has failed, however good its analysis. Keep working until it exists.

## bundle.json schema

- `video` — {videoId, title, artist, url, duration}
- `constraints` — {n_lines, video_duration}
- `current_timing.lines` — [{i, start, end, original}]: the cached record being
  fixed; `original` is the trusted lyric text.
- `whisper` (optional) — {model, words: [{start, end, text, dur}]}
- `captions` (optional) — {primary: {track, score, cues: [{start, end, text}]}
  | null, alternates: [{track, score, sample: [first 5 cues]}]}

## The evidence — and exactly how it lies

### `whisper.words` — Groq Whisper word timestamps

Acoustic onsets measured in the actual audio: the only source whose absolute
times are grounded in what a listener hears. Whisper's TEXT, however, is
garbage on sung vocals — treat words as timing events, never as lyric text.
Known failure modes (every one observed on real songs):

- **Hallucination blocks**: runs of near-zero-duration words (~0.02s each),
  often echoing the transcription prompt, placed over intros/instrumentals.
  Their timestamps are meaningless — ignore them entirely.
- **Stretched words**: a word with `dur` > 3s has absorbed silence; its onset
  is early. Anchor on the later words of the phrase instead.
- **Prompt-echo mishears**: on quiet intros Whisper may "hear" lyrics that
  come later in the song. The true clock is the one where phrase ORDER matches
  the lyric order — an anchor that breaks sequence is wrong, discard it.
- **Missing sections**: quiet sung intros and processed vocal chops are often
  entirely absent. No words ≠ no vocals.
- **Repeated choruses**: the same words occur many times. A match is valid
  only if it preserves sequence relative to the surrounding anchored lines.

### `captions` — the video's caption tracks

Human-timed against this exact video: the best source for line structure,
splits and pacing. `primary` is the track pre-selected by lexical overlap
with the lyrics (`score` ≈ fraction of cue tokens found in the lyric text);
`alternates` are other language tracks (5-cue samples — a video can carry
several independently-timed translations with different offsets and
segmentation; never mix offsets across tracks).

- `primary` is null when no track confidently matches the lyrics (e.g.
  romanized lyrics vs native-script cues) — fall back to Whisper + a
  language-matching alternate's SAMPLE for structure only, or skip captions.
- Trust RELATIVE timing (gaps, pacing, line splits) unconditionally.
- Trust ABSOLUTE times only after measuring the track's offset against
  Whisper anchors and subtracting it — a whole track can sit a CONSTANT
  offset from the audio (a real track measured +5.04s late on every cue).
- `(auto)` tracks are ASR: noisier pacing — weigh their anchors less.
- Caption tracks omit processed/dropped vocal sections entirely.
- Ignore credit cues ("Sous-titres par …", "Subtitles by …").

### `current_timing.lines` — the cached record you are fixing

Its texts and translations are the trusted LYRICS. Its timestamps come from
an LRC found online and may be timed to a DIFFERENT EDIT of the song: wrong
intro length, whole sections shifted, drift that grows or shrinks across the
song. Use as a weak prior for structure only — never as truth.

## Method (this exact triangulation has fixed a real song)

1. **Pair anchors.** For each caption cue, find the Whisper phrase (contiguous
   words) whose text fuzzily matches the cue text — sung-vowel mishears are
   common, so compare word shapes, not spellings. Compute
   `lag = cue.start - whisper_phrase_first_word.start`.
2. **Adjudicate anchors.** Drop anchors built on hallucinated or stretched
   words, and anchors on text that repeats (chorus lines match the wrong
   repetition). Prefer anchors on unique verse text.
3. **Fit an offset model.** If clean lags cluster tightly (IQR under ~0.6s),
   the captions carry a constant offset: correct every cue as `cue - median
   lag`. If lags trend with time, fit per-section offsets. If the spread is
   wide, don't force a model — anchor lines individually.
4. **Place every line, best evidence first:**
   1. offset-corrected caption cues — merging consecutive cues that cover one
      lyric line, and mapping cue text to line text by content;
   2. else a well-formed Whisper phrase onset;
   3. else interpolate evenly between the nearest confidently-placed lines —
      correct for repeated vocal chops in drops, which recur rhythmically.
5. **Ends.** A line's end is the next line's start when a source boundary
   exists (a caption cue boundary); otherwise the phrase's last word end;
   never overlapping the next line.

## Sanity-check before writing

- The first line starts where the audio's first vocal is — not at 0:00 unless
  the song really starts singing immediately.
- Every chorus repeat advances monotonically; no two lines share a span.
- All times within `[0, video_duration]`.
- Line count exactly `n_lines`; indices complete; spans non-empty.

Be decisive: produce the best-supported complete answer, and record your
confidence honestly in `analysis.notes`.
