(function () {
  "use strict";
  const api = typeof browser !== "undefined" ? browser : chrome;

  let currentRecord = null;
  let currentLineIdx = -1;
  let attachedVideo = null;

  // Per-video subtitle timing offset (seconds), persisted separately from the
  // subtitle record so it survives re-processing. Applied non-destructively at
  // render time (see onTimeUpdate).
  let currentSyncOffset = 0;

  let overlayEl, romanizedEl, directEl, meaningEl, btnEl, statusEl;
  let syncBtnEl, syncPanelEl, syncValueEl;

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
    syncBtnEl.textContent = "⚙ sync";
    syncBtnEl.title = "Adjust subtitle timing";
    syncBtnEl.style.display = "none";
    syncBtnEl.addEventListener("click", toggleSyncPanel);

    syncPanelEl = document.createElement("div");
    syncPanelEl.id = "musical-sync-panel";
    syncPanelEl.style.display = "none";

    syncValueEl = document.createElement("div");
    syncValueEl.id = "musical-sync-value";
    syncPanelEl.append(syncValueEl);

    const mkNudge = (label, delta) => {
      const b = document.createElement("button");
      b.className = "musical-nudge";
      b.textContent = label;
      b.addEventListener("click", () => applyOffset(delta));
      return b;
    };
    const nudgeRow = document.createElement("div");
    nudgeRow.className = "musical-nudge-row";
    nudgeRow.append(
      mkNudge("−0.5", -0.5),
      mkNudge("−0.1", -0.1),
      mkNudge("+0.1", 0.1),
      mkNudge("+0.5", 0.5)
    );
    syncPanelEl.append(nudgeRow);

    const actionRow = document.createElement("div");
    actionRow.className = "musical-sync-actions";
    const resetBtn = document.createElement("button");
    resetBtn.className = "musical-nudge";
    resetBtn.textContent = "reset";
    resetBtn.addEventListener("click", resetOffset);
    const closeBtn = document.createElement("button");
    closeBtn.className = "musical-nudge";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", toggleSyncPanel);
    actionRow.append(resetBtn, closeBtn);
    syncPanelEl.append(actionRow);

    document.body.append(overlayEl, btnEl, statusEl, syncBtnEl, syncPanelEl);
    renderOffset();
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

  // ---- subtitle timing offset ----

  function offsetKey(videoId) {
    return "musical:sync:" + videoId;
  }

  async function loadOffset(videoId) {
    const bag = await api.storage.local.get(offsetKey(videoId));
    const v = bag && bag[offsetKey(videoId)];
    currentSyncOffset = typeof v === "number" ? v : 0;
    renderOffset();
  }

  function saveOffset(videoId) {
    api.storage.local.set({ [offsetKey(videoId)]: currentSyncOffset });
  }

  function renderOffset() {
    if (!syncValueEl) return;
    const o = currentSyncOffset;
    const sign = o > 0 ? "+" : "";
    syncValueEl.textContent = `${sign}${o.toFixed(1)}s`;
    syncValueEl.classList.toggle("musical-pos", o > 0);
    syncValueEl.classList.toggle("musical-neg", o < 0);
  }

  function applyOffset(delta) {
    const next = Math.max(-SYNC_MAX, Math.min(SYNC_MAX, +(currentSyncOffset + delta).toFixed(1)));
    if (next === currentSyncOffset) return;
    currentSyncOffset = next;
    renderOffset();
    const id = getVideoId();
    if (id) saveOffset(id);
    currentLineIdx = -1; // force re-evaluation so the overlay snaps to the new timing
    onTimeUpdate();
  }

  function resetOffset() {
    currentSyncOffset = 0;
    renderOffset();
    const id = getVideoId();
    if (id) saveOffset(id);
    currentLineIdx = -1;
    onTimeUpdate();
  }

  function toggleSyncPanel() {
    if (!syncPanelEl) return;
    const open = syncPanelEl.style.display === "none";
    syncPanelEl.style.display = open ? "block" : "none";
  }

  function setSyncAvailable(available) {
    if (!syncBtnEl) return;
    syncBtnEl.style.display = available ? "block" : "none";
    if (!available && syncPanelEl) syncPanelEl.style.display = "none";
  }

  // Show the logo-only button as "ready" (green) once subtitles are cached.
  function setBtnReady(ready) {
    if (!btnEl) return;
    btnEl.textContent = "🎵";
    btnEl.classList.toggle("musical-ready", !!ready);
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
    const off = currentSyncOffset;
    const lines = currentRecord.lines;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (t >= lines[i].start + off && t < lines[i].end + off) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      if (currentLineIdx !== -1) clearOverlay();
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
  }

  async function onNavigate() {
    ensureUI();
    const id = getVideoId();
    if (!id) {
      setSyncAvailable(false);
      return;
    }
    currentRecord = await loadFromCache(id);
    if (currentRecord) {
      await loadOffset(id);
      setBtnReady(true);
      setSyncAvailable(true);
      attachVideo();
    } else {
      setBtnReady(false);
      currentSyncOffset = 0;
      renderOffset();
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
          await loadOffset(id); // preserve any existing sync for this video
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

  window.addEventListener("yt-navigate-finish", onNavigate);
  document.addEventListener("DOMContentLoaded", onNavigate);
  setTimeout(onNavigate, 1500);
})();
