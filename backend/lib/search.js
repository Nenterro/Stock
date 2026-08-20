'use strict';

const universe = require('./universe');
const yahoo = require('./providers/yahoo');
const { Cache } = require('./cache');

const searchCache = new Cache({ name: 'search', ttlMs: 10 * 60 * 1000, maxEntries: 3000, persist: true, staleMs: 60 * 60 * 1000 });

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokens(s) {
  return norm(s).split(' ').filter(Boolean);
}

/**
 * Asset-class weighting so a query like "meezan" surfaces the bank and the
 * headline funds before obscure share classes, and bonds never lead.
 */
function typeWeight(asset) {
  switch (asset.type) {
    case 'PSX Stock':
      return 60;
    case 'Stock':
      return 55;
    case 'ETF':
      return 50;
    case 'Pakistani Mutual Fund':
      return 35;
    case 'Mutual Fund':
      return 30;
    case 'Crypto':
      return 25;
    case 'Index':
      return 20;
    case 'Currency':
      return 15;
    case 'Bond':
      return -40;
    default:
      return 10;
  }
}

/**
 * Score one asset against a query.
 *
 * The old implementation bucketed into exact / startsWith / contains with no
 * weighting, which is how "AMD" returned "Meezan Rozana Amdani Fund" and
 * nothing else. Scoring is now dominated by symbol matches, with name matches
 * ranked by whether they hit word boundaries.
 */
function score(asset, q, qTokens) {
  const symbol = asset.symbol.toLowerCase();
  const symbolNorm = norm(asset.symbol);
  const name = String(asset.name || '').toLowerCase();
  const nameNorm = norm(asset.name);

  let s = -Infinity;

  if (symbol === q || symbolNorm === q) s = 1000;
  else if (name === q || nameNorm === q) s = 900;
  else if (symbol.startsWith(q)) s = 800 - (symbol.length - q.length) * 4;
  else if (nameNorm.startsWith(q)) s = 700 - (nameNorm.length - q.length);
  else {
    // Every query token must appear as a word prefix somewhere in the name.
    const nameWords = tokens(asset.name);
    const allTokensHit = qTokens.every((t) => nameWords.some((w) => w.startsWith(t)));
    if (allTokensHit && qTokens.length > 0) {
      const leading = nameWords[0] && nameWords[0].startsWith(qTokens[0]) ? 80 : 0;
      s = 600 + leading - nameNorm.length * 0.3;
    } else if (symbol.includes(q)) {
      s = 400 - (symbol.length - q.length) * 3;
    } else if (nameNorm.includes(q)) {
      // Substring hits inside a word are the weakest signal - this is the
      // "Amdani" case, and it must never outrank a real symbol match.
      s = 200 - nameNorm.length * 0.2;
    } else {
      return -Infinity;
    }
  }

  s += typeWeight(asset);
  if (asset.isDebt) s -= 60;

  // Rights issues, TFCs and letters of right are tradable but are not what
  // anyone means when they search "cement" - PSX names them "Power Cement (R)"
  // or "786 Investment (Right)", and their short names were winning the
  // length tiebreak over the actual companies.
  const name_ = asset.name || '';
  if (/\((?:R|Right|Rights)\)?\s*$/i.test(name_) || /\(Right/i.test(name_)) s -= 220;
  if (/\b(tfc|sukuk|pref|modaraba certificate)\b/i.test(name_)) s -= 45;

  return s;
}

function localSearch(query, limit) {
  const q = norm(query);
  if (!q) return [];
  const qTokens = tokens(query);

  const scored = [];
  for (const asset of universe.assets) {
    // Never offer something the pricing engine cannot value.
    if (asset.unpriceable) continue;
    const s = score(asset, q, qTokens);
    if (s > -Infinity) scored.push({ asset, s });
  }

  scored.sort((a, b) => b.s - a.s || a.asset.symbol.length - b.asset.symbol.length);
  return scored.slice(0, limit).map(({ asset, s }) => ({ ...asset, _score: s }));
}

function publicShape(asset) {
  return {
    symbol: asset.symbol,
    name: asset.name,
    exchange: asset.exchange || '',
    type: asset.type || 'Stock',
    currency: asset.currency || null,
    sector: asset.sector || undefined,
    source: asset.source || 'local'
  };
}

/**
 * Hybrid search: the local index answers instantly and covers everything the
 * app cares about most; Yahoo fills in the long tail of global listings.
 *
 * Yahoo is only consulted when local results are thin, and its failures are
 * non-fatal - a throttled upstream degrades to local-only rather than an error.
 */
async function search(query, { limit = 25, includeRemote = true } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];

  const cacheKey = `${q.toLowerCase()}|${limit}|${includeRemote ? 1 : 0}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  const local = localSearch(q, limit);

  // A strong local hit set means no upstream call is needed at all.
  const strongLocal = local.filter((a) => a._score >= 600).length;
  const needRemote = includeRemote && (local.length < limit) && strongLocal < 5;

  let remote = [];
  if (needRemote) {
    try {
      remote = await yahoo.search(q, Math.min(limit, 20));
    } catch (err) {
      console.warn(`[search] remote lookup failed for "${q}": ${err.message}`);
    }
  }

  const seen = new Set(local.map((a) => a.symbol.toUpperCase()));
  const merged = local.map(publicShape);

  for (const r of remote) {
    const key = r.symbol.toUpperCase();
    if (seen.has(key)) continue;
    // Yahoo lists PSX names under .KA; prefer our own richer PSX row.
    const bare = key.replace(/\.KA$/, '');
    if (key.endsWith('.KA') && seen.has(bare)) continue;
    seen.add(key);
    merged.push(publicShape(r));
    if (merged.length >= limit) break;
  }

  const result = merged.slice(0, limit);
  searchCache.set(cacheKey, result);
  return result;
}

/**
 * Resolve a free-text ticker or name to a concrete universe asset.
 * Used by the quote path so imported CSV names still price correctly.
 */
function resolve(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const upper = raw.toUpperCase();
  const direct = universe.get(upper);
  if (direct) return direct;

  const stripped = upper.replace(/\.(KA|PSX)$/, '');
  const strippedHit = universe.get(stripped);
  if (strippedHit) return strippedHit;

  // Full names arrive from broker exports and the mutual-fund mapping.
  const q = norm(raw);
  if (!q) return null;
  let best = null;
  let bestScore = -Infinity;
  const qTokens = tokens(raw);
  for (const asset of universe.assets) {
    if (norm(asset.name) === q) return asset;
    const s = score(asset, q, qTokens);
    if (s > bestScore) {
      bestScore = s;
      best = asset;
    }
  }
  // Only trust a name-based resolution when it is a genuine match.
  return bestScore >= 600 ? best : null;
}

module.exports = { search, localSearch, resolve, searchCache };
