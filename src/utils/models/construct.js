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
  // Per-asset caps, and sleeves too small to hold their minimum: with two
  // global stocks capped at 10% each, a 25% global-stocks sleeve can't be
  // filled. Cap such a sleeve at what its assets can hold and hand the rest to
  // the global core, rather than failing - early on there are few candidates.
  const maxStock = p.maxStockWeight ?? 0.1;
  const lower = assets.map((a) => a.min ?? 0);
  const upper = assets.map((a) => a.max ?? (a.sleeve === 'globalCore' ? 1 : maxStock));
  const notes = [];
  for (const k of Object.keys(eff)) {
    if (k === 'globalCore' || !has(k)) continue;
    const cap = assets.reduce((s, a, i) => s + (a.sleeve === k ? upper[i] : 0), 0);
    if (cap + 1e-9 >= eff[k].target) continue;
    const to = eff.globalCore && has('globalCore') ? 'globalCore' : null;
    if (!to) continue;
    const moved = eff[k].target - Math.min(eff[k].target, cap);
    notes.push(`${eff[k].name || k} has only ${assets.filter((a) => a.sleeve === k).length} candidate(s) at most ${Math.round(maxStock * 100)}% each, so it is capped at ${Math.round(cap * 100)}%; the other ${Math.round(Math.max(moved, eff[k].min - cap) * 100)}% goes to the global core until there are more names.`);
    eff[to].target += moved;
    eff[to].min += eff[k].min - Math.min(eff[k].min, cap);
    eff[to].max += eff[k].max - Math.min(eff[k].max, cap);
    eff[k].target = Math.min(eff[k].target, cap);
    eff[k].min = Math.min(eff[k].min, cap);
    eff[k].max = Math.min(eff[k].max, cap);
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

  // Concentration limits inside each stock sleeve: no sector above sectorCap
  // of the sleeve and no industry above industryCap. Without them a wide
  // candidate list goes half into whatever is cheapest right now (oil tankers
  // at peak rates, October 2026). A sleeve that couldn't be filled under the
  // caps keeps them off, with a note, rather than failing.
  const capGroups = [];
  for (const g of groups) {
    if (g.key === 'globalCore') continue;
    const levels = [['sector', p.sectorCap ?? 0.4], ['industry', p.industryCap ?? 0.25]].filter(([, c]) => c > 0 && c < 1);
    if (!levels.length) continue;
    const mine = [];
    for (const [field, cap] of levels) {
      const by = new Map();
      for (const i of g.idx) {
        const k = assets[i][field];
        if (k) by.set(k, [...(by.get(k) || []), i]);
      }
      for (const [k, idx] of by) {
        const max = cap * g.target;
        if (idx.reduce((s, i) => s + upper[i], 0) > max + 1e-9) mine.push({ name: `${g.name}: ${k}`, field, idx, min: 0, max });
      }
    }
    // What the sleeve can still hold: each industry up to its cap, each
    // sector up to its cap, assets without a label up to their own limits.
    const capOf = (field, i) => mine.find((c) => c.field === field && c.idx.includes(i));
    const industries = new Map();
    for (const i of g.idx) {
      const c = capOf('industry', i);
      const key = c ? c.name : `#${i}`;
      industries.set(key, { cap: c ? c.max : Infinity, room: (industries.get(key)?.room || 0) + upper[i], sector: capOf('sector', i) });
    }
    const sectors = new Map();
    for (const [key, v] of industries) {
      const s = v.sector ? v.sector.name : key;
      sectors.set(s, { cap: v.sector ? v.sector.max : Infinity, room: (sectors.get(s)?.room || 0) + Math.min(v.cap, v.room) });
    }
    const capacity = [...sectors.values()].reduce((s, v) => s + Math.min(v.cap, v.room), 0);
    if (capacity + 1e-9 < g.min) {
      notes.push(`${g.name}: too few sectors among the candidates to fill ${Math.round(g.min * 100)}% within the concentration limits, so the limits are off for this sleeve.`);
      continue;
    }
    capGroups.push(...mine);
  }
  const allGroups = [...groups, ...capGroups];

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

  // Minimum position: a holding is either 0 or at least minPosition (a few
  // percent: $90 crumbs are tracking work with no effect). Not a convex
  // constraint, so the recommended portfolio is pruned: solve, drop the
  // smallest positions under the floor, solve again, until none are left.
  const minPos = p.minPosition ?? 0;
  const solveRecommended = (up) => meanVariance({ mu: bl.mu, S, lambda: delta, lower, upper: up, groups: allGroups, w0: wRef });
  let up = [...upper];
  let optimal = solveRecommended(up);
  let pruned = 0;
  const sleeveOfIdx = (i) => groups.find((g) => g.idx.includes(i));
  for (let round = 0; minPos > 0 && round < 60; round++) {
    const under = assets.map((_, i) => i).filter((i) => up[i] > 0 && lower[i] === 0 && optimal[i] < minPos - 1e-6).sort((a, b) => optimal[a] - optimal[b]);
    if (!under.length) break;
    // Dust goes at once; real positions a third at a time, since dropping
    // one can lift another above the floor.
    const dust = under.filter((i) => optimal[i] < 1e-4);
    const batch = dust.length ? dust : under.slice(0, Math.ceil(under.length / 3));
    const next = [...up];
    for (const i of batch) {
      const g = sleeveOfIdx(i);
      const room = g.idx.reduce((s, j) => s + (j === i ? 0 : next[j]), 0);
      if (room + 1e-9 >= g.min) next[i] = 0;
    }
    if (next.every((x, i) => x === up[i])) break;
    try {
      const w = solveRecommended(next);
      pruned += batch.filter((i) => next[i] === 0 && up[i] > 0 && optimal[i] >= 1e-4).length;
      up = next;
      optimal = w;
    } catch {
      break;
    }
  }
  if (minPos > 0) {
    // What the optimiser has no way to fill exactly stays as it is; dust is zero.
    optimal = optimal.map((x) => (x < 1e-6 ? 0 : x));
    if (pruned) notes.push(`Recommended portfolio: ${pruned} position(s) below the ${(minPos * 100).toFixed(1)}% minimum were dropped and the rest re-optimised.`);
  }
  if (capGroups.length) notes.push(`Concentration limits: no sector above ${Math.round((p.sectorCap ?? 0.4) * 100)}% and no industry above ${Math.round((p.industryCap ?? 0.25) * 100)}% of a stock sleeve (${capGroups.length} limits binding on the candidates).`);
  const minVar = meanVariance({ mu: null, S, lambda: 1, lower, upper, groups: allGroups, w0: wRef });
  const ms = maxSharpe({ mu: bl.mu, S, rf, lower, upper, groups: allGroups });
  const rp = riskParity({ S, lower, upper, groups: allGroups });

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
    notes,
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
