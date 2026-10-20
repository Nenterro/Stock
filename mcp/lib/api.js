import { config } from './config.js';

/**
 * Client for the stock-api on the home server (prices, history, FX,
 * fundamentals, fund holdings, technicals, screener, overrides).
 * Tries each configured base URL in turn, remembering the one that worked.
 */
let good = null;

async function call(path, { method = 'GET', body, timeout = 60000, auth = false } = {}) {
  const urls = good ? [good, ...config.stockApiUrls.filter((u) => u !== good)] : config.stockApiUrls;
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    if (!config.stockApiToken) throw new Error('STOCK_API_WRITE_TOKEN is not set in mcp/.env, so backend writes are disabled.');
    headers.Authorization = `Bearer ${config.stockApiToken}`;
  }

  let lastError = null;
  for (const base of urls) {
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout)
      });
      const data = await res.json().catch(() => null);
      good = base;
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status} from ${path}`);
      return data;
    } catch (err) {
      lastError = err;
      // An HTTP error from a reachable server is the answer; don't retry elsewhere.
      if (good === base) throw err;
    }
  }
  throw new Error(`stock-api unreachable (${config.stockApiUrls.join(', ')}): ${lastError?.message}`);
}

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
const csv = (symbols) => [...new Set(symbols.map((s) => String(s).trim().toUpperCase()).filter((s) => s && s !== 'CASH'))].join(',');

export const api = {
  quotes: async (symbols) => (symbols.length ? (await call(`/api/quotes?${qs({ symbols: csv(symbols) })}`))?.results || {} : {}),
  history: (symbol, range = '5y') => call(`/api/history?${qs({ symbol, range })}`),
  historyBatch: async (symbols, range = '5y') =>
    symbols.length ? (await call(`/api/history/batch?${qs({ symbols: csv(symbols), range })}`, { timeout: 120000 }))?.results || {} : {},
  rates: () => call('/api/rates'),
  historicalFx: (date) => call(`/api/historical-fx?${qs({ date })}`),
  fxSeries: async () => (await call('/api/fx-series'))?.series || null,
  search: (q, limit = 10) => call(`/api/search?${qs({ q, limit })}`),
  fundamentals: (symbol) => call(`/api/fundamentals?${qs({ symbol })}`),
  fundamentalsBatch: async (symbols) =>
    symbols.length ? (await call(`/api/fundamentals/batch?${qs({ symbols: csv(symbols) })}`, { timeout: 180000 }))?.results || {} : {},
  holdings: (symbol) => call(`/api/holdings?${qs({ symbol })}`),
  holdingsBatch: async (symbols) =>
    symbols.length ? (await call(`/api/holdings/batch?${qs({ symbols: csv(symbols) })}`, { timeout: 180000 }))?.results || {} : {},
  technicals: (symbol, benchmark) => call(`/api/technicals?${qs({ symbol, benchmark })}`),
  technicalsBatch: async (symbols) =>
    symbols.length ? (await call(`/api/technicals/batch?${qs({ symbols: csv(symbols) })}`, { timeout: 180000 }))?.results || {} : {},
  screener: (params) => call(`/api/screener?${qs(params)}`),
  health: () => call('/api/health'),
  overrides: () => call('/api/overrides'),
  setOverride: (body) => call('/api/overrides', { method: 'POST', body, auth: true }),
  rebuildScreener: () => call('/api/screener/rebuild', { method: 'POST', body: {}, auth: true })
};
