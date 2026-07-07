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

// ── Main server ───────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/save-creds') return handleSaveCreds(req, res);
  if (req.url === '/api/creds-status')                         return handleCredsStatus(res);
  if (req.url.startsWith('/api/propstream-comps'))             return handlePropstreamComps(req.url, res);
  if (req.url.startsWith('/api/rentcast'))                     return handleRentcast(req.url, res);

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
