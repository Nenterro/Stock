'use strict';

const { RequestLane, getJson } = require('./http');
const yahoo = require('./providers/yahoo');
const { Cache, store } = require('./cache');

const lane = new RequestLane({ name: 'fx', minGapMs: 100, concurrency: 2 });

const FALLBACK_RATES = { USD: 1, PKR: 278.0, EUR: 0.92, GBP: 0.78, CAD: 1.36, AED: 3.67, SAR: 3.75, INR: 83.5 };

const ratesCache = new Cache({
  name: 'fx_rates',
  ttlMs: 60 * 60 * 1000,
  staleMs: 7 * 24 * 3600 * 1000,
  maxEntries: 8,
  persist: true
});

/** Latest USD-based rates, with a persisted fallback so we never return nothing. */
async function getRates() {
  const value = await ratesCache.wrap('usd', async () => {
    const primary = await getJson(lane, 'https://open.er-api.com/v6/latest/USD', { timeout: 10000 });
    if (primary?.rates && typeof primary.rates.PKR === 'number') {
      return { base: 'USD', rates: primary.rates, source: 'er-api' };
    }

    const pkr = await yahoo.chartQuote('PKR=X');
    if (pkr?.price > 0) {
      return { base: 'USD', rates: { ...FALLBACK_RATES, PKR: pkr.price }, source: 'yahoo' };
    }
    return null;
  });

  return value || { base: 'USD', rates: FALLBACK_RATES, source: 'fallback' };
}

let fxSeries = null;
let fxSeriesAt = 0;
const FX_SERIES_TTL = 6 * 3600 * 1000;

/** Daily USD->PKR series, persisted so a restart keeps the graph populated. */
async function getFxSeries() {
  const now = Date.now();
  if (fxSeries && now - fxSeriesAt < FX_SERIES_TTL) return fxSeries;

  const entry = await yahoo.history('PKR=X', '10y');
  if (entry?.history?.length > 0) {
    const map = {};
    for (const point of entry.history) map[point.date] = point.price;
    fxSeries = map;
    fxSeriesAt = now;
    store.write('fx_series', { series: map, at: now });
    return map;
  }

  if (!fxSeries) {
    const snapshot = store.read('fx_series');
    if (snapshot?.series) {
      fxSeries = snapshot.series;
      fxSeriesAt = snapshot.at || 0;
    }
  }
  return fxSeries || {};
}

/** Rate for a specific date, falling back to the closest preceding trading day. */
async function getHistoricalRate(dateStr) {
  const map = await getFxSeries();
  const keys = Object.keys(map);
  if (keys.length === 0) return FALLBACK_RATES.PKR;

  if (dateStr && map[dateStr]) return map[dateStr];

  const sorted = keys.sort();
  if (!dateStr) return map[sorted[sorted.length - 1]];

  let lo = 0;
  let hi = sorted.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= dateStr) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best >= 0) return map[sorted[best]];
  return map[sorted[0]];
}

module.exports = { getRates, getFxSeries, getHistoricalRate, FALLBACK_RATES };

/* -------------------------------------------------------------------------- */
/* Converting foreign listings into USD                                        */
/* -------------------------------------------------------------------------- */

/**
 * The app displays in USD or PKR only, and its converter understands just that
 * pair - anything else used to pass through untouched, so a GBP price was
 * silently counted as though it were dollars. Everything that is not already
 * USD or PKR is therefore converted to USD here, at the edge, before the rest
 * of the system sees it.
 */
const PASS_THROUGH = new Set(['USD', 'PKR']);

function needsUsdConversion(currency) {
  const c = String(currency || 'USD').toUpperCase();
  return c !== '' && !PASS_THROUGH.has(c);
}

const usdRateCache = new Cache({
  name: 'fx_to_usd',
  ttlMs: 60 * 60 * 1000,
  staleMs: 30 * 24 * 3600 * 1000,
  maxEntries: 64,
  persist: true
});

/** Value of one unit of `currency` in USD. */
async function getUsdRate(currency) {
  const c = String(currency || 'USD').toUpperCase();
  if (!needsUsdConversion(c)) return 1;

  const rate = await usdRateCache.wrap(c, async () => {
    // Direct pair first - it is the most accurate and Yahoo carries every
    // major currency as {CUR}USD=X.
    const pair = await yahoo.chartQuote(`${c}USD=X`);
    if (pair?.price > 0) return pair.price;

    // Fall back to inverting the USD-based table.
    const { rates } = await getRates();
    const inverse = rates && rates[c];
    if (typeof inverse === 'number' && inverse > 0) return 1 / inverse;
    return null;
  });

  return rate || null;
}

const usdSeriesCache = new Map();
const USD_SERIES_TTL = 6 * 3600 * 1000;

/**
 * Daily {currency}->USD series, so a historical price is converted at the rate
 * that applied on its own day rather than today's.
 */
async function getUsdSeries(currency) {
  const c = String(currency || 'USD').toUpperCase();
  if (!needsUsdConversion(c)) return null;

  const cached = usdSeriesCache.get(c);
  if (cached && Date.now() - cached.at < USD_SERIES_TTL) return cached.map;

  const entry = await yahoo.history(`${c}USD=X`, '10y');
  if (!entry?.history?.length) return cached ? cached.map : null;

  const map = {};
  for (const point of entry.history) map[point.date] = point.price;
  usdSeriesCache.set(c, { map, at: Date.now() });
  return map;
}

/**
 * Look up a rate for a specific day, carrying the last known rate forward
 * across weekends and holidays.
 */
function rateOn(series, dateStr, sortedKeys) {
  if (!series) return null;
  if (series[dateStr]) return series[dateStr];

  const keys = sortedKeys || Object.keys(series).sort();
  let lo = 0;
  let hi = keys.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] <= dateStr) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best >= 0) return series[keys[best]];
  return keys.length ? series[keys[0]] : null;
}

module.exports.needsUsdConversion = needsUsdConversion;
module.exports.getUsdRate = getUsdRate;
module.exports.getUsdSeries = getUsdSeries;
module.exports.rateOn = rateOn;

