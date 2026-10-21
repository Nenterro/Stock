import { api } from './api.js';
import { config } from './config.js';
import * as store from './store.js';
import { buildXray, computePositions, BENCHMARKS } from '../../src/utils/portfolio_analytics.js';
import { generatePortfolioTimeSeries, calculateAllTimeMWR } from '../../src/utils/portfolio_math.js';

/**
 * Loads everything an analysis needs and runs the app's own analytics code
 * over it. Market data is cached briefly so a conversation's worth of tool
 * calls doesn't refetch five years of history each time; transactions are
 * re-read often so edits made in the app show up.
 */
const MARKET_TTL = 5 * 60 * 1000;
const TX_TTL = 30 * 1000;
const memo = new Map();

async function cached(key, ttl, loader) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await loader();
  memo.set(key, { at: Date.now(), value });
  return value;
}

export function invalidate(prefix = '') {
  for (const k of memo.keys()) if (k.startsWith(prefix)) memo.delete(k);
}

const tickerOf = (t) => String(t.ticker || t.asset || '').toUpperCase().trim();

export async function transactions({ portfolio } = {}) {
  const all = await cached('tx', TX_TTL, () => store.list(store.COLLECTIONS.transactions));
  if (!portfolio) return all;
  const want = String(portfolio).toLowerCase();
  return all.filter((t) => String(t.portfolio || 'Default').toLowerCase() === want);
}

export async function research() {
  return cached('research', TX_TTL, () => store.list(store.COLLECTIONS.research));
}

export async function researchSettings() {
  const rows = await research();
  return rows.find((r) => r.kind === 'settings')?.data || {};
}

async function market(tickers) {
  const key = [...tickers].sort().join(',');
  return cached(`market:${key}`, MARKET_TTL, async () => {
    const [livePrices, historicalPrices, fxSeries, rates, fundHoldings, fundamentals, ...bench] = await Promise.all([
      api.quotes(tickers),
      api.historyBatch(tickers, '5y'),
      api.fxSeries(),
      api.rates(),
      api.holdingsBatch(tickers),
      api.fundamentalsBatch(tickers),
      ...BENCHMARKS.map((b) => api.history(b.symbol, '5y').catch(() => null))
    ]);
    const benchmarkHistory = {};
    BENCHMARKS.forEach((b, i) => {
      if (bench[i]?.history?.length) benchmarkHistory[b.symbol] = bench[i].history;
    });
    return { livePrices, historicalPrices, fxSeries, fxRate: rates?.rates?.PKR || 278, fundHoldings, fundamentals, benchmarkHistory };
  });
}

function heldTickers(txs) {
  return [...new Set(txs.map(tickerOf).filter((t) => t && t !== 'CASH'))];
}

function riskFreeFor(settings, currency) {
  const v = settings?.riskFreeRate?.[currency];
  return typeof v === 'number' ? v : undefined;
}

export async function xray({ currency = 'USD', portfolio } = {}) {
  const txs = await transactions({ portfolio });
  const m = await market(heldTickers(txs));
  const settings = await researchSettings();
  return buildXray({
    transactions: txs,
    ...m,
    displayCurrency: currency,
    riskFreeRate: riskFreeFor(settings, currency.toUpperCase())
  });
}

/**
 * Tier-1 statement tracking: PSX holdings, watchlist and planner targets.
 * The backend can't read the (encrypted) portfolio, so this server tells it,
 * at most hourly, whenever it has the portfolio loaded anyway.
 */
let lastTrackPush = 0;
async function pushStatementTracking(holdings) {
  if (Date.now() - lastTrackPush < 3600 * 1000 || !config.stockApiToken) return;
  lastTrackPush = Date.now();
  try {
    const rows = await research();
    const psxHeld = holdings.filter((h) => h.nativeCurrency === 'PKR').map((h) => h.ticker);
    const watch = rows.filter((r) => r.kind === 'watch').map((r) => r.symbol);
    const targets = Object.keys(rows.find((r) => r.kind === 'targets')?.data?.targets || {});
    // The backend ignores non-PSX symbols (no PSX filings to find).
    await api.trackStatements([...new Set([...psxHeld, ...watch, ...targets])]);
  } catch {
    // Best effort: tracking catches up next time.
  }
}

export async function positions({ currency = 'USD', portfolio } = {}) {
  const txs = await transactions({ portfolio });
  const tickers = heldTickers(txs);
  const [livePrices, fxSeries, rates] = await Promise.all([
    cached(`quotes:${tickers.sort().join(',')}`, 60 * 1000, () => api.quotes(tickers)),
    cached('fxSeries', MARKET_TTL, () => api.fxSeries()),
    cached('rates', MARKET_TTL, () => api.rates())
  ]);
  const fxRate = rates?.rates?.PKR || 278;
  const out = { ...computePositions(txs, livePrices, { displayCurrency: currency, fxRate, fxSeries }), livePrices };
  if (!portfolio) pushStatementTracking(out.holdings);
  return out;
}

/** Portfolio value and returns over time, downsampled for reading. */
export async function performance({ currency = 'USD', portfolio, interval = 'monthly' } = {}) {
  const txs = await transactions({ portfolio });
  const m = await market(heldTickers(txs));
  const series = generatePortfolioTimeSeries(txs, m.livePrices, m.historicalPrices, currency, m.fxRate, m.fxSeries);
  if (!series.length) return { points: [], summary: null };

  const last = series[series.length - 1];
  const mwr = calculateAllTimeMWR(txs, last.value, currency, m.fxRate, new Date(), m.fxSeries);
  const keep = (p, i) => {
    if (i === series.length - 1 || i === 0) return true;
    const next = series[i + 1]?.date || '';
    if (interval === 'weekly') return new Date(`${p.date}T00:00:00Z`).getUTCDay() === 5;
    if (interval === 'daily') return true;
    return p.date.slice(0, 7) !== next.slice(0, 7); // month end
  };

  return {
    currency,
    summary: {
      from: series[0].date,
      to: last.date,
      value: last.value,
      costBasis: last.costBasis,
      unrealizedPnl: last.unrealizedPnl,
      realizedPnl: last.realizedPnl,
      twrCumulative: last.twrPct / 100,
      // calculateXIRR reports percentages; everything here is fractions.
      mwrCumulative: mwr.cumulative / 100,
      mwrAnnualised: mwr.annualized / 100
    },
    points: series.filter(keep).map((p) => ({
      date: p.date,
      value: p.value,
      costBasis: p.costBasis,
      pnl: p.pnl,
      twr: p.twrPct / 100,
      mwr: p.mwrPct / 100
    }))
  };
}
