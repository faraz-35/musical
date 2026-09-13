"""Agentic timing repair for /resync: an opencode CLI agent re-times a record.

Gathers everything needed to judge a song's timing (Whisper words, caption
cues, the cached lines) into an evidence bundle, runs a headless
`opencode run` in a scratch directory with prompts/resync_agent.md as the
agent's instructions, and reads back the timing.json it writes.

The agent NEVER touches the cache. Its output is validated and repaired here
(complete index set, finite times, align's monotonicity contract) before
/resync applies it; any failure returns None and the endpoint falls back to
the deterministic aligner. This "agent proposes, code disposes" split keeps
the overlay's guarantees (non-overlapping, monotonic, non-empty lines) no
matter what the model returns.

Why an agent at all: the deterministic aligner can't decide WHICH timing
source is lying — a caption track with a constant whole-track offset, an LRC
timed to a different edit, Whisper hallucination blocks — while a model
reading the raw evidence can. That triangulation (median caption lag vs
acoustic anchors) is what fixed a real song that the algorithmic path could
not. See prompts/resync_agent.md for the method the agent is told to follow.
"""

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import align

PROMPT_PATH = Path(__file__).parent / "prompts" / "resync_agent.md"

# The zai-coding-plan provider in opencode; override with OPENCODE_MODEL.
DEFAULT_MODEL = "zai-coding-plan/glm-5.3-flash"
# A full run (the agent pages through the bundle with its file tool, then
# does the anchor math and writes timing.json) took ~6.5 minutes; the timeout
# covers that with headroom. Earlier "hangs" were just this runtime exceeding
# shorter timeouts — opencode buffers its streamed events when piped.
RUN_TIMEOUT = float(os.environ.get("MUSICAL_AGENT_TIMEOUT", "480"))

# launchd's PATH is near-empty, so which() alone can miss the binary. Probe
# the official installer location and Homebrew directly.
_EXTRA_PATHS = (
    "~/.opencode/bin/opencode",
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
)


def find_opencode():
    """Locate the opencode binary, or None if it isn't installed."""
    found = shutil.which("opencode")
    if found:
        return found
    for p in _EXTRA_PATHS:
        expanded = os.path.expanduser(p)
        if os.access(expanded, os.X_OK):
            return expanded
    return None


def build_bundle(rec, words=None, captions=None, duration=None):
    """Assemble the evidence bundle — the schema prompts/resync_agent.md
    documents. Missing sources are simply omitted keys."""
    lines = [
        {
            "i": i,
            "start": ln["start"],
            "end": ln["end"],
            "original": ln["original"],
        }
        for i, ln in enumerate(rec["lines"])
    ]
    bundle = {
        "video": {
            "videoId": rec.get("videoId"),
            "title": rec.get("title"),
            "artist": rec.get("artist"),
            "url": rec.get("url"),
            "duration": duration,
        },
        "constraints": {"n_lines": len(lines), "video_duration": duration},
        "current_timing": {"source": rec.get("source"), "lines": lines},
    }
    if words:
        bundle["whisper"] = {
            "model": "whisper-large-v3 (Groq)",
            "words": [
                {
                    "start": w["start"],
                    "end": w["end"],
                    "text": w["text"],
                    "dur": round(w["end"] - w["start"], 3),
                }
                for w in words
            ],
        }
    if captions:
        bundle["captions"] = captions
    return bundle


def _run_once(binary, td, message, env):
    """One opencode attempt. Returns parsed timing.json dict or None."""
    td_path = Path(td)
    cmd = [binary, "run", "--dir", td, "--title", "musical timing resync"]
    model = os.environ.get("OPENCODE_MODEL", DEFAULT_MODEL)
    if model:
        cmd += ["--model", model]
    cmd += [message]

    try:
        proc = subprocess.run(
            cmd,
            cwd=td,
            env=env,
            capture_output=True,
            text=True,
            timeout=RUN_TIMEOUT,
        )
    except subprocess.TimeoutExpired as e:
        tail = e.stdout if isinstance(e.stdout, str) else ""
        print(
            f"[musical] agentic resync timed out after {RUN_TIMEOUT:.0f}s; "
            f"output tail: {tail[-1200:]}",
            flush=True,
        )
        return None
    except OSError as e:
        print(f"[musical] agentic resync failed to launch: {e}", flush=True)
        return None

    result = td_path / "timing.json"
    if proc.returncode != 0 or not result.exists():
        tail = (proc.stdout or "")[-1200:]
        print(
            f"[musical] agentic resync attempt produced no timing.json "
            f"(exit {proc.returncode}); output tail: {tail}",
            flush=True,
        )
        return None
    try:
        return json.loads(result.read_text(encoding="utf-8"))
    except ValueError as e:
        print(f"[musical] agentic resync timing.json invalid JSON: {e}", flush=True)
        return None


def run_agent(bundle):
    """Run the opencode agent over the bundle.

    Returns the parsed timing.json (a dict) on success, or None on any
    failure: missing binary, launch error, timeout, non-zero exit, missing
    file, or invalid JSON. Never raises.

    The full instruction sheet goes IN the startup message so the agent
    starts with complete expectations instead of orienting first — a model
    that has only just opened the task file occasionally answers
    descriptively and stops (`opencode run` ends on a text-only turn). The
    success criterion itself lives in the prompt; the single same-message
    retry just absorbs the residual stochastic abort.
    """
    binary = find_opencode()
    if not binary:
        print("[musical] agentic resync skipped: opencode not found", flush=True)
        return None

    instructions = PROMPT_PATH.read_text(encoding="utf-8")
    message = (
        instructions
        + "\n\nAGENT_TASK.md (these instructions) and bundle.json (the input "
        "data) are files in this directory. Begin."
    )

    # opencode needs HOME (auth/config) and a usable PATH; the launchd
    # environment provides HOME but a minimal PATH.
    env = dict(os.environ)
    env["PATH"] = env.get("PATH", "") + ":/opt/homebrew/bin:/usr/bin:/bin"

    with tempfile.TemporaryDirectory(prefix="musical-agent-") as td:
        td_path = Path(td)
        (td_path / "bundle.json").write_text(
            json.dumps(bundle, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        (td_path / "AGENT_TASK.md").write_text(instructions, encoding="utf-8")

        out = _run_once(binary, td, message, env)
        if out is None:
            print("[musical] agentic resync: retrying once", flush=True)
            out = _run_once(binary, td, message, env)
        if out is None:
            return None

    analysis = out.get("analysis") if isinstance(out, dict) else None
    if isinstance(analysis, dict):
        print(
            "[musical] agentic resync analysis: "
            + json.dumps(analysis, ensure_ascii=False)[:400],
            flush=True,
        )
    return out


def clamp_spans(spans, duration):
    """Clamp spans into [0, duration]. Applied to agent AND fallback output —
    the algorithmic aligner's wide search windows can also push a line past
    the end of the video (a real run produced a 300s line on a 251s video)."""
    if not duration or not spans:
        return spans
    out = []
    for s in spans:
        end = min(s["end"], duration)
        start = min(s["start"], max(0.0, end - 0.2))
        out.append({"start": round(start, 3), "end": round(end, 3)})
    return out


def validated_spans(output, n_lines, duration=None):
    """Turn agent output into cache-ready spans [{start, end}], or None.

    Broad breakage (non-dict, missing/incomplete/duplicate indices,
    non-numeric times, or any line starting beyond the video duration — the
    model lost the plot) is rejected. Small defects are repaired through
    align's own monotonicity pass — the same enforcement the deterministic
    aligner applies — so the cache only ever sees spans that satisfy the
    overlay contract regardless of what the model returned.
    """
    if not isinstance(output, dict):
        return None
    raw = output.get("lines")
    if not isinstance(raw, list):
        return None

    by_index = {}
    for item in raw:
        try:
            i = item["i"]
            s = float(item["start"])
            e = float(item["end"])
        except (KeyError, TypeError, ValueError):
            return None
        if not isinstance(i, int) or not 0 <= i < n_lines or i in by_index:
            return None
        if s != s or e != e:  # NaN guard
            return None
        by_index[i] = (s, e)
    if len(by_index) != n_lines:
        return None

    if duration:
        # A line that STARTS at/after the end of the video is unambiguous
        # garbage — reject rather than repair, so the fallback aligner runs.
        if any(s >= duration - 0.5 for s, _ in by_index.values()):
            print(
                "[musical] agentic resync rejected: line starts beyond video "
                f"duration ({duration}s)",
                flush=True,
            )
            return None

    entries = [
        {"start": max(0.0, s), "end": e} for (s, e) in (by_index[i] for i in range(n_lines))
    ]
    return clamp_spans(align._enforce_monotonic(entries), duration)
