'use strict';

const { RequestLane, CookieJar, getJson, request } = require('../http');

// Yahoo throttles aggressively: five concurrent unauthenticated chart calls all
// returned 429 during the audit. One lane, modest concurrency, enforced gap.
const lane = new RequestLane({ name: 'yahoo', minGapMs: 120, concurrency: 3, maxBackoffMs: 120000 });

const jar = new CookieJar();
let crumb = null;
let crumbAt = 0;
let crumbTask = null;
const CRUMB_TTL = 30 * 60 * 1000;

/**
 * Establish a cookie + crumb session.
 *
 * With a valid crumb, `v7/finance/quote` accepts many symbols per call and stops
 * returning 429 - this is what makes batch pricing viable.
 */
async function getCrumb(force = false) {
  const now = Date.now();
  if (!force && crumb && now - crumbAt < CRUMB_TTL) return crumb;
  if (crumbTask) return crumbTask;

  crumbTask = (async () => {
    try {
      jar.clear();
      // Any of these will hand back the consent/session cookies Yahoo wants.
      // fc.yahoo.com answers 404 but still sets the cookies we need, so the
      // jar must be attached to these seed calls, not just to the crumb call.
      for (const seed of ['https://fc.yahoo.com', 'https://finance.yahoo.com/quote/AAPL']) {
        await request(lane, seed, { timeout: 8000, retries: 1, cookieJar: jar });
        if (jar.header()) break;
      }
      const res = await request(lane, 'https://query1.finance.yahoo.com/v1/test/getcrumb', {
        timeout: 8000,
        cookieJar: jar,
        retries: 1
      });
      const token = (res.body || '').trim();
      if (token && token.length < 32 && !token.includes('<')) {
        crumb = token;
        crumbAt = Date.now();
        console.log('[yahoo] crumb session established');
        return crumb;
      }
      console.warn('[yahoo] crumb handshake returned no usable token');
      return null;
    } catch (err) {
      console.warn(`[yahoo] crumb handshake failed: ${err.message}`);
      return null;
    } finally {
      crumbTask = null;
    }
  })();

  return crumbTask;
}

/**
 * Yahoo quotes London listings in pence and labels them "GBp", not "GBP".
 * Upper-casing that blindly turns 5058 pence into 5058 pounds - a 100x
 * overvaluation of any LSE holding. Convert to the major unit so everything
 * downstream (FX, portfolio maths) sees a real GBP figure.
 */
function toMajorUnit(price, currency) {
  const raw = String(currency || 'USD');
  if (raw === 'GBp' || raw === 'GBX') {
    return { price: typeof price === 'number' ? price / 100 : price, currency: 'GBP' };
  }
  // ZAc (SA cents) and ILA (Israeli agorot) follow the same convention.
  if (raw === 'ZAc') return { price: typeof price === 'number' ? price / 100 : price, currency: 'ZAR' };
  if (raw === 'ILA') return { price: typeof price === 'number' ? price / 100 : price, currency: 'ILS' };
  return { price, currency: raw.toUpperCase() };
}

function normaliseQuote(q) {
  if (!q || typeof q.regularMarketPrice !== 'number') return null;
  const price = q.regularMarketPrice;
  const prevClose =
    typeof q.regularMarketPreviousClose === 'number' && q.regularMarketPreviousClose > 0
      ? q.regularMarketPreviousClose
      : price;
  const change =
    typeof q.regularMarketChange === 'number' ? q.regularMarketChange : price - prevClose;
  const changePercent =
    typeof q.regularMarketChangePercent === 'number'
      ? q.regularMarketChangePercent
      : prevClose > 0
        ? (change / prevClose) * 100
        : 0;

  const unit = toMajorUnit(price, q.currency);
  const scale = price > 0 ? unit.price / price : 1;

  return {
    symbol: (q.symbol || '').toUpperCase(),
    price: unit.price,
    previousClose: prevClose * scale,
    change: change * scale,
    changePercent,
    currency: unit.currency,
    name: q.longName || q.shortName || q.symbol || '',
    exchange: q.fullExchangeName || q.exchange || '',
    marketState: q.marketState || null,
    source: 'Yahoo Finance'
  };
}

/**
 * Batch quote. Accepts any number of symbols and chunks them; a single
 * authenticated call comfortably handles 50 symbols across every asset class
 * (US equity, ETF, PSX, NSE, crypto, mutual funds).
 */
async function batchQuotes(symbols = []) {
  const unique = [...new Set(symbols.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))];
  if (unique.length === 0) return {};

  const out = {};
  const CHUNK = 50;

  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    let token = await getCrumb();

    const call = async (c) => {
      const qs = new URLSearchParams({ symbols: chunk.join(',') });
      if (c) qs.set('crumb', c);
      return getJson(
        lane,
        `https://query1.finance.yahoo.com/v7/finance/quote?${qs.toString()}`,
        { timeout: 12000, cookieJar: jar, retries: 1 }
      );
    };

    let data = await call(token);

    // An expired crumb reads as an auth failure; refresh once and retry.
    if (!data?.quoteResponse?.result) {
      token = await getCrumb(true);
      data = await call(token);
    }

    const results = data?.quoteResponse?.result;
    if (Array.isArray(results)) {
      for (const q of results) {
        const norm = normaliseQuote(q);
        if (norm) out[norm.symbol] = norm;
      }
    }
  }

  return out;
}

/** Single quote via the chart endpoint - the fallback when v7 has nothing. */
async function chartQuote(rawSymbol) {
  const symbol = String(rawSymbol || '').trim().toUpperCase();
  if (!symbol) return null;

  const data = await getJson(
    lane,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
    { timeout: 10000, cookieJar: jar }
  );

  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta || typeof meta.regularMarketPrice !== 'number') return null;

  const rawPrice = meta.regularMarketPrice;
  const rawPrev = meta.previousClose || meta.chartPreviousClose || rawPrice;
  const unit = toMajorUnit(rawPrice, meta.currency);
  const scale = rawPrice > 0 ? unit.price / rawPrice : 1;
  const price = unit.price;
  const prevClose = rawPrev * scale;
  const change = price - prevClose;

  return {
    symbol,
    price,
    previousClose: prevClose,
    change,
    changePercent: prevClose > 0 ? (change / prevClose) * 100 : 0,
    currency: unit.currency,
    name: meta.longName || meta.shortName || symbol,
    exchange: meta.fullExchangeName || meta.exchangeName || '',
    source: 'Yahoo Finance'
  };
}

/**
 * Yahoo's own symbol search - the gateway to every listed instrument worldwide.
 * Results feed the search index so the app is not limited to a curated list.
 */
async function search(query, limit = 20) {
  const q = String(query || '').trim();
  if (!q) return [];

  const qs = new URLSearchParams({
    q,
    quotesCount: String(Math.min(limit, 30)),
    newsCount: '0',
    listsCount: '0',
    enableFuzzyQuery: 'true',
    quotesQueryId: 'tss_match_phrase_query'
  });

  const data = await getJson(
    lane,
    `https://query1.finance.yahoo.com/v1/finance/search?${qs.toString()}`,
    { timeout: 9000, cookieJar: jar, retries: 1 }
  );

  const quotes = data?.quotes;
  if (!Array.isArray(quotes)) return [];

  return quotes
    .filter((q2) => q2 && q2.symbol && q2.isYahooFinance !== false)
    // Options and futures contracts are noise in a portfolio tracker: a search
    // for "OGDC" was returning rows like OGC270115C00012500.
    .filter((q2) => !EXCLUDED_TYPES.has(String(q2.quoteType || '').toUpperCase()))
    .filter((q2) => !OPTION_SYMBOL.test(q2.symbol))
    .map((q2) => ({
      symbol: q2.symbol.toUpperCase(),
      name: q2.longname || q2.shortname || q2.symbol,
      exchange: q2.exchDisp || q2.exchange || '',
      type: mapQuoteType(q2.quoteType, q2.typeDisp),
      currency: null, // Yahoo search omits currency; resolved at quote time.
      region: q2.region || null,
      score: typeof q2.score === 'number' ? q2.score : 0,
      source: 'yahoo'
    }));
}

const EXCLUDED_TYPES = new Set(['OPTION', 'FUTURE', 'WARRANT']);
// e.g. OGC270115C00012500 - root + 6-digit expiry + C/P + 8-digit strike.
const OPTION_SYMBOL = /^[A-Z.]{1,6}\d{6}[CP]\d{8}$/;

function mapQuoteType(quoteType, typeDisp) {
  const t = String(quoteType || '').toUpperCase();
  if (t === 'EQUITY') return 'Stock';
  if (t === 'ETF') return 'ETF';
  if (t === 'MUTUALFUND') return 'Mutual Fund';
  if (t === 'CRYPTOCURRENCY') return 'Crypto';
  if (t === 'CURRENCY') return 'Currency';
  if (t === 'INDEX') return 'Index';
  if (t === 'FUTURE') return 'Future';
  return typeDisp || 'Stock';
}

/** Daily OHLC history. Returns { currency, history: [{ date, price, adjClose }] }. */
async function history(rawSymbol, range = '5y') {
  const symbol = String(rawSymbol || '').trim().toUpperCase();
  if (!symbol) return null;

  const data = await getJson(
    lane,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${encodeURIComponent(range)}`,
    { timeout: 20000, cookieJar: jar }
  );

  const result = data?.chart?.result?.[0];
  if (!result) return null;

  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const adjCloses = result.indicators?.adjclose?.[0]?.adjclose || [];

  const out = [];
  timestamps.forEach((ts, idx) => {
    const close = typeof closes[idx] === 'number' && closes[idx] > 0 ? closes[idx] : null;
    const adj = typeof adjCloses[idx] === 'number' && adjCloses[idx] > 0 ? adjCloses[idx] : null;
    const price = close ?? adj;
    if (price === null) return;
    out.push({
      date: new Date(ts * 1000).toISOString().split('T')[0],
      price,
      adjClose: adj ?? price
    });
  });

  if (out.length === 0) return null;

  const meta = result.meta || {};
  // Pence-quoted series must be scaled too, or the graph disagrees with the
  // live price by a factor of 100.
  const probe = toMajorUnit(1, meta.currency);
  const scale = probe.price;

  return {
    symbol,
    currency: probe.currency,
    exchange: meta.fullExchangeName || meta.exchangeName || null,
    history: scale === 1
      ? out
      : out.map((p) => ({ ...p, price: p.price * scale, adjClose: p.adjClose * scale })),
    source: 'Yahoo Finance'
  };
}

function stats() {
  return { lane: lane.stats, throttledUntil: lane.throttledUntil, hasCrumb: Boolean(crumb) };
}

module.exports = { batchQuotes, chartQuote, search, history, getCrumb, stats, lane };
