// FlipScope — Grab Listing  (v1.3)
// 1) Click the toolbar icon on a listing page → grab photos + facts → open FlipScope.
// 2) From FlipScope, paste a link OR type an address → this opens it in a background
//    tab, grabs the photos, closes the tab, and hands the result back.

const DEFAULT_URL = "https://leeschoettle.com/flipscope.html";

async function flipscopeUrl() {
  try {
    const s = await chrome.storage.sync.get("flipscopeUrl");
    return (s && s.flipscopeUrl) || DEFAULT_URL;
  } catch (e) {
    return DEFAULT_URL;
  }
}

console.log("[flipscope] service worker loaded");
chrome.runtime.onInstalled.addListener(() => console.log("[flipscope] installed"));

/* ─────────────── toolbar icon ─────────────── */
chrome.action.onClicked.addListener((tab) => {
  handleClick(tab).catch((e) => {
    console.error("[flipscope] handleClick failed:", e);
    openAnalyzer(tab && tab.url, null);
  });
});

async function handleClick(tab) {
  if (!tab || !tab.id || !/^https?:/i.test(tab.url || "")) {
    notify("Open a property listing in this tab first, then click the icon.");
    return;
  }
  let result = null;
  try {
    const out = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractListing });
    result = out && out[0] && out[0].result;
  } catch (e) { console.error("[flipscope] executeScript failed:", e); }
  openAnalyzer(tab.url, result && result.photos && result.photos.length ? result : null);
}

async function openAnalyzer(listingUrl, result) {
  let hash = "";
  if (result) hash = "#import=" + encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(result)))));
  else if (listingUrl) hash = "#url=" + encodeURIComponent(listingUrl);
  const base = await flipscopeUrl();
  chrome.tabs.create({ url: base + hash }).catch((e) => {
    console.error("[flipscope] tabs.create failed:", e);
    notify("Couldn't open FlipScope at " + base + " — check the URL in the extension options.");
  });
}

/* ─────────────── messages from the FlipScope page (via bridge.js) ─────────────── */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === "grab" && msg.target) {
    grabTarget(String(msg.target).trim())
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ error: e && e.message || String(e) }));
    return true; // async response
  }
});

async function grabTarget(target) {
  const isUrl = /^https?:\/\//i.test(target);
  const candidates = isUrl
    ? [target]
    : [
        "https://www.zillow.com/homes/" + encodeURIComponent(target) + "_rb/",
        "https://www.redfin.com/stingray/do/query-location?al=1&location=" + encodeURIComponent(target),
      ];

  let last = { photos: [], facts: {} };
  for (const url of candidates) {
    try {
      const res = await grabInBackgroundTab(url);
      if (res && res.photos && res.photos.length) return res;
      if (res && Object.keys(res.facts || {}).length > Object.keys(last.facts).length) last = res;
    } catch (e) { console.warn("[flipscope] grab failed for", url, e.message); last = last.error ? last : { ...last, error: e.message }; }
  }
  return last;
}

async function grabInBackgroundTab(url) {
  const origin = new URL(url).origin + "/*";
  const has = await chrome.permissions.contains({ origins: [origin] }).catch(() => false);
  if (!has) {
    // request is best-effort; if it needs a gesture and fails, executeScript still works
    // for hosts already in the manifest (zillow/redfin/realtor/etc.)
    await chrome.permissions.request({ origins: [origin] }).catch(() => {});
  }
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForComplete(tab.id, 30000);
    await sleep(2800);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { for (let y = 0; y < 7000; y += 500) window.scrollTo(0, y); window.scrollTo(0, 0); },
    }).catch(() => {});
    await sleep(1500);
    const out = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractListing });
    const result = out && out[0] && out[0].result;
    return result || { photos: [], facts: {} };
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function waitForComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(onUpd); resolve(); };
    const onUpd = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((t) => { if (t && t.status === "complete") finish(); }).catch(() => {});
    setTimeout(finish, timeoutMs);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function notify(message) {
  try {
    chrome.notifications.create("", { type: "basic", iconUrl: chrome.runtime.getURL("icon48.png"), title: "FlipScope", message });
  } catch (e) { console.warn("[flipscope] notify failed:", e, message); }
}

/* ─────────────── runs inside the listing page (isolated world, no CSP limits) ─────────────── */
function extractListing() {
  var H = document.documentElement.outerHTML;
  var pics = [], seen = {};
  var BAD = /logo|sprite|icon|favicon|avatar|headshot|agent|broker|badge|map|staticmap|street[_-]?view|mapbox|placeholder|walkscore|schools|\/ads?\/|profile-photo|user-photo/i;
  var add = function (u) {
    if (!u || typeof u !== "string" || u.indexOf("data:") === 0 || BAD.test(u)) return;
    var stem = u.split("/").pop().split("?")[0].toLowerCase()
      .replace(/^genmid\./, "").replace(/[-_]p_[a-z]\b/, "").replace(/[-_]cc_ft_\d+/, "")
      .replace(/[-_](mbpaddedwide|mbpaddedwh|bigphoto|islphoto|\d{2,4}x\d{2,4})/g, "")
      .replace(/\.(jpe?g|png|webp|avif)$/, "").replace(/_\d{1,2}$/, "");
    if (stem.length < 4 || seen[stem]) return;
    seen[stem] = 1; pics.push(u);
  };
  [
    /https?:\/\/photos\.zillowstatic\.com\/fp\/[a-z0-9]+-[a-z_0-9]+\.(?:jpg|jpeg|webp|png)/gi,
    /https?:\/\/(?:ssl\.)?cdn-redfin\.com\/photo\/\d+\/[a-z0-9.]+\/\d+\/[\w.\-]+\.(?:jpg|jpeg|webp|png)/gi,
    /https?:\/\/[\w.\-]*rdcpix\.com\/[\w.\/\-]+\.(?:jpg|jpeg|webp|png)/gi,
    /https?:\/\/[\w.\-]*(?:trulia|compass|homesnap|homescdn|listinglogic)[\w.\-]*\/[\w.\/\-]+\.(?:jpg|jpeg|webp|png)/gi
  ].forEach(function (re) { (H.match(re) || []).forEach(function (u) { add(u.replace(/\\u002F/g, "/").replace(/\\\//g, "/")); }); });
  if (pics.length < 3) {
    [].forEach.call(document.images, function (im) { if ((im.naturalWidth || 0) >= 500) add(im.currentSrc || im.src); });
    [].forEach.call(document.querySelectorAll('[style*="background-image"]'), function (el) {
      var m = /url\(["']?([^"')]+)/.exec(el.getAttribute("style") || ""); if (m) add(m[1]);
    });
  }
  var idc = {};
  pics.forEach(function (u) { var m = /[\/.](\d{6,})_/.exec(u); if (m) idc[m[1]] = (idc[m[1]] || 0) + 1; });
  var domId = Object.keys(idc).sort(function (a, b) { return idc[b] - idc[a]; })[0];
  if (domId && idc[domId] >= 3) pics = pics.filter(function (u) { return u.indexOf(domId) > -1 || !/[\/.]\d{6,}_/.test(u); });

  var f = {};
  var mt = function (p) { var e = document.querySelector('meta[property="' + p + '"]'); return e ? e.content : ""; };
  var ogt = mt("og:title") || document.title, ogd = mt("og:description");
  var tt = ogt.replace(/\s*[-|]\s*\d+\s*beds?.*/i, "").replace(/\s*\|.*/, "").trim();
  var am = /^(.+?),\s*([A-Za-z .'\-]+),\s*([A-Z]{2})\s*(\d{5})/.exec(tt) ||
           /([\dA-Za-z][^,]*?),\s*([A-Za-z .'\-]+),\s*([A-Z]{2})\s*(\d{5})/.exec(ogd);
  if (am) { f.address = am[1].trim(); f.city = am[2].trim(); f.state = am[3]; f.zip = am[4]; }
  var src = (ogd + " " + document.body.innerText.slice(0, 4000)).replace(/\s+/g, " ");
  var bm = /(\d+(?:\.\d+)?)\s*(?:bd\b|beds?\b)\D{0,6}(\d+(?:\.\d+)?)\s*(?:ba\b|baths?\b)\D{0,10}([\d,]{3,})\s*(?:sq)/i.exec(src);
  if (bm) { f.beds = +bm[1]; f.baths = +bm[2]; f.sqft = +bm[3].replace(/,/g, ""); }
  var pm = /\$\s?([\d,]{5,})/.exec(ogd); if (pm) f.listPrice = +pm[1].replace(/,/g, "");
  var ym = /(?:built in|year built|yr\.? built)\D{0,6}((?:18|19|20)\d{2})/i.exec(src); if (ym) f.yearBuilt = +ym[1];

  return { photos: pics.slice(0, 40), facts: f, url: location.href };
}
