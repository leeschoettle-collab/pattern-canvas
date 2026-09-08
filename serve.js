const http       = require('http');
const https      = require('https');
const fs         = require('fs');
const path       = require('path');

const PORT       = process.env.PORT || 3456;
const ROOT       = __dirname;
const CREDS_FILE = path.join(__dirname, '.propstream-creds.json');
const COMPS_FILE = path.join(__dirname, 'propstream-comps.json');

const MIME = {
  '.html': 'text/html', '.css': 'text/css',
  '.js': 'application/javascript', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
};

// ── In-memory cache ───────────────────────────────────────────────────────────
const apiCache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000;
function getCached(k) {
  const e = apiCache.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { apiCache.delete(k); return null; }
  return e.data;
}
function setCache(k, data) { apiCache.set(k, { data, ts: Date.now() }); }

// ── HTTPS fetch helper ────────────────────────────────────────────────────────
function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, json: null, raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
    req.on('error', reject);
  });
}

// ── /api/save-creds  (POST) ───────────────────────────────────────────────────
async function handleSaveCreds(req, res) {
  const body = await readBody(req);
  if (!body.email || !body.password) return send(res, 400, { error: 'email and password required' });
  fs.writeFileSync(CREDS_FILE, JSON.stringify({ email: body.email, password: body.password }, null, 2));
  send(res, 200, { ok: true });
}

// ── /api/creds-status (GET) ───────────────────────────────────────────────────
function handleCredsStatus(res) {
  const exists = fs.existsSync(CREDS_FILE);
  let email = null;
  if (exists) {
    try { email = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')).email; } catch(e) {}
  }
  send(res, 200, { saved: exists, email });
}

// ── /api/propstream-comps (GET) — run scraper on-demand ──────────────────────
let scraperRunning = false;
async function handlePropstreamComps(reqUrl, res) {
  const params  = new URL('http://localhost' + reqUrl).searchParams;
  const address = params.get('address') || '';
  const city    = params.get('city')    || '';
  const state   = params.get('state')   || 'UT';
  const zip     = params.get('zip')     || '';
  const force   = params.get('force') === '1';

  if (!fs.existsSync(CREDS_FILE)) {
    return send(res, 200, { error: 'no_creds', message: 'PropStream credentials not saved yet' });
  }

  // Check on-disk cache first (7-day TTL)
  const cacheKey = `${address}|${zip}`.toLowerCase().replace(/\s+/g,'-');
  const diskCache = fs.existsSync(COMPS_FILE) ? JSON.parse(fs.readFileSync(COMPS_FILE,'utf8')) : {};
  if (!force && diskCache[cacheKey] && (Date.now() - diskCache[cacheKey].ts) < 7 * 86400000) {
    return send(res, 200, { source: 'cache', comps: diskCache[cacheKey].comps });
  }

  if (scraperRunning) {
    return send(res, 200, { error: 'busy', message: 'Scraper already running — try again in a moment' });
  }

  scraperRunning = true;
  try {
    const creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    const puppeteer = require('puppeteer-core');
    const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

    const browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: false,  // visible so you can see/handle 2FA if needed
      args: ['--no-sandbox'],
      defaultViewport: { width: 1280, height: 900 },
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(30000);

    let comps = [];
    try {
      // ── Step 1: Login ────────────────────────────────────────────────────────
      await page.goto('https://app.propstream.com/', { waitUntil: 'networkidle2', timeout: 30000 });

      // Dismiss any cookie/modal banners
      try { await page.click('[aria-label="Close"], .close-btn, .modal-close', { timeout: 3000 }); } catch(e){}

      await page.waitForSelector('input[type="email"], input[name="username"], input[name="email"]', { timeout: 15000 });
      await page.type('input[type="email"], input[name="username"], input[name="email"]', creds.email, { delay: 40 });
      await page.type('input[type="password"]', creds.password, { delay: 40 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
        page.keyboard.press('Enter'),
      ]);

      // Wait for dashboard to load
      await new Promise(r => setTimeout(r, 2000));

      // ── Step 2: Intercept comps API calls ────────────────────────────────────
      let capturedComps = null;
      page.on('response', async response => {
        const url = response.url();
        if (response.status() === 200 &&
            (url.toLowerCase().includes('comp') || url.includes('comparable') || url.includes('similar')) &&
            !url.includes('.css') && !url.includes('.js')) {
          try {
            const json = await response.json();
            const list = Array.isArray(json) ? json
                       : (json.comps || json.comparables || json.data || json.results || []);
            if (list.length > 0) capturedComps = list;
          } catch(e) {}
        }
      });

      // ── Step 3: Search the property ──────────────────────────────────────────
      const fullAddr = `${address}, ${city}, ${state} ${zip}`;
      console.log(`  Searching PropStream: ${fullAddr}`);

      // Find search input — PropStream's main search bar
      const searchSel = 'input[placeholder*="search" i], input[placeholder*="address" i], input[placeholder*="property" i], .search-bar input, #searchInput';
      await page.waitForSelector(searchSel, { timeout: 15000 });
      await page.click(searchSel, { clickCount: 3 });
      await page.type(searchSel, fullAddr, { delay: 30 });
      await new Promise(r => setTimeout(r, 1500));

      // Click first autocomplete result
      const suggSel = '.autocomplete-result, .suggestion, .search-suggestion, li[role="option"], .dropdown-item';
      try {
        await page.waitForSelector(suggSel, { timeout: 5000 });
        await page.click(suggSel);
      } catch(e) {
        await page.keyboard.press('Enter');
      }
      await new Promise(r => setTimeout(r, 3000));

      // ── Step 4: Click Comps tab ──────────────────────────────────────────────
      try {
        const [compsTab] = await page.$x(
          '//button[contains(translate(text(),"COMPS","comps"),"comp")] | ' +
          '//a[contains(translate(text(),"COMPS","comps"),"comp")] | ' +
          '//span[contains(translate(text(),"COMPS","comps"),"comp")]/parent::*[@role or @tabindex]'
        );
        if (compsTab) {
          await compsTab.click();
          await new Promise(r => setTimeout(r, 4000));
        }
      } catch(e) {}

      // Wait up to 8s for comps to load
      let waited = 0;
      while (!capturedComps && waited < 8000) {
        await new Promise(r => setTimeout(r, 500));
        waited += 500;
      }

      // ── Step 5: Parse captured comps ─────────────────────────────────────────
      if (capturedComps) {
        comps = capturedComps.map(c => ({
          address:   c.address || c.streetAddress || c.formattedAddress || '',
          city:      c.city || city,
          state:     c.state || state,
          zip:       String(c.zip || c.zipCode || zip).split('.')[0],
          salePrice: parseFloat(c.salePrice || c.price || c.lastSaleAmount || 0) || null,
          saleDate:  (c.saleDate || c.soldDate || c.lastSaleDate || '').split('T')[0],
          sqft:      parseFloat(c.sqft || c.squareFootage || c.buildingSquareFeet || 0) || null,
          beds:      parseFloat(c.beds || c.bedrooms || 0) || null,
          baths:     parseFloat(c.baths || c.bathrooms || 0) || null,
          yearBuilt: parseFloat(c.yearBuilt || 0) || null,
          distance:  parseFloat(c.distance || 0) || null,
          dom:       parseFloat(c.daysOnMarket || c.dom || 0) || null,
          ppsf:      null,
        }))
        .filter(c => c.salePrice && c.salePrice > 10000)
        .map(c => ({ ...c, ppsf: c.salePrice && c.sqft ? Math.round(c.salePrice / c.sqft) : null }));
        console.log(`  ✓ Captured ${comps.length} comps for ${address}`);
      } else {
        console.log(`  ⚠ No comps captured for ${address} — PropStream UI may have changed`);
      }

    } catch(e) {
      console.error('Scraper error:', e.message);
    } finally {
      await browser.close();
      scraperRunning = false;
    }

    // Save to disk cache
    diskCache[cacheKey] = { comps, ts: Date.now(), address, city, zip };
    fs.writeFileSync(COMPS_FILE, JSON.stringify(diskCache, null, 2));

    send(res, 200, { source: 'propstream', comps });
  } catch(err) {
    scraperRunning = false;
    send(res, 200, { error: err.message, comps: [] });
  }
}

// ── /api/rentcast ─────────────────────────────────────────────────────────────
async function handleRentcast(reqUrl, res) {
  const params  = new URL('http://localhost' + reqUrl).searchParams;
  const address = params.get('address') || '';
  const city    = params.get('city')    || '';
  const state   = params.get('state')   || 'UT';
  const zip     = params.get('zip')     || '';
  const apiKey  = params.get('key')     || '';
  const count   = params.get('count')   || '10';

  if (!apiKey) return send(res, 400, { error: 'No API key provided' });

  const fullAddress = city ? `${address}, ${city}, ${state} ${zip}` : `${address}, ${state} ${zip}`;
  const cacheKey = `rc|${address}|${zip}`;
  const cached = getCached(cacheKey);
  if (cached) return send(res, 200, { source: 'cache', ...cached });

  const rcUrl = `https://api.rentcast.io/v1/avm/sale/long-term?address=${encodeURIComponent(fullAddress)}&compCount=${count}`;
  try {
    const { status, json } = await fetchJson(rcUrl, { 'X-Api-Key': apiKey, 'Accept': 'application/json' });
    if (status === 401) return send(res, 200, { error: 'Invalid Rentcast API key' });
    if (status === 402) return send(res, 200, { error: 'Rentcast monthly limit reached (50 free calls/mo)' });
    if (status === 404) return send(res, 200, { avm: null, comparables: [], error: 'Property not found in Rentcast' });
    if (status !== 200 || !json) return send(res, 200, { error: `Rentcast returned ${status}` });

    const comps = (json.comparables || []).map(c => ({
      address:     c.formattedAddress || c.address || '',
      city:        c.city  || '',
      state:       c.state || '',
      zip:         c.zipCode || '',
      salePrice:   c.price || null,
      saleDate:    (c.removedDate || c.lastSeenDate || '').split('T')[0],
      sqft:        c.squareFootage || null,
      beds:        c.bedrooms  || null,
      baths:       c.bathrooms || null,
      yearBuilt:   c.yearBuilt || null,
      distance:    c.distance !== undefined ? +c.distance.toFixed(2) : null,
      dom:         c.daysOnMarket || null,
      ppsf:        (c.price && c.squareFootage) ? Math.round(c.price / c.squareFootage) : null,
      correlation: c.correlation || null,
    }));

    const payload = {
      avm: { price: json.price || null, priceLow: json.priceRangeLow || null, priceHigh: json.priceRangeHigh || null },
      comparables: comps,
    };
    setCache(cacheKey, payload);
    send(res, 200, { source: 'rentcast', ...payload });
  } catch(err) {
    send(res, 200, { error: err.message, comparables: [] });
  }
}

// ── /api/flip/scrape (POST) — pull listing photos + facts ───────────────────
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];
const CHROME = CHROME_PATHS.find(p => { try { return fs.existsSync(p); } catch(e) { return false; } }) || CHROME_PATHS[0];
const FLIP_PROFILE = path.join(__dirname, '.chrome-flip-profile');
const REAL_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

let _stealthPuppeteer = null;
function stealthPuppeteer() {
  if (_stealthPuppeteer) return _stealthPuppeteer;
  const { addExtra } = require('puppeteer-extra');
  const pe = addExtra(require('puppeteer-core'));
  try { pe.use(require('puppeteer-extra-plugin-stealth')()); } catch(e) { console.warn('stealth plugin failed:', e.message); }
  _stealthPuppeteer = pe;
  return pe;
}

const BLOCK_RE = /request could not be satisfied|access denied|are you a human|press\s*&\s*hold|verify (?:you are|that you)|unusual traffic|detected unusual|please verify|hcaptcha|recaptcha|px-captcha|captcha-delivery|bot detection|you have been blocked|before you continue to|checking your browser/i;

// Try hard to load a real listing page past bot walls. Returns { page, browser } or throws 'blocked'.
async function openListing(url) {
  const puppeteer = stealthPuppeteer();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    userDataDir: FLIP_PROFILE,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
      '--start-maximized',
      '--window-size=1512,982',
      '--lang=en-US',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    defaultViewport: null,
  });
  try {
    const page = (await browser.pages())[0] || await browser.newPage();
    await page.setUserAgent(REAL_UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    try {
      await page.emulateTimezone('America/Denver');
      const ctx = browser.defaultBrowserContext();
      await ctx.overridePermissions(new URL(url).origin, ['geolocation']).catch(()=>{});
    } catch(e) {}
    page.setDefaultTimeout(30000);

    const isBlocked = () => page.evaluate((re) => {
      const t = (document.title + ' ' + (document.body ? document.body.innerText.slice(0, 800) : ''));
      return new RegExp(re, 'i').test(t) || document.title.trim() === '' && document.body && document.body.innerText.length < 60;
    }, BLOCK_RE.source).catch(() => false);

    const contentReady = () => page.evaluate(() => {
      // a real listing page has an og:image + a decent amount of text
      const og = document.querySelector('meta[property="og:image"]');
      return !!og && document.body && document.body.innerText.length > 1500;
    }).catch(() => false);

    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(()=>{});
      // small human-ish pause + jiggle
      await new Promise(r => setTimeout(r, 1200 + Math.random() * 1500));
      await page.mouse.move(300 + Math.random()*400, 250 + Math.random()*300).catch(()=>{});
      // wait up to ~12s for either content or a definitive block
      for (let i = 0; i < 24; i++) {
        if (await isBlocked()) {
          if (attempt < 3) { await new Promise(r => setTimeout(r, 2500 + attempt * 2000)); break; }
          throw new Error('blocked');
        }
        if (await contentReady()) { ok = true; break; }
        await new Promise(r => setTimeout(r, 500));
      }
    }
    if (!ok && await isBlocked()) throw new Error('blocked');

    // human-ish scroll to trigger lazy gallery loading
    await page.evaluate(async () => {
      for (let y = 0; y < 8000; y += 500) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 220)); }
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 400));
    }).catch(()=>{});
    await new Promise(r => setTimeout(r, 1200));
    return { page, browser };
  } catch (e) {
    await browser.close().catch(()=>{});
    throw e;
  }
}

let flipScraperRunning = false;
async function handleFlipScrape(req, res) {
  const body = await readBody(req);
  const url  = (body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return send(res, 400, { error: 'Provide a full listing URL (https://…)' });

  // Direct image URL — nothing to scrape
  if (/\.(jpe?g|png|webp|avif)(\?|$)/i.test(url)) {
    return send(res, 200, { photos: [url], facts: {}, source: 'direct-image' });
  }
  if (flipScraperRunning) return send(res, 200, { error: 'busy', message: 'Another fetch is running — try again in a moment' });

  flipScraperRunning = true;
  let browser;
  try {
    let page;
    try {
      ({ page, browser } = await openListing(url));
    } catch (e) {
      flipScraperRunning = false;
      if (e.message === 'blocked') {
        return send(res, 200, { error: 'blocked', message: 'This listing site is blocking automated access right now. Open the listing in your normal browser, download the photos, and drag them into the uploader below — everything else in the analyzer still works.', photos: [], facts: {} });
      }
      return send(res, 200, { error: e.message, photos: [], facts: {} });
    }

    const scraped = await page.evaluate(() => {
      const out = { photos: [], facts: {}, factSource: {} };
      // image buckets, most-trusted first
      const ldImgs = [], galleryImgs = [], cdnImgs = [];
      // real-estate listing photo CDNs / MLS image hosts
      const GOOD_HOST = /(zillowstatic|cdn-redfin\.com|redfincdn|ssl\.cdn-redfin|rdcpix|ap\.rdcpix|trulia|photos?\.zillow|realtor\.com\/rdc|listphotos|mlsphoto|mls-?photos|flexmls|ihouseprd|homejunction|photos\.multiplelisting|cloudfront\.net\/.*(photo|listing|media)|amazonaws\.com\/.*(photo|listing|media)|akamaized\.net\/.*(photo|media))/i;
      const BAD = /(sprite|logo|brand|badge|icon|favicon|avatar|headshot|profile|agent|broker|realtor-?photo|placeholder|blank|1x1|pixel|\bpx\b|tracking|doubleclick|adsystem|analytics|map|staticmap|street[_-]?view|streetview|mapbox|maps\.google|\/maps\/|walkscore|greatschools|schools?[-_]|neighborhood-guide|disclaimer|watermark|matterport-logo|\.gif(\?|$))/i;
      const norm = (u) => { try { return new URL(u, location.href).href; } catch(e) { return null; } };
      const consider = (bucket, u) => {
        if (!u || typeof u !== 'string' || /^data:/.test(u)) return;
        if (/\.svg(\?|$)/i.test(u) || BAD.test(u)) return;
        u = norm(u); if (!u) return;
        if (!bucket.includes(u)) bucket.push(u);
      };
      const bestFromSrcset = (ss) => {
        if (!ss) return null;
        const parts = ss.split(',').map(s => s.trim());
        let best = null, bestW = 0;
        parts.forEach(p => { const [url, w] = p.split(/\s+/); const n = parseInt(w) || 0; if (n >= bestW) { bestW = n; best = url; } });
        return best || (parts[0] || '').split(/\s+/)[0];
      };
      // plausibility-checked setters — first credible value wins
      const F = out.facts, S = out.factSource;
      const setNum = (k, v, src, lo, hi) => {
        v = parseFloat(String(v).replace(/[^0-9.]/g, ''));
        if (!isFinite(v) || v < lo || v > hi) return;
        if (F[k] == null) { F[k] = k === 'baths' ? v : Math.round(v); S[k] = src; }
      };
      const setStr = (k, v, src) => { v = (v || '').toString().trim(); if (v && F[k] == null) { F[k] = v; S[k] = src; } };
      const normAddr = s => (s || '').toLowerCase().replace(/\b(north|south|east|west|street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|circle|cir|place|pl|way|boulevard|blvd|unit|apt|#)\b/g, m => m[0]).replace(/[^a-z0-9]/g, '');

      // ---- 1. og:title / og:description — the SUBJECT property on Zillow/Redfin/Realtor.
      //        Highest trust: these tags describe the page itself, never a "nearby home".
      const ogTitle = (document.querySelector('meta[property="og:title"]') || {}).content || document.title || '';
      const ogDesc  = (document.querySelector('meta[property="og:description"]') || {}).content || '';
      const parseBBS = (txt, src) => {
        const dm = /(\d+(?:\.\d+)?)\s*(?:bd\b|beds?\b|bedrooms?\b)\W{0,5}(\d+(?:\.\d+)?)\s*(?:ba\b|baths?\b|bathrooms?\b)\W{0,8}([\d,]{3,})\s*(?:sq\.?\s?ft|sqft|square\s?feet)/i.exec(txt);
        if (dm) { setNum('beds', dm[1], src, 0, 20); setNum('baths', dm[2], src, 0, 20); setNum('sqft', dm[3], src, 200, 25000); }
      };
      {
        const tt = ogTitle.replace(/\s*[-|]\s*\d+\s*beds?.*$/i, '').replace(/\s*\|\s*(MLS.*|Redfin|Zillow|realtor\.com|Trulia|®).*/i, '').trim();
        const am = /^(.+?),\s*([A-Za-z .'\-]+),\s*([A-Z]{2})\s*(\d{5})/.exec(tt)
                || /∙\s*(.+?),\s*([A-Za-z .'\-]+),\s*([A-Z]{2})\s*(\d{5})\s*∙/.exec(ogDesc);
        if (am) { setStr('address', am[1].trim(), 'og'); setStr('city', am[2].trim(), 'og'); setStr('state', am[3], 'og'); setStr('zip', am[4], 'og'); }
        parseBBS(ogDesc, 'og');
        parseBBS(ogTitle, 'og');
        const pm = /(?:for sale|listed (?:for|at)|price)[:\s]*\$\s?([\d,]{5,})/i.exec(ogDesc)
                || /∙\s*\$\s?([\d,]{5,})\s*∙/.exec(ogDesc) || /\$\s?([\d,]{5,})/.exec(ogDesc);
        if (pm) setNum('listPrice', pm[1], 'og', 1000, 100000000);
      }

      // ---- 2. JSON-LD (schema.org) ----
      // Only top-level nodes + one level of @graph / arrays — NOT arbitrary nesting
      // (deep-walking picks up "related listings" and returns the wrong address).
      const ldNodes = [];
      const addLd = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(addLd);
        ldNodes.push(n);
        if (Array.isArray(n['@graph'])) n['@graph'].forEach(g => g && typeof g === 'object' && ldNodes.push(g));
      };
      document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
        try { addLd(JSON.parse(s.textContent)); } catch(e) {}
      });
      // rank: a node with an address + floor size is the subject property
      ldNodes.sort((a, b) => {
        const score = n => (n.address ? 2 : 0) + (n.floorSize ? 2 : 0) + (Array.isArray(n.image) ? 1 : 0)
          + (/residence|house|apartment|property|listing/i.test(n['@type'] || '') ? 2 : 0);
        return score(b) - score(a);
      });
      ldNodes.forEach(node => {
        const a0 = node.address;
        const nodeStreet = a0 && typeof a0 === 'object' && a0.streetAddress;
        // if this node names a different property than og told us, it's a "nearby home" — skip it
        if (nodeStreet && F.address && normAddr(nodeStreet) !== normAddr(F.address)) return;
        const imgs = node.image || (node.photo && [].concat(node.photo));
        if (Array.isArray(imgs)) imgs.forEach(x => consider(ldImgs, typeof x === 'string' ? x : x && x.url));
        else if (typeof imgs === 'string') consider(ldImgs, imgs);
        if (node.numberOfRooms || node.numberOfBedrooms) setNum('beds', node.numberOfBedrooms || node.numberOfRooms, 'jsonld', 0, 20);
        if (node.numberOfBathroomsTotal || node.numberOfBathrooms) setNum('baths', node.numberOfBathroomsTotal || node.numberOfBathrooms, 'jsonld', 0, 20);
        const fsz = node.floorSize && (node.floorSize.value || node.floorSize.name || node.floorSize);
        if (fsz) setNum('sqft', fsz, 'jsonld', 200, 25000);
        if (node.yearBuilt) setNum('yearBuilt', node.yearBuilt, 'jsonld', 1850, 2030);
        const price = node.offers && (node.offers.price || (node.offers[0] && node.offers[0].price));
        if (price) setNum('listPrice', price, 'jsonld', 1000, 100000000);
        const a = node.address;
        if (a && typeof a === 'object') {
          setStr('address', a.streetAddress, 'jsonld');
          setStr('city', a.addressLocality, 'jsonld');
          setStr('state', a.addressRegion, 'jsonld');
          setStr('zip', a.postalCode, 'jsonld');
        }
      });

      // ---- 3. visible page text near the top (listing header) — labeled facts only ----
      const bodyTxt = (document.body.innerText || '').slice(0, 4000);
      parseBBS(bodyTxt.replace(/\n/g, ' '), 'text');
      // Redfin/Zillow header stacks: "4 bd • 2 ba • 1,792 sq ft"
      const stk = /(\d+(?:\.\d+)?)\s*bd\b[\s\S]{0,12}?(\d+(?:\.\d+)?)\s*ba\b[\s\S]{0,12}?([\d,]{3,})\s*sq\s*ft/i.exec(bodyTxt);
      if (stk) { setNum('beds', stk[1], 'text', 0, 20); setNum('baths', stk[2], 'text', 0, 20); setNum('sqft', stk[3], 'text', 200, 25000); }
      const yrTxt = /(?:year\s*built|built\s*in|yr\.?\s*built)\D{0,8}((?:18|19|20)\d{2})/i.exec(document.body.innerText.slice(0, 12000));
      if (yrTxt) setNum('yearBuilt', yrTxt[1], 'text', 1850, 2030);
      if (F.address == null || F.zip == null) {
        const cand = (document.querySelector('h1') || {}).innerText || '';
        const m = /^\s*(.+?),\s*([A-Za-z .'-]+),\s*([A-Z]{2})\s*(\d{5})/.exec(cand);
        if (m) { setStr('address', m[1], 'title'); setStr('city', m[2], 'title'); setStr('state', m[3], 'title'); setStr('zip', m[4], 'title'); }
      }

      // ---- 4. __NEXT_DATA__ deep-walk — ONLY numeric gaps, never address (pollution risk) ----
      if (F.beds == null || F.baths == null || F.sqft == null || F.yearBuilt == null || F.listPrice == null) {
        let visited = 0;
        const deep = (n, d) => {
          if (visited++ > 300000 || !n || d > 22) return;
          if (Array.isArray(n)) { for (const x of n) deep(x, d + 1); return; }
          if (typeof n !== 'object') return;
          for (const [k, v] of Object.entries(n)) {
            const key = k.toLowerCase();
            if (v != null && typeof v !== 'object') {
              if (/^(bedrooms|beds|numbedrooms)$/.test(key)) setNum('beds', v, 'embedded', 0, 20);
              else if (/^(bathrooms|baths|numbaths|numbathrooms)$/.test(key)) setNum('baths', v, 'embedded', 0, 20);
              else if (/^(livingarea|livingareavalue|finishedsqft|sqft|squarefeet)$/.test(key)) setNum('sqft', v, 'embedded', 200, 25000);
              else if (key === 'yearbuilt') setNum('yearBuilt', v, 'embedded', 1850, 2030);
              else if (/^(price|listprice|unformattedprice)$/.test(key)) setNum('listPrice', v, 'embedded', 1000, 100000000);
            } else deep(v, d + 1);
          }
        };
        try { const nd = document.getElementById('__NEXT_DATA__'); if (nd) deep(JSON.parse(nd.textContent), 0); } catch(e) {}
      }

      // ---- 5. images ----
      // 5a. regex the raw HTML for known listing-photo CDN URLs — most reliable,
      //     bypasses lazy-loading / React hydration entirely
      const html = document.documentElement.outerHTML;
      const CDN_PATTERNS = [
        /https?:\/\/photos\.zillowstatic\.com\/fp\/[a-z0-9]+-[a-z_0-9]+\.(?:jpg|jpeg|webp|png)/gi,
        /https?:\/\/(?:ssl\.)?cdn-redfin\.com\/photo\/\d+\/[a-z0-9.]+\/\d+\/[\w.\-]+\.(?:jpg|jpeg|webp|png)/gi,
        /https?:\/\/ap\.rdcpix\.com\/[\w./\-]+\.(?:jpg|jpeg|webp|png)/gi,
        /https?:\/\/[\w.\-]*rdcpix\.com\/[\w./\-]+\.(?:jpg|jpeg|webp|png)/gi,
        /https?:\/\/[\w.\-]+\/(?:photos?|media|listing|images?)\/[\w./\-]+\.(?:jpg|jpeg|webp)(?:\?[\w=&%.\-]*)?/gi,
      ];
      CDN_PATTERNS.forEach(re => { const mm = html.match(re) || []; mm.forEach(u => consider(cdnImgs, u.replace(/\\u002F/g, '/').replace(/\\\//g, '/'))); });

      // 5b. gallery/carousel/media containers
      const GSEL = '[class*="gallery" i],[class*="carousel" i],[class*="slideshow" i],[class*="media-stream" i],[class*="photo" i],[class*="Photo" i],[class*="image-grid" i],[data-testid*="photo" i],[data-testid*="gallery" i],[id*="media" i],[aria-label*="photo" i],picture,figure';
      document.querySelectorAll(GSEL).forEach(box => {
        box.querySelectorAll('img,source').forEach(img => {
          consider(galleryImgs, img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy') || img.getAttribute('data-original'));
          consider(galleryImgs, bestFromSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset')));
        });
        const bg = /url\(["']?([^"')]+)["']?\)/.exec(box.getAttribute('style') || '');
        if (bg) consider(galleryImgs, bg[1]);
      });

      // 5c. every <img> on the page (broad net)
      const anyImgs = [];
      document.querySelectorAll('img').forEach(img => {
        consider(anyImgs, img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy') || img.getAttribute('data-original'));
        consider(anyImgs, bestFromSrcset(img.getAttribute('srcset')));
      });
      document.querySelectorAll('[style*="background-image"]').forEach(el => {
        const m2 = /url\(["']?([^"')]+)["']?\)/.exec(el.getAttribute('style') || '');
        if (m2) consider(anyImgs, m2[1]);
      });

      const og = (document.querySelector('meta[property="og:image"]') || document.querySelector('meta[name="twitter:image"]') || {}).content;
      const ogUrl = og && norm(og);

      // assemble — prefer trusted sources; only widen the net if we're short
      const onGood = [...new Set([...cdnImgs, ...ldImgs, ...galleryImgs, ...anyImgs].filter(u => GOOD_HOST.test(u)))];
      let all;
      if (onGood.length >= 3) {
        all = [...ldImgs.filter(u => GOOD_HOST.test(u)), ...onGood.filter(u => !ldImgs.includes(u))];
      } else {
        all = [...new Set([ogUrl, ...ldImgs, ...cdnImgs, ...galleryImgs, ...anyImgs].filter(Boolean))];
      }
      if (ogUrl && !BAD.test(ogUrl) && all.length && !all.includes(ogUrl)) all = [ogUrl, ...all];
      out.photos = all;
      out.imgDebug = { cdn: cdnImgs.length, ld: ldImgs.length, gallery: galleryImgs.length, any: anyImgs.length, onGood: onGood.length, chosen: all.length };
      out.pageTitle = document.title || '';
      return out;
    }).catch(() => ({ photos: [], facts: {}, factSource: {} }));

    // De-dupe the same photo served at different sizes/variants, cap
    const seen = new Set();
    const photos = [];
    for (const u of scraped.photos) {
      let stem = u.split('/').pop().split('?')[0].toLowerCase()
        .replace(/^(genmid|genmidbig|genfullscreen)\./, '')
        .replace(/[-_]p_[a-z]\b/, '')
        .replace(/[-_]cc_ft_\d+/, '')
        .replace(/[-_]uncropped_scaled_within_\d+_\d+/, '')
        .replace(/[-_]\d{2,4}x\d{2,4}/, '')
        .replace(/[-_](small|medium|large|thumb|xl|xxl|full|hd|orig|scaled|mbpaddedwh|mbpaddedwide|bigphoto|islphoto)/g, '')
        .replace(/\.(jpe?g|png|webp|avif)$/, '')
        .replace(/_\d{1,2}$/, '');
      if (stem.length < 4 || seen.has(stem)) continue;
      seen.add(stem); photos.push(u);
      if (photos.length >= 30) break;
    }

    // ── Reconcile scraped facts against the URL (catches bot-block / wrong-page) ──
    const facts = scraped.facts || {};
    const factSource = scraped.factSource || {};
    let warning = null;
    let m, urlState = null, urlZip = null, urlStreet = null;
    if (m = /redfin\.com\/([A-Za-z]{2})\//i.exec(url)) urlState = m[1].toUpperCase();
    else if (m = /homedetails\/[^\/]*?-([A-Za-z]{2})-\d{5}/i.exec(url)) urlState = m[1].toUpperCase();
    else if (m = /realestateandhomes-detail\/[^\/]*?_([A-Za-z]{2})_\d{5}/i.exec(url)) urlState = m[1].toUpperCase();
    if (m = /[-_/](\d{5})(?:[-_/]|$)/.exec(url.split('?')[0])) urlZip = m[1];
    if (m = /\/([0-9][-0-9A-Za-z]*?)-\d{5}\/home\//i.exec(url)) urlStreet = m[1].replace(/-/g, ' ').trim();
    else if (m = /homedetails\/(\d+-[A-Za-z0-9-]+?)-[A-Za-z]+(?:-[A-Za-z]+)*-[A-Za-z]{2}-\d{5}/i.exec(url)) urlStreet = m[1].replace(/-/g, ' ').trim();

    const TRUSTED = new Set(['og', 'url', 'title']);
    const stateBad = urlState && facts.state && facts.state.toUpperCase() !== urlState;
    const zipBad = urlZip && facts.zip && facts.zip !== urlZip;
    if (stateBad || zipBad) {
      // the authoritative zip/state (from the URL) disagrees with what we scraped.
      // keep only fields that came from the page's own og:/title tags; drop the rest.
      let dropped = 0;
      ['address','city','state','zip','beds','baths','sqft','yearBuilt','listPrice'].forEach(k => {
        if (!TRUSTED.has(factSource[k])) { delete facts[k]; delete factSource[k]; dropped++; }
      });
      if (dropped) warning = `The listing site served a block page or a "nearby homes" record instead of this property, so most facts were discarded — enter them yourself. (Photos are usually still correct.)`;
    }
    if (urlStreet && !facts.address) { facts.address = urlStreet; factSource.address = 'url'; }
    if (urlState && !facts.state)    { facts.state = urlState;    factSource.state = 'url'; }
    if (urlZip && !facts.zip)        { facts.zip = urlZip;        factSource.zip = 'url'; }

    send(res, 200, { photos, facts, factSource, warning, imgDebug: scraped.imgDebug || null, pageTitle: scraped.pageTitle || null, source: 'scrape', count: photos.length });
  } catch (err) {
    send(res, 200, { error: err.message, photos: [], facts: {} });
  } finally {
    if (browser) await browser.close().catch(()=>{});
    flipScraperRunning = false;
  }
}

// ── Main server ───────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); return res.end(); }
  if (req.method === 'POST' && req.url === '/api/save-creds') return handleSaveCreds(req, res);
  if (req.url === '/api/creds-status')                         return handleCredsStatus(res);
  if (req.url.startsWith('/api/propstream-comps'))             return handlePropstreamComps(req.url, res);
  if (req.url.startsWith('/api/rentcast'))                     return handleRentcast(req.url, res);
  if (req.method === 'POST' && req.url === '/api/flip/scrape') return handleFlipScrape(req, res);

  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, urlPath);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Serving on http://localhost:${PORT}`));
