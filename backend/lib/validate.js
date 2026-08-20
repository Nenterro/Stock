'use strict';

const yahoo = require('./providers/yahoo');
const { store } = require('./cache');

/**
 * Keeps the promise that anything searchable can be priced.
 *
 * PSX listings and Pakistani funds have dedicated providers, and symbols that
 * come back from Yahoo's own search are by definition ones Yahoo knows. The
 * curated international seed is the weak spot: it is hand-written, so a ticker
 * can be subtly wrong for Yahoo - "ISDU" prices nothing because London
 * listings are only addressable as "ISDU.L".
 *
 * Rather than hardcoding an exchange-suffix table (which would fail again for
 * the next venue), every seed symbol is checked against Yahoo in batches. What
 * does not price gets one repair attempt through Yahoo's search, and whatever
 * still fails is marked so search can exclude it.
 */

const CACHE_KEY = 'symbol_validation';
const TTL = 24 * 3600 * 1000;

function loadCache() {
  const saved = store.read(CACHE_KEY);
  if (saved && saved.at && Date.now() - saved.at < TTL && saved.map) return saved.map;
  return null;
}

function saveCache(map) {
  store.write(CACHE_KEY, { at: Date.now(), map });
}

/** Suffix guesses, tried before falling back to a search call. */
function candidatesFor(asset) {
  const base = String(asset.symbol || '').toUpperCase();
  const out = [];
  if (asset.yahooSymbol) out.push(String(asset.yahooSymbol).toUpperCase());
  out.push(base);
  return [...new Set(out)];
}

/**
 * Validate the given assets, returning { symbol: resolvedYahooSymbol|null }.
 * A null value means nothing could price it.
 */
async function validateSymbols(assets, { force = false } = {}) {
  if (!Array.isArray(assets) || assets.length === 0) return {};

  const cached = force ? null : loadCache();
  if (cached) {
    const covered = assets.every((a) => Object.prototype.hasOwnProperty.call(cached, a.symbol));
    if (covered) return cached;
  }

  const started = Date.now();
  const wanted = new Map(); // yahoo symbol -> [asset symbols]
  for (const asset of assets) {
    for (const cand of candidatesFor(asset)) {
      if (!wanted.has(cand)) wanted.set(cand, []);
      wanted.get(cand).push(asset.symbol);
    }
  }

  let priced = {};
  try {
    priced = await yahoo.batchQuotes([...wanted.keys()]);
  } catch (err) {
    console.warn(`[validate] batch quote failed: ${err.message}`);
    // Without upstream data, assume the existing mapping is fine rather than
    // hiding the whole seed from search.
    const passthrough = {};
    for (const a of assets) passthrough[a.symbol] = a.yahooSymbol || a.symbol;
    return passthrough;
  }

  const map = {};
  const unresolved = [];

  for (const asset of assets) {
    const hit = candidatesFor(asset).find((c) => priced[c]);
    if (hit) map[asset.symbol] = hit;
    else unresolved.push(asset);
  }

  // One repair pass: ask Yahoo what it calls this thing, then confirm the
  // answer actually prices before trusting it.
  for (const asset of unresolved) {
    let fixed = null;
    try {
      const hits = await yahoo.search(asset.name || asset.symbol, 5);
      for (const h of hits) {
        const bare = h.symbol.split('.')[0].toUpperCase();
        if (bare !== String(asset.symbol).toUpperCase()) continue;
        const check = await yahoo.batchQuotes([h.symbol]);
        if (check[h.symbol.toUpperCase()]) {
          fixed = h.symbol.toUpperCase();
          break;
        }
      }
    } catch (err) {
      console.warn(`[validate] repair lookup failed for ${asset.symbol}: ${err.message}`);
    }
    map[asset.symbol] = fixed;
    if (fixed) console.log(`[validate] repaired ${asset.symbol} -> ${fixed}`);
  }

  const dead = Object.entries(map).filter(([, v]) => !v).map(([k]) => k);
  console.log(
    `[validate] checked ${assets.length} seed symbols in ${Date.now() - started}ms` +
      (dead.length ? `; ${dead.length} unpriceable: ${dead.join(', ')}` : '; all priceable')
  );

  saveCache(map);
  return map;
}

module.exports = { validateSymbols };
