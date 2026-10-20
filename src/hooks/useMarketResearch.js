import { useEffect, useState } from 'react';
import { fetchFundamentalsBatch, fetchFundHoldingsBatch, fetchTechnicalsBatch, fetchHistoricalPrices } from '../utils/api';
import { BENCHMARKS } from '../utils/portfolio_analytics';

const TTL = 6 * 60 * 60 * 1000;

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { at, data } = JSON.parse(raw);
    return Date.now() - at < TTL ? data : null;
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // Over quota: the in-memory copy still serves this session.
  }
}

/**
 * Fundamentals, fund compositions and (optionally) technicals for a set of
 * tickers, plus benchmark history. Serves the cached copy first, then
 * refreshes - these change at most daily.
 */
export function useMarketResearch(tickers = [], { technicals = false, benchmarks = true } = {}) {
  const key = [...new Set(tickers.map((t) => String(t).toUpperCase()))].sort().join(',');
  const cacheKey = `stock_tracker_research:${technicals ? 't' : ''}${benchmarks ? 'b' : ''}:${key}`;
  const [state, setState] = useState(() => readCache(cacheKey) || { fundamentals: {}, fundHoldings: {}, technicals: {}, benchmarkHistory: {} });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!key && !benchmarks) return;
    let live = true;
    const cached = readCache(cacheKey);
    if (cached) setState(cached);
    setLoading(true);
    const list = key ? key.split(',') : [];

    Promise.all([
      fetchFundamentalsBatch(list),
      fetchFundHoldingsBatch(list),
      technicals ? fetchTechnicalsBatch(list) : Promise.resolve({}),
      benchmarks
        ? Promise.all(BENCHMARKS.map((b) => fetchHistoricalPrices(b.symbol, '5y').catch(() => null)))
        : Promise.resolve([])
    ])
      .then(([fundamentals, fundHoldings, tech, bench]) => {
        if (!live) return;
        const benchmarkHistory = {};
        BENCHMARKS.forEach((b, i) => {
          if (bench[i]?.history?.length) benchmarkHistory[b.symbol] = bench[i].history;
        });
        const next = { fundamentals, fundHoldings, technicals: tech, benchmarkHistory };
        setState(next);
        writeCache(cacheKey, next);
      })
      .finally(() => live && setLoading(false));

    return () => {
      live = false;
    };
  }, [cacheKey, key, technicals, benchmarks]);

  return { ...state, loading };
}
