(function () {
  "use strict";
  const api = typeof browser !== "undefined" ? browser : chrome;
  const BACKEND = "http://localhost:8000";

  let currentRecord = null;
  let currentLineIdx = -1;
  let attachedVideo = null;

  let overlayEl, directEl, romanticEl, btnEl, statusEl;

  function ensureUI() {
    if (overlayEl && document.body.contains(overlayEl)) return;

    overlayEl = document.createElement("div");
    overlayEl.id = "musical-overlay";
    directEl = document.createElement("div");
    directEl.className = "musical-line musical-direct";
    romanticEl = document.createElement("div");
    romanticEl.className = "musical-line musical-romantic";
    overlayEl.append(directEl, romanticEl);

    btnEl = document.createElement("button");
    btnEl.id = "musical-trigger";
    btnEl.textContent = "🎵 musical";
    btnEl.title = "Generate poetic subtitles for this song";
    btnEl.addEventListener("click", onTrigger);

    statusEl = document.createElement("span");
    statusEl.id = "musical-status";

    document.body.append(overlayEl, btnEl, statusEl);
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
    directEl.textContent = "";
    romanticEl.textContent = "";
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
      if (t >= lines[i].start && t < lines[i].end) {
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
    directEl.textContent = ln.translation_direct || "";
    romanticEl.textContent = ln.translation_romantic || "";
    overlayEl.style.display = "block";
  }

  async function onNavigate() {
    ensureUI();
    const id = getVideoId();
    if (!id) return;
    currentRecord = await loadFromCache(id);
    if (currentRecord) {
      btnEl.textContent = "🎵 musical ✓";
      attachVideo();
    } else {
      btnEl.textContent = "🎵 musical";
      clearOverlay();
    }
  }

  async function onTrigger() {
    const id = getVideoId();
    if (!id) {
      showStatus("Open a YouTube watch page first.", true);
      return;
    }
    btnEl.disabled = true;
    showStatus("Generating… (metadata + lyrics + translation)");
    try {
      const resp = await fetch(BACKEND + "/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: location.href }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "HTTP " + resp.status);
      }
      const rec = await resp.json();
      await api.storage.local.set({ ["musical:" + id]: rec });
      currentRecord = rec;
      currentLineIdx = -1;
      btnEl.textContent = "🎵 musical ✓";
      attachVideo();
      showStatus("Done ✓");
    } catch (e) {
      showStatus("Error: " + e.message, true);
    } finally {
      btnEl.disabled = false;
    }
  }

  window.addEventListener("yt-navigate-finish", onNavigate);
  document.addEventListener("DOMContentLoaded", onNavigate);
  setTimeout(onNavigate, 1500);
})();
