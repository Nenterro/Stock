'use strict';

const path = require('path');
const fs = require('fs');
const { RequestLane, getText, getJson } = require('../http');

const lane = new RequestLane({ name: 'sarmaaya', minGapMs: 80, concurrency: 4 });

const BASE = 'https://sarmaaya.pk';

// Sarmaaya's own REST API, the one its fund pages call client-side. The public
// HTML only ever renders a fund's current NAV, which is why funds previously
// had no price history at all; this exposes the full daily series.
const API = 'https://beta-restapi.sarmaaya.pk/api/mutual-funds';

function loadMapping() {
  const file = path.join(__dirname, '..', '..', 'seed', 'mf_mapping.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = {};
    for (const [name, uuid] of Object.entries(raw)) {
      // The upstream file carries a placeholder row and a few non-UUID values.
      if (!/^[0-9a-f-]{36}$/i.test(String(uuid))) continue;
      if (/^mutual fund not found$/i.test(name)) continue;
      out[name.trim()] = uuid;
    }
    return out;
  } catch (err) {
    console.warn(`[sarmaaya] mf_mapping load failed: ${err.message}`);
    return {};
  }
}

const MF_MAPPING = loadMapping();

/**
 * Build a fund's canonical symbol: an acronym plus a short slice of the fund's
 * own Sarmaaya UUID, e.g. "Meezan Islamic Fund" -> "MIF.698BAC".
 *
 * The critical property is that this depends on nothing but the fund itself.
 * An earlier version resolved acronym clashes with a counter over the whole
 * fund list, which made a symbol's meaning depend on iteration order: one new
 * fund appearing upstream shifted AISF -> AISF2 -> AISF3 and silently
 * repointed saved holdings at a different fund. Identity must never be
 * positional, because these symbols are what transactions are stored under.
 *
 * The UUID slice also disambiguates funds that share an acronym, so no
 * cross-fund coordination is needed at all.
 */
function fundSymbol(name, uuid) {
  // "Fund" is deliberately kept: Pakistani fund tickers conventionally end in
  // F (MIF, MSF, MMF), and dropping it produced ambiguous two-letter symbols.
  const stopWords = new Set(['the', 'of', 'and', 'a', 'an']);
  const words = name
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  let base = words
    .filter((w, i) => i === 0 || !stopWords.has(w.toLowerCase()))
    .map((w) => (/^[0-9]+$/.test(w) ? w : w[0].toUpperCase()))
    .join('')
    .slice(0, 8);

  if (base.length < 2) base = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase();
  if (!base) base = 'FUND';

  return `${base}.${uuidTag(uuid)}`;
}

/** The stable half of a fund symbol: six hex characters of its UUID. */
function uuidTag(uuid) {
  return String(uuid).replace(/-/g, '').slice(0, 6).toUpperCase();
}

/**
 * The full Pakistani mutual fund universe: ~480 funds that the old backend held
 * on disk but never exposed to search (only ~50 were hardcoded).
 *
 * Each entry is built independently of every other, so the list can grow or be
 * reordered upstream without any existing symbol changing meaning.
 */
function listFunds() {
  return Object.entries(MF_MAPPING).map(([name, uuid]) => ({
    symbol: fundSymbol(name, uuid),
    name,
    exchange: 'Mutual Fund',
    type: 'Pakistani Mutual Fund',
    currency: 'PKR',
    amc: name.split(/[\s-]/)[0].toUpperCase(),
    uuid,
    tag: uuidTag(uuid),
    source: 'sarmaaya'
  }));
}

function parseNav(html) {
  if (!html) return null;
  // "NAV of PKR 162.9894" is the reliable anchor on every fund page.
  // The old code fell back to a bare /Rs\s+([0-9,]+)/ which matched any rupee
  // figure anywhere on the page - a frequent source of wrong prices.
  const match =
    html.match(/NAV\s+of\s+(?:PKR|Rs\.?)\s*([0-9,]+(?:\.[0-9]+)?)/i) ||
    html.match(/NAV[^0-9a-z]{0,20}(?:PKR|Rs\.?)\s*([0-9,]+(?:\.[0-9]+)?)/i);
  if (!match) return null;
  const value = parseFloat(match[1].replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseTitle(html, fallback) {
  const raw = html?.match(/<title>([^<]+)<\/title>/i)?.[1] || '';
  const name = raw.replace(/\|.*$/, '').replace(/-\s*Sarmaaya.*$/i, '').trim();
  return name || fallback;
}

/**
 * NAV for a fund identified by its Sarmaaya UUID.
 *
 * The API is preferred over scraping: it is fresher (it carried today's NAV
 * while the rendered page still showed the previous one) and it returns the
 * prior day too, so funds get a real daily change instead of a hardcoded zero.
 * The HTML scrape stays as a fallback.
 */
async function fundQuote({ symbol, name, uuid }) {
  if (!uuid) return null;
  const upper = String(symbol || '').toUpperCase();

  const recent = await fundNavHistory(uuid, 7);
  if (recent && recent.history.length > 0) {
    const points = recent.history;
    const latest = points[points.length - 1];
    const prev = points.length > 1 ? points[points.length - 2] : latest;
    const change = latest.price - prev.price;

    return {
      symbol: upper,
      price: latest.price,
      previousClose: prev.price,
      change,
      changePercent: prev.price > 0 ? (change / prev.price) * 100 : 0,
      currency: 'PKR',
      name: recent.name || name || upper,
      exchange: 'Mutual Fund',
      asOf: latest.date,
      source: 'Sarmaaya'
    };
  }

  const html = await getText(lane, `${BASE}/mutual-funds/${encodeURIComponent(uuid)}`, {
    timeout: 12000,
    retries: 1
  });
  const nav = parseNav(html);
  if (!nav) return null;

  return {
    symbol: upper,
    price: nav,
    previousClose: nav,
    change: 0,
    changePercent: 0,
    currency: 'PKR',
    name: parseTitle(html, name || symbol),
    exchange: 'Mutual Fund',
    source: 'Sarmaaya'
  };
}

/** Quote for a PSX-listed equity - kept as a secondary to the exchange itself. */
async function stockQuote(rawSymbol) {
  const symbol = String(rawSymbol || '')
    .toUpperCase()
    .replace(/\.(KA|PSX)$/i, '')
    .trim();
  if (!symbol) return null;

  const html = await getText(lane, `${BASE}/stocks/${encodeURIComponent(symbol)}`, {
    timeout: 12000,
    retries: 1
  });
  if (!html) return null;

  const match = html.match(
    /<title>\s*([A-Z0-9._-]+)\s*-\s*Rs\.?\s*([0-9,]+(?:\.[0-9]+)?)\s*\|\s*([^|<]+)/i
  );
  if (!match) return null;

  const price = parseFloat(match[2].replace(/,/g, ''));
  if (!Number.isFinite(price) || price <= 0) return null;

  return {
    symbol,
    price,
    previousClose: price,
    change: 0,
    changePercent: 0,
    currency: 'PKR',
    name: match[3].trim().replace(/&amp;/g, '&'),
    exchange: 'PSX',
    source: 'Sarmaaya'
  };
}

/**
 * Daily NAV series for a fund, straight from Sarmaaya's API.
 *
 * `days` accepts a number or 'infinity'; the API returns newest-first, so the
 * series is reversed into the ascending order the rest of the system expects.
 */
async function fundNavHistory(uuid, days = 'infinity') {
  if (!uuid) return null;

  const payload = await getJson(
    lane,
    `${API}/nav-history/${encodeURIComponent(uuid)}?days=${encodeURIComponent(days)}`,
    { timeout: 25000, retries: 1, headers: { Accept: 'application/json' } }
  );

  const rows = payload && payload.success ? payload.response : null;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const seen = new Set();
  const history = [];
  for (const row of rows) {
    const nav = Number(row && row.nav);
    const raw = row && row.date;
    if (!raw || !Number.isFinite(nav) || nav <= 0) continue;
    const date = String(raw).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || seen.has(date)) continue;
    seen.add(date);
    history.push({ date, price: nav, adjClose: nav });
  }

  if (history.length === 0) return null;
  history.sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    currency: 'PKR',
    exchange: 'Mutual Fund',
    history,
    name: rows[0] && rows[0].fundName ? String(rows[0].fundName) : null,
    source: 'Sarmaaya'
  };
}

module.exports = {
  listFunds,
  fundQuote,
  fundNavHistory,
  stockQuote,
  fundSymbol,
  uuidTag,
  MF_MAPPING,
  lane
};
