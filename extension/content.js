(function () {
  "use strict";
  const api = typeof browser !== "undefined" ? browser : chrome;

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
        api.storage.local.set({ ["musical:" + id]: rec }).then(() => {
          currentRecord = rec;
          currentLineIdx = -1;
          btnEl.textContent = "🎵 musical ✓";
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
