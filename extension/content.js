(function () {
  "use strict";
  const api = typeof browser !== "undefined" ? browser : chrome;

  let currentRecord = null;
  let currentLineIdx = -1;
  let attachedVideo = null;

  // Per-video subtitle timing, persisted separately from the subtitle record so
  // it survives re-processing. A global offset applies to all lines; each entry
  // in `lines` is a per-line delta {s: start, e: end} that composes on top of
  // global. Effective time = original + global + perLineDelta. Applied
  // non-destructively at render time (see onTimeUpdate).
  let syncData = { global: 0, lines: [] };
  // which line is expanded in the editor (-1 = none)
  let selectedLineIdx = -1;
  // nudge propagation mode: "none" | "a" | "b" (see nudgeLine)
  let nudgeMode = "none";

  let overlayEl, romanizedEl, directEl, meaningEl, btnEl, statusEl;
  let syncBtnEl, syncPanelEl, syncValueEl, syncListEl;
  let resyncBtnEl;

  const SYNC_MAX = 60;

  function ensureUI() {
    if (overlayEl && document.body.contains(overlayEl)) return;

    overlayEl = document.createElement("div");
    overlayEl.id = "musical-overlay";
    romanizedEl = document.createElement("div");
    romanizedEl.className = "musical-line musical-romanized";
    directEl = document.createElement("div");
    directEl.className = "musical-line musical-direct";
    meaningEl = document.createElement("div");
    meaningEl.className = "musical-line musical-meaning";
    overlayEl.append(romanizedEl, directEl, meaningEl);

    btnEl = document.createElement("button");
    btnEl.id = "musical-trigger";
    btnEl.textContent = "🎵";
    btnEl.title = "Generate sing-along subtitles for this song";
    btnEl.addEventListener("click", onTrigger);

    statusEl = document.createElement("span");
    statusEl.id = "musical-status";

    syncBtnEl = document.createElement("button");
    syncBtnEl.id = "musical-sync-btn";
    syncBtnEl.textContent = "⚙";
    syncBtnEl.title = "Adjust subtitle timing";
    syncBtnEl.style.display = "none";
    syncBtnEl.addEventListener("click", toggleSyncPanel);

    syncPanelEl = document.createElement("div");
    syncPanelEl.id = "musical-sync-panel";
    syncPanelEl.style.display = "none";

    // Close (top-right corner of panel)
    const closeBtn = document.createElement("button");
    closeBtn.id = "musical-panel-close";
    closeBtn.textContent = "✕";
    closeBtn.title = "Close";
    closeBtn.addEventListener("click", toggleSyncPanel);
    syncPanelEl.append(closeBtn);

    // Header: global offset + global nudge
    const syncHeader = document.createElement("div");
    syncHeader.className = "musical-sync-header";
    syncValueEl = document.createElement("div");
    syncValueEl.id = "musical-sync-value";
    syncHeader.append(syncValueEl);

    // Mode selector: none / a (ripple to tail) / b (glue to next line)
    const modeRow = document.createElement("div");
    modeRow.id = "musical-mode-row";
    const mkMode = (key, label, hint) => {
      const b = document.createElement("button");
      b.className = "musical-mode-btn";
      b.dataset.mode = key;
      b.textContent = label;
      b.title = hint;
      b.addEventListener("click", () => setNudgeMode(key));
      return b;
    };
    modeRow.append(
      mkMode("none", "single", "Nudge only the field you click"),
      mkMode("a", "A: tail", "Nudge line N: it and every line after shifts together"),
      mkMode("b", "B: glue", "Nudge line N: next line's start glues to this line's end")
    );
    syncHeader.append(modeRow);

    const mkNudge = (label, delta) => {
      const b = document.createElement("button");
      b.className = "musical-nudge";
      b.textContent = label;
      b.addEventListener("click", () => nudgeGlobal(delta));
      return b;
    };
    const nudgeRow = document.createElement("div");
    nudgeRow.className = "musical-nudge-row";
    nudgeRow.append(
      mkNudge("−1.0", -1.0),
      mkNudge("−0.3", -0.3),
      mkNudge("+0.3", 0.3),
      mkNudge("+1.0", 1.0)
    );
    syncHeader.append(nudgeRow);

    // Display controls: size (S/M/L) + background toggle — persisted globally
    const dispRow = document.createElement("div");
    dispRow.id = "musical-disp-row";
    const mkSize = (key, label) => {
      const b = document.createElement("button");
      b.className = "musical-size-btn";
      b.dataset.size = key;
      b.textContent = label;
      b.title = "Text size: " + label;
      b.addEventListener("click", () => setSize(key));
      return b;
    };
    dispRow.append(mkSize("small", "S"), mkSize("medium", "M"), mkSize("large", "L"));
    const bgBtn = document.createElement("button");
    bgBtn.id = "musical-bg-btn";
    bgBtn.textContent = "▮";
    bgBtn.title = "Toggle background box";
    bgBtn.addEventListener("click", toggleBg);
    dispRow.append(bgBtn);
    syncHeader.append(dispRow);

    // Re-sync from audio: re-transcribes via Groq and re-aligns line timing.
    // Only shown when a record is loaded (added/removed by ensureResyncButton).
    const resyncRow = document.createElement("div");
    resyncRow.id = "musical-resync-row";
    resyncBtnEl = document.createElement("button");
    resyncBtnEl.id = "musical-resync-btn";
    resyncBtnEl.textContent = "🔊 Re-sync from audio";
    resyncBtnEl.title =
      "Re-transcribe the audio and re-align line timing. Fixes drift when synced lyrics are out of step with the recording.";
    resyncBtnEl.addEventListener("click", onResync);
    resyncRow.append(resyncBtnEl);
    syncHeader.append(resyncRow);

    syncPanelEl.append(syncHeader);

    // Scrollable list of lines (rows built dynamically in renderSync)
    syncListEl = document.createElement("div");
    syncListEl.className = "musical-sync-list";
    syncPanelEl.append(syncListEl);

    document.body.append(overlayEl, btnEl, statusEl, syncBtnEl, syncPanelEl);
    renderSync();
  }

  function showStatus(msg, isError) {
    ensureUI();
    statusEl.textContent = msg || "";
    statusEl.classList.toggle("musical-error", !!isError);
    if (msg) {
      clearTimeout(showStatus._t);
      showStatus._t = setTimeout(() => (statusEl.textContent = ""), 4500);
    }
  }

  // ---- subtitle timing (global offset + per-line deltas) ----

  function syncKey(videoId) {
    return "musical:sync:" + videoId;
  }

  // Normalize stored value to { global, lines } with lines padded to record length.
  function normalizeSyncData(v, lineCount) {
    let data;
    if (typeof v === "number") {
      data = { global: v, lines: [] }; // migrate old bare-number format
    } else if (v && typeof v === "object") {
      data = { global: typeof v.global === "number" ? v.global : 0, lines: Array.isArray(v.lines) ? v.lines.slice() : [] };
    } else {
      data = { global: 0, lines: [] };
    }
    const lines = [];
    for (let i = 0; i < lineCount; i++) {
      const e = data.lines[i];
      lines.push({
        s: e && typeof e.s === "number" ? e.s : 0,
        e: e && typeof e.e === "number" ? e.e : 0,
      });
    }
    data.lines = lines;
    return data;
  }

  async function loadSync(videoId) {
    const n = currentRecord ? currentRecord.lines.length : 0;
    const bag = await api.storage.local.get(syncKey(videoId));
    syncData = normalizeSyncData(bag && bag[syncKey(videoId)], n);
    selectedLineIdx = -1;
    renderSync();
  }

  function saveSync(videoId) {
    api.storage.local.set({ [syncKey(videoId)]: syncData });
  }

  function effectiveStart(i) {
    const ln = currentRecord.lines[i];
    return ln.start + syncData.global + (syncData.lines[i] ? syncData.lines[i].s : 0);
  }

  function effectiveEnd(i) {
    const ln = currentRecord.lines[i];
    return ln.end + syncData.global + (syncData.lines[i] ? syncData.lines[i].e : 0);
  }

  function clamp(v) {
    return Math.max(-SYNC_MAX, Math.min(SYNC_MAX, +v.toFixed(1)));
  }

  function persistAndRefresh() {
    const id = getVideoId();
    if (id) saveSync(id);
    renderSync();
    currentLineIdx = -1; // force overlay re-evaluation so timing snaps immediately
    onTimeUpdate();
  }

  function nudgeGlobal(delta) {
    syncData.global = clamp(syncData.global + delta);
    persistAndRefresh();
  }

  function setNudgeMode(key) {
    nudgeMode = key === "a" || key === "b" ? key : "none";
    renderMode();
  }

  function renderMode() {
    const btns = document.querySelectorAll(".musical-mode-btn");
    btns.forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === nudgeMode);
    });
  }

  // ---- display preferences (global, persisted) ----
  // Applied as classes on the overlay: text size + optional background box.
  let displayPrefs = { size: "medium", bg: true };

  const DISP_KEY = "musical:display";

  async function loadDisplayPrefs() {
    const bag = await api.storage.local.get(DISP_KEY);
    const v = bag && bag[DISP_KEY];
    displayPrefs = {
      size: v && ["small", "medium", "large"].includes(v.size) ? v.size : "medium",
      bg: v && typeof v.bg === "boolean" ? v.bg : true,
    };
    applyDisplay();
  }

  function saveDisplayPrefs() {
    api.storage.local.set({ [DISP_KEY]: displayPrefs });
  }

  function applyDisplay() {
    if (!overlayEl) return;
    overlayEl.classList.remove("musical-size-small", "musical-size-medium", "musical-size-large");
    overlayEl.classList.add("musical-size-" + displayPrefs.size);
    overlayEl.classList.toggle("musical-bg", displayPrefs.bg);
    // size button highlight
    document.querySelectorAll(".musical-size-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.size === displayPrefs.size);
    });
    const bgBtn = document.getElementById("musical-bg-btn");
    if (bgBtn) bgBtn.classList.toggle("active", displayPrefs.bg);
  }

  function setSize(key) {
    if (!["small", "medium", "large"].includes(key)) return;
    displayPrefs.size = key;
    saveDisplayPrefs();
    applyDisplay();
  }

  function toggleBg() {
    displayPrefs.bg = !displayPrefs.bg;
    saveDisplayPrefs();
    applyDisplay();
  }

  // Apply delta to line i's field ("s" or "e"), propagating per nudgeMode:
  //   none — only the touched field moves.
  //   a    — line i (both s & e) AND every line after i (both s & e) shift by delta.
  //   b    — glue to next: nudging i.s -> i.s, i.e, (i+1).s move by delta;
  //          nudging i.e -> i.e, (i+1).s move by delta.
  function nudgeLine(i, field, delta) {
    const ensure = (k) => (syncData.lines[k] || (syncData.lines[k] = { s: 0, e: 0 }));
    if (nudgeMode === "a") {
      for (let k = i; k < syncData.lines.length; k++) {
        const ln = ensure(k);
        ln.s = clamp(ln.s + delta);
        ln.e = clamp(ln.e + delta);
      }
    } else if (nudgeMode === "b") {
      ensure(i)[field] = clamp(ensure(i)[field] + delta);
      if (field === "s") ensure(i).e = clamp(ensure(i).e + delta);
      if (i + 1 < syncData.lines.length) ensure(i + 1).s = clamp(ensure(i + 1).s + delta);
    } else {
      ensure(i)[field] = clamp(ensure(i)[field] + delta);
    }
    persistAndRefresh();
  }

  function resetLine(i) {
    if (syncData.lines[i]) {
      syncData.lines[i].s = 0;
      syncData.lines[i].e = 0;
    }
    persistAndRefresh();
  }

  function seekToLine(i) {
    if (!attachedVideo) return;
    attachedVideo.currentTime = effectiveStart(i);
  }

  function selectLine(i) {
    selectedLineIdx = selectedLineIdx === i ? -1 : i; // toggle
    renderSync();
  }

  function toggleSyncPanel() {
    if (!syncPanelEl) return;
    const open = syncPanelEl.style.display === "none";
    syncPanelEl.style.display = open ? "flex" : "none";
    if (open) {
      renderMode();
      renderSync();
      applyDisplay(); // refresh size/bg button highlights
    }
  }

  function setSyncAvailable(available) {
    if (!syncBtnEl) return;
    syncBtnEl.style.display = available ? "block" : "none";
    if (!available && syncPanelEl) syncPanelEl.style.display = "none";
  }

  function fmtTime(s) {
    if (s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = (s - m * 60).toFixed(0).padStart(2, "0");
    return `${m}:${sec}`;
  }

  // Render the global readout + (re)build the line list.
  function renderSync() {
    if (!syncValueEl || !currentRecord) return;
    const o = syncData.global;
    const sign = o > 0 ? "+" : "";
    syncValueEl.textContent = `global ${sign}${o.toFixed(1)}s`;
    syncValueEl.classList.toggle("musical-pos", o > 0);
    syncValueEl.classList.toggle("musical-neg", o < 0);

    // Rebuild list
    syncListEl.innerHTML = "";
    const lines = currentRecord.lines;
    for (let i = 0; i < lines.length; i++) {
      const row = document.createElement("div");
      row.className = "musical-line-row";
      if (i === selectedLineIdx) row.classList.add("selected");
      if (i === currentLineIdx) row.classList.add("current");

      const head = document.createElement("div");
      head.className = "musical-line-head";
      const idx = document.createElement("span");
      idx.className = "musical-line-idx";
      idx.textContent = String(i + 1);
      const time = document.createElement("span");
      time.className = "musical-line-time";
      time.textContent = `${fmtTime(effectiveStart(i))}–${fmtTime(effectiveEnd(i))}`;
      time.title = "Seek to this line";
      time.addEventListener("click", () => seekToLine(i));
      const snippet = document.createElement("span");
      snippet.className = "musical-line-snippet";
      snippet.textContent = (lines[i].romanized || lines[i].original || "").slice(0, 34);
      head.append(idx, time, snippet);
      head.addEventListener("click", (ev) => {
        if (ev.target === time) return; // time seeks, doesn't select
        selectLine(i);
      });
      row.append(head);

      if (i === selectedLineIdx) {
        row.append(buildLineEditor(i));
      }
      syncListEl.append(row);
    }
  }

  function buildLineEditor(i) {
    const ed = document.createElement("div");
    ed.className = "musical-line-editor";
    const mk = (icon, field, value) => {
      const wrap = document.createElement("div");
      wrap.className = "musical-field-row";
      const lab = document.createElement("span");
      lab.className = "musical-field-label";
      lab.textContent = icon + " " + fmtTime(value);
      const grp = document.createElement("span");
      grp.className = "musical-nudge-row";
      [-1.0, -0.3, 0.3, 1.0].forEach((d) => {
        const b = document.createElement("button");
        b.className = "musical-nudge";
        b.textContent = (d > 0 ? "+" : "") + d;
        b.addEventListener("click", () => nudgeLine(i, field, d));
        grp.append(b);
      });
      wrap.append(lab, grp);
      return wrap;
    };
    ed.append(
      mk("●", "s", effectiveStart(i)),
      mk("○", "e", effectiveEnd(i))
    );
    const act = document.createElement("div");
    act.className = "musical-nudge-row";
    const play = document.createElement("button");
    play.className = "musical-nudge";
    play.textContent = "▶";
    play.title = "Play from this line";
    play.addEventListener("click", () => seekToLine(i));
    const reset = document.createElement("button");
    reset.className = "musical-nudge";
    reset.textContent = "↺";
    reset.title = "Reset this line";
    reset.addEventListener("click", () => resetLine(i));
    act.append(play, reset);
    ed.append(act);
    return ed;
  }

  // Gently scroll the current line into view when it changes (only if panel open
  // and only if the row is off-screen, so manual scrolling isn't fought).
  function autoFollowCurrentLine() {
    if (!syncPanelEl || syncPanelEl.style.display === "none") return;
    if (currentLineIdx < 0 || !syncListEl) return;
    const row = syncListEl.children[currentLineIdx];
    if (!row) return;
    const r = row.getBoundingClientRect();
    const pr = syncListEl.getBoundingClientRect();
    if (r.top < pr.top || r.bottom > pr.bottom) {
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  // Show the logo-only button as "ready" (green) once subtitles are cached.
  // When subtitles are cached we hide the 🎵 trigger and show ⚙ instead —
  // exactly one of them is visible at a time. setSyncAvailable shows/hides ⚙,
  // this shows/hides 🎵 as the inverse.
  function setBtnReady(ready) {
    if (!btnEl) return;
    btnEl.style.display = ready ? "none" : "block";
  }

  function getVideoId() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get("v");
    } catch (e) {
      return null;
    }
  }

  async function loadFromCache(videoId) {
    const key = "musical:" + videoId;
    const bag = await api.storage.local.get(key);
    return bag && bag[key] ? bag[key] : null;
  }

  function clearOverlay() {
    currentLineIdx = -1;
    romanizedEl.textContent = "";
    directEl.textContent = "";
    meaningEl.textContent = "";
    overlayEl.style.display = "none";
  }

  function attachVideo() {
    const v = document.querySelector("video");
    if (!v) {
      setTimeout(attachVideo, 500);
      return;
    }
    if (attachedVideo === v) {
      onTimeUpdate();
      return;
    }
    attachedVideo = v;
    v.addEventListener("timeupdate", onTimeUpdate);
    onTimeUpdate();
  }

  function onTimeUpdate() {
    if (!currentRecord || !attachedVideo) return;
    const t = attachedVideo.currentTime;
    const lines = currentRecord.lines;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (t >= effectiveStart(i) && t < effectiveEnd(i)) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      if (currentLineIdx !== -1) {
        clearOverlay();
        // refresh the row highlight since current line changed
        if (syncPanelEl && syncPanelEl.style.display !== "none") renderSync();
      }
      return;
    }
    if (idx === currentLineIdx) return;
    currentLineIdx = idx;
    const ln = lines[idx];
    const romanized = ln.romanized || "";
    romanizedEl.textContent = romanized;
    romanizedEl.style.display = romanized ? "block" : "none";
    directEl.textContent = ln.translation_direct || "";
    meaningEl.textContent = ln.meaning || "";
    overlayEl.style.display = "block";
    if (syncPanelEl && syncPanelEl.style.display !== "none") {
      renderSync();
      autoFollowCurrentLine();
    }
  }

  async function onNavigate() {
    ensureUI();
    await loadDisplayPrefs();
    const id = getVideoId();
    if (!id) {
      setSyncAvailable(false);
      return;
    }
    currentRecord = await loadFromCache(id);
    if (currentRecord) {
      await loadSync(id);
      setBtnReady(true);
      setSyncAvailable(true);
      attachVideo();
    } else {
      setBtnReady(false);
      syncData = { global: 0, lines: [] };
      selectedLineIdx = -1;
      setSyncAvailable(false);
      clearOverlay();
    }
  }

  function sendWithRetry(msg, attempts) {
    return api.runtime.sendMessage(msg).then(
      (resp) => resp,
      (err) => {
        const reason = (err && err.message) ? err.message : String(err);
        if (attempts > 1 && /receiv|establish|connection/i.test(reason)) {
          return new Promise((res) => setTimeout(res, 700)).then(
            () => sendWithRetry(msg, attempts - 1)
          );
        }
        throw err;
      }
    );
  }

  function onTrigger() {
    const id = getVideoId();
    if (!id) {
      showStatus("Open a YouTube watch page first.", true);
      return;
    }
    btnEl.disabled = true;
    showStatus("Generating… (metadata + lyrics + translation)");
    sendWithRetry({ type: "process", url: location.href }, 3).then(
      (resp) => {
        btnEl.disabled = false;
        if (!resp || !resp.ok) {
          showStatus("Error: " + (resp ? resp.error : "no response from background"), true);
          return;
        }
        const rec = resp.rec;
        api.storage.local.set({ ["musical:" + id]: rec }).then(async () => {
          currentRecord = rec;
          currentLineIdx = -1;
          await loadSync(id); // preserve any existing sync for this video
          setBtnReady(true);
          setSyncAvailable(true);
          attachVideo();
          showStatus("Done ✓");
        });
      },
      (err) => {
        btnEl.disabled = false;
        const reason = (err && err.message) ? err.message : String(err);
        showStatus("Error: send failed — " + reason, true);
      }
    );
  }

  // Re-sync from audio: the backend re-transcribes the source audio via Groq
  // and re-aligns the cached line texts to fresh word timestamps. We then
  // replace the record and clear any manual sync deltas, since the base
  // timestamps have changed (old deltas no longer apply).
  function onResync() {
    const id = getVideoId();
    if (!id) {
      showStatus("Open a YouTube watch page first.", true);
      return;
    }
    resyncBtnEl.disabled = true;
    showStatus("Re-syncing from audio… (downloads + transcribes)");
    sendWithRetry({ type: "resync", videoId: id }, 3).then(
      (resp) => {
        resyncBtnEl.disabled = false;
        if (!resp || !resp.ok) {
          showStatus("Error: " + (resp ? resp.error : "no response from background"), true);
          return;
        }
        const rec = resp.rec;
        api.storage.local.set({ ["musical:" + id]: rec }).then(async () => {
          currentRecord = rec;
          currentLineIdx = -1;
          // Clear manual sync deltas: the base timings were just rebuilt from
          // the audio, so the old offsets are meaningless. Also remove the
          // persisted sync entry for this video.
          syncData = { global: 0, lines: [] };
          await api.storage.local.remove(syncKey(id));
          renderSync();
          onTimeUpdate();
          showStatus("Re-synced ✓");
        });
      },
      (err) => {
        resyncBtnEl.disabled = false;
        const reason = (err && err.message) ? err.message : String(err);
        showStatus("Error: send failed — " + reason, true);
      }
    );
  }

  window.addEventListener("yt-navigate-finish", onNavigate);
  document.addEventListener("DOMContentLoaded", onNavigate);
  setTimeout(onNavigate, 1500);
})();
