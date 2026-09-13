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

let overlayEl, romanizedEl, directEl, meaningEl, statusEl;
let syncPanelEl, syncValueEl, syncListEl;
let resyncBtnEl;
// The injected native action-bar pill. We clone a real YouTube action button
// (see injectActionBarButton) so it inherits YouTube's build-specific styling.
// One element, two states: idle (♫, click → generate) / ready (⚙, click →
// open the sync panel). null until injection succeeds on a watch page.
let actionBtnEl = null;
// True while a backend generate is in flight (disables the pill click).
let generating = false;

  const SYNC_MAX = 60;
  // Mirror of backend align.DEFAULT_LINE_DUR: the minimum span (seconds) a
  // sanitized/clamped line is given when its real end is unusable.
  const DEFAULT_LINE_DUR_S = 4.0;

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

    statusEl = document.createElement("span");
    statusEl.id = "musical-status";

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
    const hideBtn = document.createElement("button");
    hideBtn.id = "musical-hide-btn";
    hideBtn.title = "Hide the lyrics overlay";
    hideBtn.addEventListener("click", toggleHidden);
    dispRow.append(hideBtn);
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

    document.body.append(overlayEl, statusEl, syncPanelEl);
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
    const end = ln.end + syncData.global + (syncData.lines[i] ? syncData.lines[i].e : 0);
    // GUARD: a stale record (written before align.py's _enforce_monotonic, or a
    // failed /resync that left bad data in browser.storage.local — which is NOT
    // versioned per AGENTS.md) can have end <= start. Without this clamp the
    // panel renders a backwards span ("2:50–1:50") and onTimeUpdate's hit
    // window (t >= start && t < end) silently becomes empty, so the line never
    // shows. Force end to at least start + a beat so it's always renderable.
    const start = effectiveStart(i);
    return end < start + 0.5 ? start + 0.5 : end;
  }

  function clamp(v) {
    return Math.max(-SYNC_MAX, Math.min(SYNC_MAX, +v.toFixed(1)));
  }

  function persistAndRefresh() {
    const id = getVideoId();
    if (id) saveSync(id);
    renderSync();
    // Force an immediate render so a nudge snaps the overlay to the new timing
    // without waiting for the next timeupdate tick.
    forceOverlayRender();
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
  // `hidden` suppresses the overlay entirely (the pill and panel keep working).
  let displayPrefs = { size: "medium", bg: true, hidden: false };

  const DISP_KEY = "musical:display";

  async function loadDisplayPrefs() {
    const bag = await api.storage.local.get(DISP_KEY);
    const v = bag && bag[DISP_KEY];
    displayPrefs = {
      size: v && ["small", "medium", "large"].includes(v.size) ? v.size : "medium",
      bg: v && typeof v.bg === "boolean" ? v.bg : true,
      hidden: !!(v && v.hidden),
    };
    applyDisplay();
  }

  function saveDisplayPrefs() {
    api.storage.local.set({ [DISP_KEY]: displayPrefs });
  }

  // ---- native action-bar pill injection ----
  // The trigger used to be a floating, draggable button. It now lives inside
  // YouTube's own action bar (the Like/Share/Save row) as a native-looking
  // pill. We can't style that from scratch: YouTube's button look comes from
  // build-specific, obfuscated BEM classes (yt-spec-button-shape-next--*) that
  // change between releases. So we CLONE a real sibling action button — which
  // inherits YouTube's Polymer-initialized internals + style-scope classes —
  // and mutate its icon/label. This is the same technique Return YouTube
  // Dislike (and other action-bar extensions) use; building a node from
  // scratch breaks on the next YouTube build.
  //
  // One element, two states, set by updateActionBtn():
  //   idle  (no cached subs) → ♫ glyph, click generates subtitles.
  //   ready (cached)         → ⚙ glyph, click opens the sync panel.
  // Never visible off the watch page or on >15min videos (same gates as before).

  // Fallback chain for the action-bar container. YouTube's layout has changed
  // across builds (#top-level-buttons-computed is the classic watch bar;
  // #flexible-item-buttons and a bare menu div are newer fallbacks), so we try
  // each in order and take whichever has a cloneable child button.
  const ACTION_BAR_SELECTORS = [
    "#top-level-buttons-computed",
    "#flexible-item-buttons",
    "ytd-menu-renderer > div#container",
    "ytd-menu-renderer > div",
  ];
  // Marker we stamp on our injected node so we never double-inject and can find
  // it again across YouTube's own re-renders.
  const ACTION_BTN_MARKER = "musical-action-btn";

  // Find an existing YouTube action button to clone, or null if the bar isn't
  // ready yet. We prefer the LAST child (Share/Save end of the row) because the
  // segmented Like/Dislike at the start is a different element type whose clone
  // can mis-render; trailing action buttons (ytd-button-renderer /
  // yt-button-view-model) are the cleanest single-button template.
  function findActionBarTemplate() {
    for (const sel of ACTION_BAR_SELECTORS) {
      const bar = document.querySelector(sel);
      if (!bar) continue;
      const kids = Array.from(bar.children).filter(
        (c) => c.tagName.toLowerCase().startsWith("ytd-") || c.tagName.toLowerCase().startsWith("yt-")
      );
      // Use the last real action button (skip any leftover markers/our own node).
      for (let i = kids.length - 1; i >= 0; i--) {
        const k = kids[i];
        if (!k.hasAttribute("data-" + "musical")) return { bar, template: k };
      }
    }
    return null;
  }

  // Inject (or re-find) the pill. Idempotent: if our node already exists in the
  // bar, just rebind the click handler and return it. Returns the pill node or
  // null if the action bar isn't present (caller retries).
  function injectActionBarButton() {
    const found = findActionBarTemplate();
    if (!found) {
      actionBtnEl = null;
      return null;
    }
    const { bar, template } = found;

    // Already injected and still attached? Rebind and reuse. (YouTube recreates
    // the whole bar on navigation, so a stale reference is normal after nav.)
    if (actionBtnEl && document.body.contains(actionBtnEl) && actionBtnEl.parentElement === bar) {
      updateActionBtn();
      return actionBtnEl;
    }

    // Drop any orphaned copy from a prior injection on this bar.
    const stale = bar.querySelector("[" + "data-" + "musical='" + ACTION_BTN_MARKER + "']");
    if (stale) stale.remove();

    const clone = template.cloneNode(true);
    clone.setAttribute("data-" + "musical", ACTION_BTN_MARKER);
    clone.removeAttribute("hidden");
    setGlyph(clone, "♫");
    clone.setAttribute("aria-label", "musical: generate sing-along subtitles");
    clone.title = "Generate sing-along subtitles for this song";
    // cloneNode copies attributes/DOM but NOT listeners added via addEventListener,
    // so the cloned template's native click (e.g. Share) does not carry over —
    // safe to attach our own.
    clone.addEventListener("click", onActionBtnClick);
    bar.append(clone);
    actionBtnEl = clone;
    updateActionBtn();
    return actionBtnEl;
  }

  // Replace the glyph shown on our cloned action button. YouTube action buttons
  // have TWO visible parts we must fully own: an icon (`.yt-spec-button-shape-
  // next__icon` / `yt-icon`) and a label text span
  // (`.yt-spec-button-shape-next__button-text-content` / the attributed-string
  // span). If we only touch the icon, the cloned "Save"/"Share" label stays
  // visible behind our glyph — that's the "blue box" artifact. So we DROP the
  // label and put our glyph in the icon slot. (Our pills are icon-only: ♫/⚙/⏳.)
  // Glyphs must be text-presentation characters (♫, ⚙): color emoji (e.g. 🎵)
  // renders through the emoji font with its own fixed colors and ignores the
  // button's inherited white.
  function setGlyph(el, glyph) {
    // Remove the text label entirely so only the icon shows.
    const label =
      el.querySelector(".yt-spec-button-shape-next__button-text-content") ||
      el.querySelector(".yt-core-attributed-string");
    if (label && label.parentElement) label.parentElement.removeChild(label);

    // Put our glyph where the icon was. The icon host is the innermost icon
    // container; fall back to the button / the node itself for safety.
    const iconHost =
      el.querySelector(".yt-spec-button-shape-next__icon") ||
      el.querySelector("yt-icon") ||
      el.querySelector("button") ||
      el;
    iconHost.textContent = glyph;
  }

  // Reflect the current app state on the pill: glyph + tooltip + click target
  // depend on whether subtitles are cached (currentRecord) and whether we're
  // generating. Honors the watch-page + duration gates so the pill is hidden
  // off-watch and on long videos, matching the old floating-button behavior.
  function updateActionBtn() {
    if (!actionBtnEl) return;
    const show = onWatchPage && !hiddenByDuration;
    actionBtnEl.style.display = show ? "" : "none";

    if (generating) {
      setGlyph(actionBtnEl, "⏳");
      actionBtnEl.setAttribute("aria-label", "musical: generating subtitles…");
      actionBtnEl.title = "Generating subtitles…";
      actionBtnEl.classList.add("musical-loading");
      actionBtnEl.classList.remove("musical-ready");
      return;
    }
    actionBtnEl.classList.remove("musical-loading");
    const ready = !!currentRecord && show;
    if (ready) {
      setGlyph(actionBtnEl, "⚙");
      actionBtnEl.setAttribute("aria-label", "musical: open subtitle timing panel");
      actionBtnEl.title = "Open subtitle timing panel";
      actionBtnEl.classList.add("musical-ready");
    } else {
      setGlyph(actionBtnEl, "♫");
      actionBtnEl.setAttribute("aria-label", "musical: generate sing-along subtitles");
      actionBtnEl.title = "Generate sing-along subtitles for this song";
      actionBtnEl.classList.remove("musical-ready");
    }
  }

  // Single click target for the pill: generate when idle, open the sync panel
  // when subtitles are cached. Disabled while a generate is in flight.
  function onActionBtnClick() {
    if (generating) return;
    if (currentRecord) toggleSyncPanel();
    else onTrigger();
  }

  // The action bar appears asynchronously after yt-navigate-finish, so retry
  // on a backoff until the template is found or we give up (~6s). Keeps a
  // single timer across calls so re-navigation doesn't pile up loops.
  let injectTimer = null;
  function ensureActionBarButton() {
    if (injectTimer) clearTimeout(injectTimer);
    let tries = 0;
    const tick = () => {
      injectTimer = null;
      if (injectActionBarButton()) return;
      if (++tries > 24) return; // ~6s of 250ms spacing
      injectTimer = setTimeout(tick, 250);
    };
    tick();
  }

  // YouTube rebuilds the action bar at times OTHER than yt-navigate-finish:
  // on watch→watch navigation the bar often still holds the PREVIOUS video's
  // buttons when the retry above runs, so we inject and the loop exits — then
  // seconds later YouTube swaps the row for the new video's buttons, discarding
  // our clone with the old container, and no further navigate event fires.
  // The pill then stayed hidden for the rest of the video. This guard watches
  // for our node being detached and re-runs the retry loop; it also covers a
  // bar that appears later than the retry window (its appearance is itself a
  // mutation). Coalesces YouTube's constant DOM churn into one contains()
  // check per burst. (Same technique Return YouTube Dislike uses to survive
  // action-bar re-renders.)
  let recheckScheduled = false;
  new MutationObserver(() => {
    if (recheckScheduled) return;
    recheckScheduled = true;
    setTimeout(() => {
      recheckScheduled = false;
      if (!onWatchPage) return;
      if (actionBtnEl && document.body.contains(actionBtnEl)) return;
      ensureActionBarButton();
    }, 200);
  }).observe(document.body, { childList: true, subtree: true });

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
    const hideBtn = document.getElementById("musical-hide-btn");
    if (hideBtn) {
      hideBtn.textContent = displayPrefs.hidden ? "Show" : "Hide";
      hideBtn.title = displayPrefs.hidden
        ? "Show the lyrics overlay"
        : "Hide the lyrics overlay";
    }
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

  function toggleHidden() {
    displayPrefs.hidden = !displayPrefs.hidden;
    saveDisplayPrefs();
    applyDisplay();
    if (displayPrefs.hidden) clearOverlay();
    else forceOverlayRender();
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

  // Closing the panel also refreshes the pill (it may need to switch back to
  // the ⚙ glyph vs. just de-highlight). Kept as a small helper since open/close
  // now both flow through the pill instead of a separate sync button.
  function closeSyncPanel() {
    if (!syncPanelEl) return;
    syncPanelEl.style.display = "none";
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

  // True when the pill is forced off because the video is too long
  // (> MAX_DURATION_S). Set by evaluateVisibility; read by updateActionBtn so
  // the duration gate applies everywhere without each call site re-checking.
  const MAX_DURATION_S = 15 * 60; // hide on videos longer than 15 minutes
  let hiddenByDuration = false;

  // True only on a watch page (a URL with ?v=). The pill is meaningless on
  // home / search / channel pages, so we hide it there. Set by onNavigate.
  let onWatchPage = false;

  // Recompute the duration gate and re-apply the pill state. Called whenever
  // the duration might have changed or become known: on navigation, on
  // attaching the video, and on its loadedmetadata / durationchange events.
  // NaN/unknown duration → not hidden (eligible), so short songs work while
  // metadata is still loading.
  function evaluateVisibility() {
    const v = attachedVideo;
    const dur = v ? v.duration : NaN;
    const wasHidden = hiddenByDuration;
    hiddenByDuration = Number.isFinite(dur) && dur > MAX_DURATION_S;
    if (!wasHidden && !hiddenByDuration) return; // nothing to update

    // Force-close the panel when we hide (no way to reopen it anyway).
    if (hiddenByDuration) closeSyncPanel();

    updateActionBtn();
  }

  function getVideoId() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get("v");
    } catch (e) {
      return null;
    }
  }

  // Records the extension understands. The backend stamps "v" on every record
  // it returns; a stored copy without it predates the current contract (e.g.
  // whole-verse line grouping), so it is replaced by the backend's copy.
  const CURRENT_RECORD_V = 2;

  async function loadFromCache(videoId) {
    const key = "musical:" + videoId;
    const bag = await api.storage.local.get(key);
    const rec = bag && bag[key] ? bag[key] : null;
    let local = null;
    if (rec && Array.isArray(rec.lines)) {
      // Self-heal stale records: the backend now guarantees monotonic, non-empty
      // spans, but browser.storage.local is NOT versioned (per AGENTS.md), so a
      // record written by an older backend — or left in place after a FAILED
      // /resync — can contain end <= start lines that render as backwards
      // spans ("2:50–1:50"). Repair and persist so it doesn't recur.
      if (sanitizeRecord(rec)) {
        await api.storage.local.set({ [key]: rec });
      }
      if (rec.v >= CURRENT_RECORD_V) return rec;
      local = rec; // pre-v2: keep as a fallback while we ask the backend
    }
    // No usable local copy: check the backend cache (read-only, costs nothing —
    // this is NOT auto-processing). A hit is adopted and stored, so the pill
    // shows ⚙ and the lyrics render without a click.
    try {
      const resp = await sendWithRetry({ type: "get", videoId }, 2);
      if (resp && resp.ok && resp.rec && Array.isArray(resp.rec.lines)) {
        await api.storage.local.set({ [key]: resp.rec });
        return resp.rec;
      }
    } catch (e) {
      // Backend down or unreachable: fall through to whatever we have.
    }
    return local;
  }

  // Repair a record's lines in place. Returns true if anything changed.
  // Forces every span to be non-empty (end > start) and monotonic
  // (start >= previous end), matching align.py's _enforce_monotonic contract.
  function sanitizeRecord(rec) {
    if (!rec || !Array.isArray(rec.lines)) return false;
    let changed = false;
    let prevEnd = null;
    for (const ln of rec.lines) {
      let start = Number.isFinite(ln.start) ? ln.start : 0;
      let end = Number.isFinite(ln.end) ? ln.end : start + DEFAULT_LINE_DUR_S;
      if (end <= start) {
        end = start + DEFAULT_LINE_DUR_S;
        changed = true;
      }
      if (prevEnd !== null && start < prevEnd) {
        start = prevEnd;
        if (end <= start) {
          end = start + DEFAULT_LINE_DUR_S;
        }
        changed = true;
      }
      if (ln.start !== start) {
        ln.start = round3(start);
        changed = true;
      }
      if (ln.end !== end) {
        ln.end = round3(end);
        changed = true;
      }
      prevEnd = end;
    }
    return changed;
  }

  function round3(v) {
    return Math.round(v * 1000) / 1000;
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
      evaluateVisibility(); // duration may have changed since we last looked
      forceOverlayRender(); // record may have loaded since we last attached
      return;
    }
    attachedVideo = v;
    v.addEventListener("timeupdate", onTimeUpdate);
    // Duration can arrive after we attach; re-evaluate the gate when it does.
    v.addEventListener("loadedmetadata", evaluateVisibility);
    v.addEventListener("durationchange", evaluateVisibility);
    evaluateVisibility();
    // Render immediately rather than waiting for the first timeupdate, so a
    // record that was already loaded (cached on navigate, or just generated)
    // shows its current line at once. This also covers the deferred case where
    // attachVideo waited for the <video> to appear.
    forceOverlayRender();
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
    renderLine(idx);
  }

  // Render line `idx` into the overlay NOW and track it as current. Factored
  // out of onTimeUpdate so it can be called directly after a record loads,
  // guaranteeing the first line shows immediately instead of waiting for the
  // next timeupdate (which can be up to ~250ms away and was the source of the
  // "subtitles generated but not shown the first time" flakiness).
  function renderLine(idx) {
    if (!currentRecord || displayPrefs.hidden) return;
    if (idx < 0 || idx >= currentRecord.lines.length) return;
    currentLineIdx = idx;
    const ln = currentRecord.lines[idx];
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

  // Force an immediate overlay render based on the video's current time,
  // bypassing the currentLineIdx short-circuit. Called right after a record
  // loads (generate / navigate-to-cached) so subtitles appear without waiting
  // for the next timeupdate tick.
  function forceOverlayRender() {
    if (!currentRecord || !attachedVideo) {
      clearOverlay();
      return;
    }
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
      clearOverlay();
      return;
    }
    renderLine(idx);
  }

  async function onNavigate() {
    ensureUI();
    await loadDisplayPrefs();
    const id = getVideoId();
    onWatchPage = !!id;
    if (!id) {
      // Off a watch page (home / search / channel): hide the pill, close any
      // open panel, and clear any stale overlay from the previous video.
      actionBtnEl = null; // the bar belongs to the previous page; drop the ref
      updateActionBtn();
      closeSyncPanel();
      clearOverlay();
      return;
    }
    currentRecord = await loadFromCache(id);
    // Inject (or re-find) the action-bar pill. The bar appears asynchronously
    // after navigation, so ensureActionBarButton retries until it's there.
    ensureActionBarButton();
    if (currentRecord) {
      await loadSync(id);
      attachVideo();
      forceOverlayRender(); // show the current line immediately, no timeupdate wait
    } else {
      syncData = { global: 0, lines: [] };
      selectedLineIdx = -1;
      closeSyncPanel();
      clearOverlay();
      // Attach the video even without a cached record: we need its duration to
      // apply the >15 min gate (e.g. on a long non-music video with no cached
      // subtitles). attachVideo is a no-op if no <video> exists yet.
      attachVideo();
    }
    updateActionBtn();
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
    generating = true;
    updateActionBtn();
    showStatus("Generating… (metadata + lyrics + translation)");
    sendWithRetry({ type: "process", url: location.href }, 3).then(
      (resp) => {
        generating = false;
        if (!resp || !resp.ok) {
          updateActionBtn();
          showStatus("Error: " + (resp ? resp.error : "no response from background"), true);
          return;
        }
        const rec = resp.rec;
        api.storage.local.set({ ["musical:" + id]: rec }).then(async () => {
          currentRecord = rec;
          currentLineIdx = -1;
          await loadSync(id); // preserve any existing sync for this video
          attachVideo();
          forceOverlayRender(); // subtitles ready: show the current line now
          updateActionBtn();
          showStatus("Done ✓");
        });
      },
      (err) => {
        generating = false;
        updateActionBtn();
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
    showStatus("Re-syncing from audio… (download + transcription + AI timing — may take a couple of minutes)");
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
          forceOverlayRender();
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
