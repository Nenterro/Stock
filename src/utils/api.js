// Dynamic Backend Server URLs with automatic local network & mobile host detection
export const getBackendUrls = () => {
  const currentHost = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  const candidateUrls = [
    'https://huz-stock.duckdns.org:8888',
    'http://192.168.18.49:3005',
    `http://${currentHost}:3005`,
    `http://${currentHost}:8888`,
    'http://localhost:3005'
  ];
  return [...new Set(candidateUrls.filter(Boolean))];
};

const FX_CACHE_KEY = 'stock_tracker_fx_rates';
const ONE_HOUR = 60 * 60 * 1000;

let lastSuccessfulBackend = null;
const NOT_FOUND = Symbol('not found');

// Generic helper to fetch from Backend Home Server with automatic failover
export async function fetchFromBackend(path, options = {}) {
  const urls = getBackendUrls();
  const { timeout = 8000, signal: callerSignal, ...fetchOptions } = options;

  // Combine the caller's abort signal with a per-attempt timeout so a slow
  // server cannot hold a request open indefinitely.
  const buildSignal = () => {
    const timeoutSignal = AbortSignal.timeout(timeout);
    if (!callerSignal) return timeoutSignal;
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([callerSignal, timeoutSignal]);
    return callerSignal;
  };

  const attempt = async (baseUrl) => {
    const url = `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const res = await fetch(url, { ...fetchOptions, signal: buildSignal() });
    // A 404 is the server answering "no such thing" (a symbol with no
    // history, a stock that is not a fund) - not a reason to try every
    // other host, which only adds timeouts.
    if (res.status === 404) return NOT_FOUND;
    if (!res.ok) return null;
    return res.json();
  };

  // Try the last known-good server first, then sweep the rest.
  const ordered = lastSuccessfulBackend
    ? [lastSuccessfulBackend, ...urls.filter(u => u !== lastSuccessfulBackend)]
    : urls;

  for (const baseUrl of ordered) {
    try {
      const data = await attempt(baseUrl);
      if (data === NOT_FOUND) {
        lastSuccessfulBackend = baseUrl;
        return null;
      }
      if (data !== null) {
        lastSuccessfulBackend = baseUrl;
        return data;
      }
    } catch (err) {
      // A caller-initiated abort means the request is obsolete - stop, don't
      // waste time trying every other candidate host.
      if (callerSignal?.aborted) throw err;
      if (baseUrl === lastSuccessfulBackend) lastSuccessfulBackend = null;
      console.warn(`Backend request to ${baseUrl} failed:`, err.message);
    }
  }
  return null;
}

// Health Check to determine backend status & active server URL
export async function checkBackendHealth() {
  const urls = getBackendUrls();
  const ordered = lastSuccessfulBackend
    ? [lastSuccessfulBackend, ...urls.filter(u => u !== lastSuccessfulBackend)]
    : urls;

  for (const baseUrl of ordered) {
    try {
      // /api/health is a cheap local check; /api/rates could hit an upstream.
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        lastSuccessfulBackend = baseUrl;
        const info = await res.json().catch(() => null);
        return {
          connected: true,
          activeUrl: baseUrl,
          universeSize: info?.universe?.total ?? null
        };
      }
    } catch (e) { /* try the next candidate */ }
  }
  return { connected: false, activeUrl: null, universeSize: null };
}

// Fetch Historical USD/PKR Exchange Rate for a specific date (YYYY-MM-DD)
export async function fetchHistoricalFxRate(dateStr) {
  if (!dateStr) return 278.0;
  const cleanDate = dateStr.split('T')[0];

  try {
    const data = await fetchFromBackend(`/api/historical-fx?date=${cleanDate}`);
    if (data && typeof data.rate === 'number' && data.rate > 0) {
      return data.rate;
    }
  } catch (err) {
    console.warn(`Historical FX fetch failed for ${cleanDate}:`, err.message);
  }

  return 278.0;
}

// Search Assets & Tickers via Home Server Backend.
// The backend indexes the full PSX listing, the Pakistani mutual fund universe
// and a global seed, then falls through to Yahoo for anything else.
export async function searchAssetsBackend(query, { limit = 25, signal } = {}) {
  if (!query || !query.trim()) return [];
  const data = await fetchFromBackend(
    `/api/search?q=${encodeURIComponent(query.trim())}&limit=${limit}`,
    { timeout: 8000, signal }
  );
  return Array.isArray(data) ? data : [];
}

// A curated starting set for the asset picker, resolved server-side against
// the live universe so every symbol offered is one the pricing engine knows.
export async function fetchPopularAssets() {
  const data = await fetchFromBackend('/api/popular', { timeout: 6000 });
  return Array.isArray(data) ? data : [];
}

// Fetch Live Exchange Rates via Home Server Backend
export async function fetchExchangeRates() {
  try {
    const cached = localStorage.getItem(FX_CACHE_KEY);
    if (cached) {
      const { rates, timestamp } = JSON.parse(cached);
      if (Date.now() - timestamp < ONE_HOUR) {
        return rates;
      }
    }

    // Try backend rates endpoint
    const backendData = await fetchFromBackend('/api/rates');
    if (backendData && backendData.rates) {
      localStorage.setItem(FX_CACHE_KEY, JSON.stringify({ rates: backendData.rates, timestamp: Date.now() }));
      return backendData.rates;
    }
  } catch (err) {
    console.warn('Backend FX fetch failed:', err);
  }

  // Default fallback rates
  return { USD: 1, PKR: 278.0, EUR: 0.92, GBP: 0.78, CAD: 1.36 };
}

// Fetch Live Market Price for a Single Symbol via Home Server Backend
export async function fetchLivePrice(symbol) {
  if (!symbol || symbol === 'CASH') return null;
  const cleanSymbol = symbol.trim().toUpperCase();

  try {
    const quoteData = await fetchFromBackend(
      `/api/quote?symbol=${encodeURIComponent(cleanSymbol)}`,
      { timeout: 15000 }
    );
    const norm = normaliseQuote(cleanSymbol, quoteData);
    if (norm) return norm;
  } catch (err) {
    console.warn(`Backend price fetch failed for ${cleanSymbol}:`, err);
  }

  return null;
}

function normaliseQuote(symbol, quote) {
  if (!quote || typeof quote.price !== 'number') return null;
  const prevClose = quote.previousClose || quote.price;
  const change = typeof quote.change === 'number' ? quote.change : quote.price - prevClose;
  const changePercent =
    typeof quote.changePercent === 'number'
      ? quote.changePercent
      : prevClose > 0
        ? (change / prevClose) * 100
        : 0;

  return {
    price: quote.price,
    previousClose: prevClose,
    change,
    changePercent,
    currency: (quote.currency || 'USD').toUpperCase(),
    name: quote.name || symbol,
    exchange: quote.exchange || '',
    source: quote.source || '',
    symbol
  };
}

// Fetch Live Prices for Multiple Symbols in a Single Round Trip.
// The backend groups international symbols into one authenticated upstream call
// and routes Pakistani assets to their own providers, so this is one request
// rather than the per-symbol fan-out it used to be.
export async function fetchBatchPrices(symbols = []) {
  const uniqueSymbols = [
    ...new Set(symbols.map(s => String(s || '').trim().toUpperCase()).filter(s => s && s !== 'CASH'))
  ];
  if (uniqueSymbols.length === 0) return {};

  try {
    const data = await fetchFromBackend(
      `/api/quotes?symbols=${encodeURIComponent(uniqueSymbols.join(','))}`,
      { timeout: 30000 }
    );

    const out = {};
    Object.entries(data?.results || {}).forEach(([sym, quote]) => {
      const norm = normaliseQuote(sym.toUpperCase(), quote);
      if (norm) out[sym.toUpperCase()] = norm;
    });
    return out;
  } catch (err) {
    console.warn('Batch price fetch failed:', err);
    return {};
  }
}

// Search ticker symbols across market via Home Server Backend
export async function searchSymbols(query, options = {}) {
  try {
    return await searchAssetsBackend(query, options);
  } catch (err) {
    console.warn(`Search failed for ${query}:`, err);
    return [];
  }
}

// Fetch Historical Daily Closes for a Single Symbol via Home Server Backend.
// Returns { currency, history: [{ date: 'YYYY-MM-DD', price }] } or null.
export async function fetchHistoricalPrices(symbol, range = '5y') {
  if (!symbol || symbol === 'CASH') return null;
  try {
    const data = await fetchFromBackend(
      `/api/history?symbol=${encodeURIComponent(symbol)}&range=${range}`,
      { timeout: 15000 }
    );
    if (data && Array.isArray(data.history) && data.history.length > 0) {
      return { currency: (data.currency || 'USD').toUpperCase(), history: data.history };
    }
  } catch (err) {
    console.warn(`Backend historical fetch failed for ${symbol}:`, err);
  }
  return null;
}

// Fetch Historical Daily Closes for Many Symbols in One Round Trip.
// Returns { TICKER: { currency, history: [...] } }
export async function fetchHistoricalPricesBatch(symbols = [], range = '5y') {
  const uniqueSymbols = [
    ...new Set(symbols.map(s => String(s || '').trim().toUpperCase()).filter(s => s && s !== 'CASH'))
  ];
  if (uniqueSymbols.length === 0) return {};

  try {
    const data = await fetchFromBackend(
      `/api/history/batch?symbols=${encodeURIComponent(uniqueSymbols.join(','))}&range=${range}`,
      { timeout: 30000 }
    );
    if (data && data.results) {
      const out = {};
      Object.entries(data.results).forEach(([ticker, entry]) => {
        if (entry && Array.isArray(entry.history) && entry.history.length > 0) {
          out[ticker.toUpperCase()] = {
            currency: (entry.currency || 'USD').toUpperCase(),
            history: entry.history
          };
        }
      });
      if (Object.keys(out).length > 0) return out;
    }
  } catch (err) {
    console.warn('Batch historical fetch failed, falling back to per-symbol:', err);
  }

  // Fallback for an older backend without /api/history/batch.
  const results = {};
  await Promise.all(
    uniqueSymbols.map(async (sym) => {
      const entry = await fetchHistoricalPrices(sym, range);
      if (entry) results[sym] = entry;
    })
  );
  return results;
}

// Fetch the historical USD->PKR daily series: { 'YYYY-MM-DD': rate }
export async function fetchFxSeries() {
  try {
    const data = await fetchFromBackend('/api/fx-series', { timeout: 15000 });
    if (data && data.series && Object.keys(data.series).length > 0) {
      return data.series;
    }
  } catch (err) {
    console.warn('Historical FX series fetch failed:', err);
  }
  return null;
}

// --- KTrade (KASB) confirmation import --------------------------------------

// Whether the backend holds working Gmail credentials for the KTrade mailbox.
export async function fetchKtradeStatus() {
  const data = await fetchFromBackend('/api/ktrade/status', { timeout: 8000 });
  return data || { configured: false, connected: false };
}

// Ask the backend to read KTrade confirmations out of Gmail and parse them.
// Returns a preview only - nothing is written to the portfolio here.
export async function scanKtradeMail({ since, max = 25 } = {}) {
  const params = new URLSearchParams({ max: String(max) });
  if (since) params.set('since', since);
  const data = await fetchFromBackend(`/api/ktrade/scan?${params.toString()}`, { timeout: 60000 });
  return data || { error: 'Backend unreachable' };
}

// Parse a confirmation PDF directly, for when Gmail is not wired up.
export async function parseKtradePdf(file) {
  const buffer = await file.arrayBuffer();
  const urls = getBackendUrls();
  const ordered = lastSuccessfulBackend
    ? [lastSuccessfulBackend, ...urls.filter(u => u !== lastSuccessfulBackend)]
    : urls;

  for (const baseUrl of ordered) {
    try {
      const res = await fetch(`${baseUrl}/api/ktrade/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: buffer,
        signal: AbortSignal.timeout(30000)
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data) {
        lastSuccessfulBackend = baseUrl;
        return data;
      }
      if (data?.error) return data;
    } catch (err) {
      console.warn(`KTrade parse via ${baseUrl} failed:`, err.message);
    }
  }
  return { error: 'Could not reach the backend to parse that PDF' };
}

// --- Research: fundamentals, fund look-through, technicals, screener -------

const toCsv = (symbols) =>
  [...new Set(symbols.map((s) => String(s || '').trim().toUpperCase()).filter((s) => s && s !== 'CASH'))].join(',');

export async function fetchFundamentals(symbol) {
  return fetchFromBackend(`/api/fundamentals?symbol=${encodeURIComponent(symbol)}`, { timeout: 30000 });
}

export async function fetchFundamentalsBatch(symbols = []) {
  if (!symbols.length) return {};
  const data = await fetchFromBackend(`/api/fundamentals/batch?symbols=${encodeURIComponent(toCsv(symbols))}`, { timeout: 90000 });
  return data?.results || {};
}

export async function fetchFundHoldings(symbol) {
  return fetchFromBackend(`/api/holdings?symbol=${encodeURIComponent(symbol)}`, { timeout: 30000 });
}

export async function fetchFundHoldingsBatch(symbols = []) {
  if (!symbols.length) return {};
  const data = await fetchFromBackend(`/api/holdings/batch?symbols=${encodeURIComponent(toCsv(symbols))}`, { timeout: 90000 });
  return data?.results || {};
}

export async function fetchTechnicals(symbol, benchmark) {
  const q = benchmark ? `&benchmark=${encodeURIComponent(benchmark)}` : '';
  return fetchFromBackend(`/api/technicals?symbol=${encodeURIComponent(symbol)}${q}`, { timeout: 30000 });
}

export async function fetchTechnicalsBatch(symbols = []) {
  if (!symbols.length) return {};
  const data = await fetchFromBackend(`/api/technicals/batch?symbols=${encodeURIComponent(toCsv(symbols))}`, { timeout: 90000 });
  return data?.results || {};
}

export async function fetchScreener(params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])
  );
  return fetchFromBackend(`/api/screener?${qs.toString()}`, { timeout: 30000 });
}

// --- Models -------------------------------------------------------------------

export async function fetchExpectedReturns() {
  return fetchFromBackend('/api/models/expected-returns', { timeout: 20000 });
}

/** The screener row (scores, valuation, fundamentals) for one symbol, or null. */
export async function fetchScreenerRow(symbol) {
  const data = await fetchScreener({ q: symbol, limit: 50 });
  return (data?.rows || []).find((r) => r.symbol.toUpperCase() === String(symbol).toUpperCase()) || null;
}

export async function fetchJobs() {
  return fetchFromBackend('/api/jobs', { timeout: 10000 });
}
