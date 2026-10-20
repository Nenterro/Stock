/**
 * The glue between the backend's data and the portfolio models, shared by the
 * Planner page and the MCP server so both build identical inputs.
 *
 * Callers provide fetchers (the app and the MCP server talk to the backend
 * differently); everything else is computed here.
 */

import { constructPortfolio, assetView, sleeveOf, DEFAULT_SLEEVES } from './construct.js';
import { projectPlan, stressTest, HISTORICAL_SCENARIOS, HYPOTHETICAL_SCENARIOS } from './simulate.js';
import { buildFxLookup, dayStrToMs, toDayStr } from '../portfolio_math.js';

/** Core funds offered when the candidate set has no global fund at all. */
export const DEFAULT_CORE = ['ISWD', 'ISDU', 'ISDE'];

/** Market proxies used to complete short histories and for stress tests. */
export const PROXIES = { PKR: 'KSE100TR', USD: '^GSPC' };

const FUND_HINT = /etf|fund|ucits|trust|shares/i;

/**
 * @param {Object} p
 *   holdings      [{ ticker, marketValue (USD), nativeCurrency, name }]  current positions
 *   extraSymbols  symbols to consider beyond holdings (targets, watchlist, ideas)
 *   fetchers      { histories(symbols, range = '10y') -> { SYM: {history, currency} },
 *                   expectedReturns() -> CMA payload,
 *                   screenerRow(symbol) -> screener row or null }
 *   includeDefaultCore  add DEFAULT_CORE when no global fund is present (default true)
 */
export async function buildInputs(p) {
  const held = (p.holdings || []).map((h) => h.ticker);
  let symbols = [...new Set([...held, ...(p.extraSymbols || []).map((s) => String(s).toUpperCase())])];

  const rows = {};
  await Promise.all(symbols.map(async (s) => (rows[s] = await p.fetchers.screenerRow(s).catch(() => null))));
  const kindOf = (s) => rows[s]?.kind || (FUND_HINT.test(rows[s]?.name || p.holdings?.find((h) => h.ticker === s)?.name || '') ? 'etf' : 'stock');

  const histories = await p.fetchers.histories([...symbols, ...Object.values(PROXIES)]);
  const currencyOf = (s) => String(histories[s]?.currency || rows[s]?.currency || p.holdings?.find((h) => h.ticker === s)?.nativeCurrency || 'USD').toUpperCase();

  const hasCoreFund = symbols.some((s) => sleeveOf({ kind: kindOf(s), currency: currencyOf(s) }) === 'globalCore');
  if ((p.includeDefaultCore ?? true) && !hasCoreFund) {
    const extra = await p.fetchers.histories(DEFAULT_CORE);
    Object.assign(histories, extra);
    for (const s of DEFAULT_CORE) {
      rows[s] = rows[s] || { kind: 'etf', currency: 'USD' };
    }
    symbols = [...symbols, ...DEFAULT_CORE.filter((s) => extra[s])];
  }

  const er = await p.fetchers.expectedReturns().catch(() => null);
  const assets = [];
  for (const s of symbols) {
    const h = histories[s];
    if (!h?.history?.length) continue;
    const currency = currencyOf(s);
    const kind = rows[s]?.kind || kindOf(s);
    const view = assetView({ symbol: s, kind, currency, region: rows[s]?.region, impliedReturn: rows[s]?.impliedReturn, scoreCoverage: rows[s]?.scoreCoverage }, er);
    assets.push({
      symbol: s,
      sleeve: sleeveOf({ kind, currency }),
      kind,
      currency: currency === 'PKR' ? 'PKR' : 'USD', // non-USD listings arrive converted to USD
      history: h.history,
      proxy: PROXIES[currency === 'PKR' ? 'PKR' : 'USD'],
      expected: view?.expected ?? null,
      confidence: view?.confidence ?? 0.2,
      source: view?.source || null,
      held: held.includes(s),
      score: rows[s]?.score ?? null,
      sector: rows[s]?.sector ?? null
    });
  }
  const proxies = Object.fromEntries(Object.values(PROXIES).filter((s) => histories[s]).map((s) => [s, histories[s]]));
  // Stress windows reach back to 2007: the full (coarser) proxy series.
  const long = await p.fetchers.histories(Object.values(PROXIES), 'all').catch(() => ({}));
  const proxiesLong = Object.fromEntries(Object.values(PROXIES).map((s) => [s, long[s]?.history?.length ? long[s] : proxies[s]]).filter(([, v]) => v));
  return { assets, proxies, proxiesLong, expectedReturns: er, rows };
}

/** USD series of adjusted closes, for stress tests. */
function usdSeries(history, currency, fxSeries) {
  const fxAt = buildFxLookup(fxSeries, 278);
  return (history || [])
    .map((p) => {
      const d = toDayStr(p.date);
      const px = Number(p.adjClose) > 0 ? Number(p.adjClose) : Number(p.price);
      return { date: d, usd: currency === 'PKR' ? px / fxAt(dayStrToMs(d)) : px };
    })
    .filter((x) => x.date && x.usd > 0);
}

/**
 * Everything the Planner shows: recommended portfolio and alternatives,
 * projection of the contribution plan, stress tests of current and
 * recommended portfolios.
 *
 * @param {Object} p  inputs from buildInputs plus { holdings, fxSeries, sleeves,
 *                    rf, maxStockWeight, monthly, years, contributionGrowth, paths }
 */
export function runModels(p) {
  const built = constructPortfolio({
    assets: p.assets,
    proxies: p.proxies,
    sleeves: p.sleeves || DEFAULT_SLEEVES,
    fxSeries: p.fxSeries,
    rf: p.rf,
    maxStockWeight: p.maxStockWeight,
    today: p.today
  });
  const symbols = built.returnSeries.symbols;
  const totalNow = (p.holdings || []).reduce((s, h) => s + (h.marketValue || 0), 0);
  const currentW = symbols.map((s) => {
    const h = p.holdings?.find((x) => x.ticker === s);
    return totalNow > 0 && h ? h.marketValue / totalNow : 0;
  });
  const startValues = symbols.map((s) => p.holdings?.find((x) => x.ticker === s)?.marketValue || 0);
  const posterior = symbols.map((s) => built.assets.find((a) => a.symbol === s)?.posterior ?? 0.06);

  const proj = (weightsBySymbol) =>
    projectPlan({
      R: built.returnSeries.R,
      symbols,
      expected: posterior,
      weights: symbols.map((s) => weightsBySymbol[s] || 0),
      startValues,
      monthly: p.monthly || 0,
      contributionGrowth: p.contributionGrowth || 0,
      years: p.years || 10,
      paths: p.paths || 4000,
      seed: 20261021
    });

  const projections = {
    recommended: proj(built.portfolios.recommended.weights),
    reference: proj(built.portfolios.reference.weights),
    minimumVariance: proj(built.portfolios.minimumVariance.weights)
  };

  const seriesFor = (s) => {
    const a = p.assets.find((x) => x.symbol === s);
    return a ? usdSeries(a.history, a.currency, p.fxSeries) : [];
  };
  const proxySeries = Object.fromEntries(Object.entries(p.proxiesLong || p.proxies || {}).map(([k, v]) => [k, usdSeries(v.history, v.currency, p.fxSeries)]));
  const stressFor = (weights, value) =>
    stressTest(
      symbols
        .filter((s) => (weights[s] || 0) > 1e-6)
        .map((s) => {
          const a = p.assets.find((x) => x.symbol === s);
          return { symbol: s, value: value * weights[s], currency: a.currency, sector: a.sector, techHeavy: /SPTE|ISDU|SPUS|HLAL/.test(s), series: seriesFor(s), proxy: proxySeries[a.proxy] };
        }),
      { historical: HISTORICAL_SCENARIOS, hypothetical: HYPOTHETICAL_SCENARIOS }
    );
  const notional = totalNow > 0 ? totalNow : 10000;
  const current = Object.fromEntries(symbols.map((s, i) => [s, currentW[i]]));

  return {
    ...built,
    returnSeries: undefined,
    current: totalNow > 0 ? { weights: current, value: totalNow } : null,
    projections,
    stress: {
      notional,
      current: totalNow > 0 ? stressFor(current, totalNow) : null,
      recommended: stressFor(built.portfolios.recommended.weights, notional)
    }
  };
}
