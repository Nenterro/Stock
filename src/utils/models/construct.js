/**
 * Portfolio construction end to end: candidate assets in, recommended
 * weights out, with the alternatives and the reasoning attached.
 *
 *   returns -> Ledoit-Wolf covariance -> reference (no-view) portfolio
 *           -> Black-Litterman with per-asset views -> constrained optimum
 *
 * The reference portfolio is the policy: sleeve targets, split within each
 * sleeve by inverse volatility. Views come from the expected-return and
 * valuation models, with confidence that reflects how much to trust them
 * (funds more than single stocks; stocks less when their data is thin).
 */

import { monthlyReturns, ledoitWolf, annualise } from './risk.js';
import { blackLitterman, impliedDelta, meanVariance, maxSharpe, riskParity, stats, dot } from './optimize.js';

/** Default sleeves from the investment policy. */
export const DEFAULT_SLEEVES = {
  globalCore: { name: 'Global core (funds)', target: 0.4, min: 0.35, max: 0.45 },
  globalStocks: { name: 'Global stocks', target: 0.3, min: 0.25, max: 0.35 },
  pakistan: { name: 'Pakistan', target: 0.3, min: 0.1, max: 0.4 }
};

/** Which sleeve an asset belongs to. */
export function sleeveOf({ kind, currency }) {
  if (String(currency).toUpperCase() === 'PKR') return 'pakistan';
  return kind === 'etf' || kind === 'fund' ? 'globalCore' : 'globalStocks';
}

/**
 * Expected USD return and view confidence for one asset, from the backend's
 * models.
 *   funds:  the fund's own CMA (earnings yield, fee-adjusted)
 *   stocks: valuation implied return, converted to USD and shrunk halfway
 *           toward its market's expected return - single-stock estimates are
 *           noisy, so they inform the view without dominating it
 *
 * @param {Object} a   { symbol, kind, currency, region, impliedReturn (local), scoreCoverage }
 * @param {Object} er  /api/models/expected-returns payload
 */
export function assetView(a, er) {
  if (!er) return null;
  const fund = er.funds?.find((f) => f.symbol === a.symbol);
  if (fund) return { expected: fund.expected.base.usd, confidence: 0.6, source: 'fund earnings yield (CMA)' };

  const marketKey = String(a.currency).toUpperCase() === 'PKR' ? 'psx' : a.region === 'us' || !a.region ? 'us' : { jp: 'jp', hk: 'hk', ca: 'ca', au: 'au' }[a.region] || 'europe';
  const market = er.markets?.find((m) => m.key === marketKey) || er.markets?.find((m) => m.key === 'us');
  if (!market) return null;
  const marketUsd = market.expected.base.usd;
  if (a.impliedReturn == null) return { expected: marketUsd, confidence: 0.2, source: `${market.name} market return (no stock estimate)` };
  const usd = (1 + a.impliedReturn) / (1 + (market.depreciationVsUsd || 0)) - 1;
  const capped = Math.max(-0.2, Math.min(0.4, usd));
  const coverage = a.scoreCoverage ?? 0.5;
  return {
    expected: 0.5 * capped + 0.5 * marketUsd,
    confidence: Math.max(0.1, 0.35 * coverage + 0.1),
    source: 'valuation implied return, shrunk toward market'
  };
}

/**
 * @param {Object} p
 *   assets   [{ symbol, sleeve, history, currency, proxy?, expected, confidence, min?, max? }]
 *   proxies  { KEY: { history, currency } }   market indices for short histories
 *   sleeves  { key: { target, min, max } }
 *   fxSeries, rf (USD risk-free), months (lookback, default 60), maxStockWeight
 */
export function constructPortfolio(p) {
  const sleeves = p.sleeves || DEFAULT_SLEEVES;
  const rf = p.rf ?? 0.04;
  const input = Object.fromEntries(p.assets.map((a) => [a.symbol, { history: a.history, currency: a.currency, proxy: a.proxy }]));
  const rets = monthlyReturns(input, { fxSeries: p.fxSeries, months: p.months || 60, proxies: p.proxies, today: p.today });
  const assets = rets.symbols.map((s) => p.assets.find((a) => a.symbol === s));
  const n = assets.length;
  if (n < 2) throw new Error(`Need at least two assets with 12+ months of history; dropped: ${rets.dropped.join(', ') || 'none'}`);
  if (rets.R.length < 24) throw new Error(`Only ${rets.R.length} months of overlapping history; need 24+`);

  const lw = ledoitWolf(rets.R);
  const S = annualise(lw.S);
  const vol = S.map((row, i) => Math.sqrt(row[i]));

  // A sleeve with no candidates hands its share to its neighbour rather than
  // spreading it proportionally, so Pakistan's bounds stay as set in policy:
  // money meant for global stocks waits in the global core until there are
  // stocks to buy (and vice versa).
  const eff = Object.fromEntries(Object.entries(sleeves).map(([k, v]) => [k, { ...v }]));
  const has = (k) => assets.some((a) => a.sleeve === k);
  const hand = (from, to) => {
    if (!eff[from] || has(from) || !eff[to] || !has(to)) return;
    eff[to].target += eff[from].target;
    eff[to].min += eff[from].min;
    eff[to].max += eff[from].max;
    delete eff[from];
  };
  hand('globalStocks', 'globalCore');
  hand('globalCore', 'globalStocks');
  if (eff.pakistan && !has('pakistan')) {
    const rest = Object.keys(eff).filter((k) => k !== 'pakistan' && has(k));
    for (const k of rest) {
      const share = eff[k].target / rest.reduce((s, r) => s + eff[r].target, 0);
      eff[k].target += eff.pakistan.target * share;
      eff[k].min += eff.pakistan.min * share;
      eff[k].max += eff.pakistan.max * share;
    }
    delete eff.pakistan;
  }
  const present = Object.keys(eff).filter((k) => has(k));
  const tSum = present.reduce((s, k) => s + eff[k].target, 0);
  const groups = present.map((k) => ({
    name: eff[k].name || k,
    key: k,
    idx: assets.map((a, i) => (a.sleeve === k ? i : -1)).filter((i) => i >= 0),
    min: Math.min(1, eff[k].min),
    max: Math.min(1, eff[k].max),
    target: eff[k].target / tSum
  }));

  // Reference: sleeve target split by inverse volatility within the sleeve.
  const wRef = new Array(n).fill(0);
  for (const g of groups) {
    const inv = g.idx.map((i) => 1 / Math.max(vol[i], 1e-6));
    const s = inv.reduce((a, b) => a + b, 0);
    g.idx.forEach((i, k) => (wRef[i] = (g.target * inv[k]) / s));
  }
  const expected = assets.map((a) => a.expected);
  const haveViews = expected.some((e) => e != null);
  const refExcess = dot(wRef, expected.map((e) => e ?? rf)) - rf;
  // Without views there is nothing to calibrate against: use the textbook 2.5.
  const delta = haveViews && refExcess > 0.005 ? impliedDelta(wRef, S, refExcess) : 2.5;
  // Prior uncertainty: about 0.05 for five years of monthly data.
  const tau = 3 / rets.R.length;

  const views = assets.map((a, i) => (a.expected != null ? { index: i, q: a.expected, confidence: a.confidence ?? 0.3 } : null)).filter(Boolean);
  const bl = blackLitterman({ S, wRef, delta, tau, views, rf });

  const maxStock = p.maxStockWeight ?? 0.1;
  const lower = assets.map((a) => a.min ?? 0);
  const upper = assets.map((a) => a.max ?? (a.sleeve === 'globalCore' ? 1 : maxStock));

  const optimal = meanVariance({ mu: bl.mu, S, lambda: delta, lower, upper, groups, w0: wRef });
  const minVar = meanVariance({ mu: null, S, lambda: 1, lower, upper, groups, w0: wRef });
  const ms = maxSharpe({ mu: bl.mu, S, rf, lower, upper, groups });
  const rp = riskParity({ S, lower, upper, groups });

  const describe = (w) => {
    const st = stats(w, bl.mu, S, rf);
    return {
      ...st,
      weights: Object.fromEntries(assets.map((a, i) => [a.symbol, w[i]])),
      riskContributions: Object.fromEntries(assets.map((a, i) => [a.symbol, st.riskContributions[i]])),
      sleeves: Object.fromEntries(groups.map((g) => [g.key, g.idx.reduce((s, i) => s + w[i], 0)]))
    };
  };

  return {
    asOf: rets.months[rets.months.length - 1],
    months: rets.R.length,
    riskFree: rf,
    riskAversion: delta,
    covariance: { shrinkage: lw.intensity, averageCorrelation: lw.avgCorrelation },
    assets: assets.map((a, i) => ({
      symbol: a.symbol,
      sleeve: a.sleeve,
      volatility: vol[i],
      view: a.expected,
      viewConfidence: a.confidence,
      viewSource: a.source || null,
      prior: bl.prior[i],
      posterior: bl.mu[i],
      filledMonths: rets.filled[a.symbol] || 0
    })),
    dropped: rets.dropped,
    portfolios: {
      recommended: { ...describe(optimal), method: 'Black-Litterman mean-variance within policy constraints' },
      reference: { ...describe(wRef), method: 'policy sleeves, inverse-volatility within each' },
      minimumVariance: { ...describe(minVar), method: 'lowest volatility within constraints' },
      maxSharpe: { ...describe(ms.w), method: 'highest Sharpe ratio within constraints' },
      riskParity: { ...describe(rp), method: 'equal risk contributions, projected onto constraints' }
    },
    returnSeries: { symbols: rets.symbols, months: rets.months, R: rets.R }
  };
}
