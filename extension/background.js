const api = typeof browser !== "undefined" ? browser : chrome;
const BACKEND = "http://localhost:8765";

console.log("[musical] background script loaded");

async function process(url) {
  console.log("[musical] background processing:", url);
  const resp = await fetch(BACKEND + "/process", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.detail || "HTTP " + resp.status);
  }
  return await resp.json();
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[musical] message received:", msg);
  if (msg && msg.type === "process") {
    process(msg.url).then(
      (rec) => {
        console.log("[musical] process ok, lines:", rec && rec.lines ? rec.lines.length : 0);
        sendResponse({ ok: true, rec });
      },
      (err) => {
        console.log("[musical] process error:", err && err.message);
        sendResponse({ ok: false, error: err.message })
      }
    );
    return true; // keep the channel open for the async response
  }
});
