'use strict';

const yahoo = require('./providers/yahoo');
const psx = require('./providers/psx');
const sarmaaya = require('./providers/sarmaaya');
const universe = require('./universe');
const { resolve } = require('./search');
const fx = require('./fx');
const { Cache } = require('./cache');

// Quotes stay fresh for a minute but remain servable for a day - a stale price
// beats an empty cell when an upstream is throttled or the market is shut.
const quoteCache = new Cache({
  name: 'quotes',
  ttlMs: 60 * 1000,
  staleMs: 24 * 3600 * 1000,
  maxEntries: 8000,
  persist: true
});

// Symbols that resolve nowhere are remembered briefly so a bad ticker in a
// portfolio does not re-hammer every provider on every refresh.
const negativeCache = new Cache({ name: 'quotes_negative', ttlMs: 10 * 60 * 1000, maxEntries: 2000 });

const historyCache = new Cache({
  name: 'history',
  ttlMs: 6 * 3600 * 1000,
  staleMs: 7 * 24 * 3600 * 1000,
  maxEntries: 1500,
  persist: true
});

/**
 * Decide which provider chain to use.
 *
 * This replaces `isPakistaniAsset()`, which classified any 3-7 character ticker
 * not on a 12-item blocklist as Pakistani - sending NFLX, VOO and friends
 * through five Sarmaaya URLs before ever reaching Yahoo.
 */
function classify(input) {
  const raw = String(input || '').trim().toUpperCase();
  const asset = resolve(raw);

  if (asset) {
    if (asset.type === 'Pakistani Mutual Fund') return { kind: 'pk_fund', asset, symbol: asset.symbol };
    if (asset.exchange === 'PSX') return { kind: 'psx', asset, symbol: asset.symbol };
    return { kind: 'global', asset, symbol: asset.symbol };
  }

  // Explicit Pakistani suffixes still route to PSX even when unlisted locally.
  if (/\.(KA|PSX)$/.test(raw)) {
    return { kind: 'psx', asset: null, symbol: raw.replace(/\.(KA|PSX)$/, '') };
  }

  // Unknown symbol: Yahoo covers the global long tail.
  return { kind: 'global', asset: null, symbol: raw };
}

function yahooSymbolFor(route) {
  if (route.kind === 'psx') return `${route.symbol}.KA`;
  return route.asset?.yahooSymbol || route.symbol;
}

async function fetchOne(route) {
  const { kind, asset, symbol } = route;

  if (kind === 'pk_fund') {
    const quote = await sarmaaya.fundQuote({ symbol, name: asset?.name, uuid: asset?.uuid });
    if (quote) return quote;
    return null;
  }

  if (kind === 'psx') {
    // The exchange first: Yahoo's PSX feed was measurably wrong during the
    // audit (OGDC 131.87 vs a true 319.79), so it is a last resort here.
    const fromPsx = await psx.quote(symbol);
    if (fromPsx) return { ...fromPsx, symbol, name: asset?.name || fromPsx.name };

    const fromSarmaaya = await sarmaaya.stockQuote(symbol);
    if (fromSarmaaya) return { ...fromSarmaaya, symbol, name: asset?.name || fromSarmaaya.name };

    return null;
  }

  const viaChart = await yahoo.chartQuote(yahooSymbolFor(route));
  if (viaChart) return { ...viaChart, symbol };
  return null;
}

/**
 * Convert a quote into USD unless it is already USD or PKR.
 *
 * The native figures are kept alongside so the original listing price stays
 * visible and auditable rather than being silently overwritten.
 */
async function toDisplayCurrency(quote) {
  if (!quote || !fx.needsUsdConversion(quote.currency)) return quote;

  const rate = await fx.getUsdRate(quote.currency);
  if (!rate || !(rate > 0)) {
    // Better to hand back the honest native figure than a wrong dollar one.
    console.warn(`[quotes] no USD rate for ${quote.currency}; leaving ${quote.symbol} native`);
    return quote;
  }

  return {
    ...quote,
    price: quote.price * rate,
    previousClose: (quote.previousClose ?? quote.price) * rate,
    change: (quote.change || 0) * rate,
    changePercent: quote.changePercent,
    currency: 'USD',
    nativeCurrency: String(quote.currency).toUpperCase(),
    nativePrice: quote.price,
    fxRate: rate
  };
}

/** Convert a daily series into USD at each day's own rate. */
async function historyToDisplayCurrency(entry) {
  if (!entry || !fx.needsUsdConversion(entry.currency)) return entry;

  const native = String(entry.currency).toUpperCase();
  const series = await fx.getUsdSeries(native);

  if (!series) {
    // No daily series - a single current rate still beats treating pounds as
    // dollars, though it flattens historical FX movement.
    const rate = await fx.getUsdRate(native);
    if (!rate) return entry;
    return {
      ...entry,
      currency: 'USD',
      nativeCurrency: native,
      history: entry.history.map((p) => ({ ...p, price: p.price * rate, adjClose: p.adjClose * rate })),
      fxApproximated: true
    };
  }

  const keys = Object.keys(series).sort();
  return {
    ...entry,
    currency: 'USD',
    nativeCurrency: native,
    history: entry.history.map((p) => {
      const rate = fx.rateOn(series, p.date, keys) || 1;
      return { ...p, price: p.price * rate, adjClose: p.adjClose * rate };
    })
  };
}

/** Single quote with cache, in-flight dedup and negative caching. */
async function getQuote(input) {
  const route = classify(input);
  const key = `${route.kind}:${route.symbol}`;

  if (negativeCache.get(key)) return null;

  const cached = quoteCache.peek(key);
  if (cached && cached.fresh) return cached.value;

  const value = await quoteCache.wrap(key, async () => toDisplayCurrency(await fetchOne(route)));
  if (!value) negativeCache.set(key, true);
  return value;
}

/**
 * Batch quotes.
 *
 * Global symbols are grouped into a single authenticated Yahoo call rather than
 * one request per symbol - the old frontend fired N parallel /api/quote calls,
 * each of which risked a 429. Pakistani assets fan out to their own providers
 * with bounded concurrency.
 */
async function getQuotes(inputs = []) {
  const raw = [...new Set(inputs.map((s) => String(s || '').trim()).filter(Boolean))];
  if (raw.length === 0) return {};

  const out = {};
  const routes = new Map();

  for (const input of raw) {
    const route = classify(input);
    routes.set(input, route);

    const key = `${route.kind}:${route.symbol}`;
    const cached = quoteCache.peek(key);
    if (cached && cached.fresh) out[input.toUpperCase()] = cached.value;
  }

  const pending = raw.filter((i) => !(i.toUpperCase() in out));
  const globals = pending.filter((i) => routes.get(i).kind === 'global');
  const locals = pending.filter((i) => routes.get(i).kind !== 'global');

  // One Yahoo round trip for every international symbol.
  if (globals.length > 0) {
    const wanted = globals.map((i) => ({ input: i, ySym: yahooSymbolFor(routes.get(i)) }));
    let batch = {};
    try {
      batch = await yahoo.batchQuotes(wanted.map((w) => w.ySym));
    } catch (err) {
      console.warn(`[quotes] batch failed: ${err.message}`);
    }

    const missed = [];
    const converted = await Promise.all(
      wanted.map(async ({ input, ySym }) => {
        const hit = batch[ySym.toUpperCase()];
        if (!hit) return { input, value: null };
        const route = routes.get(input);
        const value = await toDisplayCurrency({ ...hit, symbol: route.symbol });
        return { input, value };
      })
    );

    for (const { input, value } of converted) {
      if (value) {
        const route = routes.get(input);
        quoteCache.set(`${route.kind}:${route.symbol}`, value);
        out[input.toUpperCase()] = value;
      } else {
        missed.push(input);
      }
    }

    // Anything the batch could not answer gets an individual attempt.
    await mapLimit(missed, 4, async (input) => {
      const value = await getQuote(input);
      if (value) out[input.toUpperCase()] = value;
    });
  }

  await mapLimit(locals, 5, async (input) => {
    const value = await getQuote(input);
    if (value) out[input.toUpperCase()] = value;
  });

  return out;
}

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      try {
        await fn(item);
      } catch (err) {
        console.warn(`[quotes] task failed for ${item}: ${err.message}`);
      }
    }
  });
  await Promise.all(workers);
}

// Range -> lookback in days. Working in days matters: an earlier version
// converted to years and rounded up, so 1mo/3mo/6mo all collapsed into a full
// year of data.
const RANGE_DAYS = {
  '1d': 1,
  '5d': 5,
  '1mo': 31,
  '3mo': 92,
  '6mo': 183,
  '1y': 366,
  '2y': 731,
  '5y': 1827,
  '10y': 3653,
  ytd: null,
  max: null
};

function trimHistory(entry, range) {
  if (!entry || !Array.isArray(entry.history)) return entry;

  let cutoffStr;
  if (range === 'ytd') {
    cutoffStr = `${new Date().getUTCFullYear()}-01-01`;
  } else {
    const days = RANGE_DAYS[range];
    if (!days) return entry;
    const cutoff = new Date(Date.now() - days * 86400000);
    cutoffStr = cutoff.toISOString().split('T')[0];
  }

  return { ...entry, history: entry.history.filter((p) => p.date >= cutoffStr) };
}

/**
 * Daily history, routed the same way as quotes.
 *
 * PSX and Sarmaaya both hand back a full series regardless of what we ask for,
 * so those are fetched and cached once per symbol and then trimmed locally -
 * switching graph ranges costs nothing upstream. Yahoo honours the range, so
 * it stays keyed per range.
 */
async function getHistory(input, range = '5y') {
  const route = classify(input);
  const servesFullSeries = route.kind === 'psx' || route.kind === 'pk_fund';
  const key = servesFullSeries
    ? `${route.kind}:${route.symbol}|full`
    : `${route.kind}:${route.symbol}|${range}`;

  const entry = await historyCache.wrap(key, async () => {
    if (route.kind === 'pk_fund') {
      const fromApi = await sarmaaya.fundNavHistory(route.asset?.uuid, 'infinity');
      if (!fromApi) return null;
      return {
        ...fromApi,
        symbol: route.symbol,
        name: fromApi.name || route.asset?.name || route.symbol
      };
    }

    if (route.kind === 'psx') {
      const fromPsx = await psx.history(route.symbol);
      if (fromPsx && fromPsx.history.length > 0) return { ...fromPsx, symbol: route.symbol };
      const fromYahoo = await yahoo.history(`${route.symbol}.KA`, 'max');
      if (fromYahoo) return { ...fromYahoo, symbol: route.symbol };
      return null;
    }

    const fromYahoo = await yahoo.history(yahooSymbolFor(route), range);
    return fromYahoo ? { ...fromYahoo, symbol: route.symbol } : null;
  });

  if (!entry) return null;
  const trimmed = servesFullSeries ? trimHistory(entry, range) : entry;
  return historyToDisplayCurrency(trimmed);
}

async function getHistoryBatch(inputs = [], range = '5y') {
  const unique = [...new Set(inputs.map((s) => String(s || '').trim()).filter(Boolean))];
  const results = {};
  await mapLimit(unique, 4, async (input) => {
    const entry = await getHistory(input, range);
    if (entry && entry.history && entry.history.length > 0) results[input.toUpperCase()] = entry;
  });
  return results;
}

function stats() {
  return {
    quotes: quoteCache.stats(),
    history: historyCache.stats(),
    negative: negativeCache.stats()
  };
}

module.exports = { getQuote, getQuotes, getHistory, getHistoryBatch, classify, stats, quoteCache, historyCache };
