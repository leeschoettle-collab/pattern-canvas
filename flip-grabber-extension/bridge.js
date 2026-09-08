// Injected into FlipScope pages. Bridges window.postMessage <-> the extension worker
// so the page can ask the extension to grab a listing (URL or address) for it.
(function () {
  const announce = () => window.postMessage({ __flipscope_ext: "ready" }, "*");
  announce();
  document.addEventListener("DOMContentLoaded", announce);
  setTimeout(announce, 500);
  setTimeout(announce, 1500);

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || typeof d !== "object") return;

    if (d.__flipscope === "ping") { announce(); return; }

    if (d.__flipscope === "grab" && d.target && d.reqId) {
      chrome.runtime.sendMessage({ action: "grab", target: d.target }, (resp) => {
        const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : (resp && resp.error) || null;
        window.postMessage({ __flipscope: "grabResult", reqId: d.reqId, result: err ? null : resp, error: err }, "*");
      });
    }
  });
})();
