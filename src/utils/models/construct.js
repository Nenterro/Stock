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

/**
 * Default sleeves: the policy mix as the Black-Litterman reference (prior)
 * only, with no bounds. Since 2026-11-11 the optimiser is an input to
 * judgement, not the decision: it runs unconstrained by default, and bounds
 * are passed per run when an alternative is wanted (POLICY_SLEEVES are the
 * old 35-45 / 25-35 / 10-40 ranges).
 */
export const DEFAULT_SLEEVES = {
  globalCore: { name: 'Global core (funds)', target: 0.4, min: 0, max: 1 },
  globalStocks: { name: 'Global stocks', target: 0.3, min: 0, max: 1 },
  pakistan: { name: 'Pakistan', target: 0.3, min: 0, max: 1 }
};
export const POLICY_SLEEVES = {
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
 * Dividend tax withheld at source for a Pakistan-resident individual, by the
 * company's home country (an ADR pays its home country's dividend, so Rio
 * Tinto's NYSE listing is UK-taxed). Statutory non-resident rates, no treaty
 * relief assumed (IBKR rarely applies it at source):
 *   US 30% (the US-Pakistan treaty's 15% is for corporate holders only)
 *   UK, Hong Kong, Singapore 0%; Japan 15.315%; Canada 25%; most of Europe
 *   15-35%; Australia 15% (fully franked dividends are exempt, unfranked 30%)
 *   Pakistan 15% (filer)
 * Irish UCITS funds pay out without withholding (their own US tax is already
 * in the price); US-domiciled funds are taxed like US shares. Pakistan's own
 * tax on foreign dividends (worldwide income, foreign tax credit) is not
 * modelled. Sources: PwC tax summaries, IRS treaty tables, November 2026.
 */
const DIVIDEND_TAX = {
  'United States': 0.3, 'United Kingdom': 0, 'Hong Kong': 0, Singapore: 0, Japan: 0.15315, Canada: 0.25, Australia: 0.15,
  Germany: 0.26375, France: 0.128, Netherlands: 0.15, Switzerland: 0.35, Italy: 0.26, Spain: 0.19, Sweden: 0.3, Denmark: 0.27,
  Finland: 0.35, Norway: 0.25, Ireland: 0.25, Belgium: 0.3, China: 0.1, Pakistan: 0.15
};
const US_DOMICILED_FUNDS = new Set(['SPUS', 'HLAL', 'UMMA', 'SPTE', 'SPRE', 'SPSK']);
export function dividendTaxRate({ symbol, kind, currency, country }) {
  if (String(currency).toUpperCase() === 'PKR') return DIVIDEND_TAX.Pakistan;
  if (kind === 'etf' || kind === 'fund') return US_DOMICILED_FUNDS.has(symbol) ? DIVIDEND_TAX['United States'] : 0;
  return DIVIDEND_TAX[country] ?? 0.15;
}

// How far a stock's own valuation moves its view off its market: single-stock
// estimates are noisy, so they inform the view without dominating it. 0.4 is
// a prior; once the prediction archive has enough history, each market's
// measured calibration slope moves it (calibratedValueWeight).
export const VALUE_WEIGHT = 0.4;
const VALUE_WEIGHT_PRIOR_SD = 0.2;
// Largest tilt from the non-value factor scores (quality, momentum, growth,
// low risk), at a percentile of 0 or 1. Documented long-short premia on these
// factors are a few percent a year; a long-only percentile is worth less.
const FACTOR_TILT = 0.05;
const FACTOR_WEIGHTS = { quality: 0.25, momentum: 0.2, growth: 0.15, lowRisk: 0.15 };
// Error in a market's expected return, shared by every stock view that leans
// on it (about 3 points a year for an earnings-yield CMA over a decade).
export const MARKET_VIEW_SD = 0.03;

/**
 * How far a stock's valuation can be trusted, as a multiplier (0.1-1) on its
 * view confidence, with the reasons. Added November 2026: the optimiser's
 * largest picks were mostly its largest errors (peak-cycle earnings, data
 * problems), because a tanker at peak profits with complete data was trusted
 * as much as a steady compounder. Research verdicts count too.
 *
 *   earnings variability  year-to-year swing in profit (CV): 1 up to 0.15,
 *                         falling to 0.35 at 0.6 and above (a loss year = 1)
 *   peak earnings         trailing over 1.5x normal: x0.5; over 1.25x: x0.75
 *   earnings flags        EPS inconsistent with net income: x0.7
 *   falling estimates     next year's EPS forecast down 10%+ in 90 days: x0.8
 *   research              needs-review: x0.5; industry at a cyclical peak
 *                         (a thesis said so): x0.5
 * A thesis's own return estimate replaces the model's valuation, and skips
 * the earnings checks: research has already normalised the earnings.
 */
export function reliability(a) {
  const reasons = [];
  let k = 1;
  const r = a.research || {};
  if (r.impliedReturn == null) {
    const cv = a.earningsCv;
    if (cv != null) {
      const f = cv <= 0.15 ? 1 : cv >= 0.6 ? 0.35 : 1 - ((cv - 0.15) / 0.45) * 0.65;
      if (f < 1) {
        k *= f;
        reasons.push(`earnings variability ${cv.toFixed(2)} (x${f.toFixed(2)})`);
      }
    }
    const n = a.normalisation;
    if (n != null && n < 1 / 1.5) {
      k *= 0.5;
      reasons.push(`trailing earnings ${(1 / n).toFixed(1)}x normal (x0.5)`);
    } else if (n != null && n < 0.8) {
      k *= 0.75;
      reasons.push(`trailing earnings ${(1 / n).toFixed(2)}x normal (x0.75)`);
    }
    if (a.earningsFlags?.length) {
      k *= 0.7;
      reasons.push('earnings data flagged (x0.7)');
    }
    if (a.epsRevision90d != null && a.epsRevision90d <= -0.1) {
      k *= 0.8;
      reasons.push(`EPS estimate ${Math.round(a.epsRevision90d * 100)}% in 90 days (x0.8)`);
    }
  }
  if (r.status === 'needs-review') {
    k *= 0.5;
    reasons.push('research: needs review (x0.5)');
  }
  if (r.peakIndustry && !['ready', 'holding'].includes(r.status)) {
    k *= 0.5;
    reasons.push(`research: ${r.peakIndustry} at a cyclical peak (x0.5)`);
  }
  return { factor: Math.max(0.1, k), reasons };
}

/**
 * How much of a stock's valuation gap to believe in one market: the prior
 * (VALUE_WEIGHT, sd 0.2) updated with the calibration slope measured by the
 * prediction archive (backend lib/predictions.js), from the longest horizon
 * with at least three independent periods. Between 0 and 0.7.
 * @returns {{ weight: number, source: string }}
 */
export function calibratedValueWeight(signalQuality, marketKey) {
  const prior = { weight: VALUE_WEIGHT, source: 'prior (no measured calibration yet)' };
  if (!signalQuality?.horizons) return prior;
  for (const h of ['12m', '6m', '3m']) {
    const m = signalQuality.horizons[h]?.markets?.[marketKey];
    const c = m?.calibration;
    if (!c || !(c.se > 0) || (m.independentPeriods ?? 0) < 3) continue;
    const pp = 1 / VALUE_WEIGHT_PRIOR_SD ** 2;
    const pd = 1 / c.se ** 2;
    const w = (VALUE_WEIGHT * pp + c.slope * pd) / (pp + pd);
    return { weight: Math.max(0, Math.min(0.7, w)), source: `prior 0.4 updated with the ${h} calibration slope ${c.slope.toFixed(2)} (se ${c.se.toFixed(2)}, ${m.independentPeriods} periods)` };
  }
  return prior;
}

/**
 * Expected USD return (after dividend tax withheld at source) and view
 * confidence for one asset, from the backend's models.
 *   funds:  the fund's own CMA (earnings yield, fee-adjusted)
 *   stocks: market return
 *           + the value weight (0.4 until measured) x the gap between the
 *             stock's implied return (normalised earnings, in USD; or a
 *             research thesis's own estimate) and its market
 *           + a tilt of up to +/-2.5 points from its quality, momentum
 *             (price and estimate revisions), growth and low-risk scores
 *   both:   less dividend yield x withholding rate
 * Confidence: data coverage x reliability() (earnings stability, peaks,
 * flags, revisions, research verdicts).
 * `group` names the market the view leans on, for the shared-error term.
 *
 * @param {Object} a   { symbol, kind, currency, region, country, impliedReturn (local),
 *                       scoreCoverage, scores, dividendYield, earningsCv,
 *                       normalisation, earningsFlags, epsRevision90d,
 *                       research: { status, impliedReturn, peakIndustry } }
 * @param {Object} er  /api/models/expected-returns payload
 * @param {Object} [opts]  { signalQuality: /api/models/signal-quality payload }
 */
export function assetView(a, er, opts = {}) {
  if (!er) return null;
  const taxDrag = Math.max(0, a.dividendYield || 0) * dividendTaxRate(a);
  const fund = er.funds?.find((f) => f.symbol === a.symbol);
  if (fund) return { expected: fund.expected.base.usd - taxDrag, confidence: 0.6, source: 'fund earnings yield (CMA)', taxDrag, group: null };

  const marketKey = String(a.currency).toUpperCase() === 'PKR' ? 'psx' : a.region === 'us' || !a.region ? 'us' : { jp: 'jp', hk: 'hk', ca: 'ca', au: 'au' }[a.region] || 'europe';
  const market = er.markets?.find((m) => m.key === marketKey) || er.markets?.find((m) => m.key === 'us');
  if (!market) return null;
  const marketUsd = market.expected.base.usd;

  const f = a.scores || {};
  const present = Object.entries(FACTOR_WEIGHTS).filter(([k]) => f[k] != null);
  const wSum = present.reduce((s, [, w]) => s + w, 0);
  const factor = present.length >= 2 ? present.reduce((s, [k, w]) => s + w * f[k], 0) / wSum : null;
  const tilt = factor != null ? (factor - 0.5) * FACTOR_TILT : 0;
  const rel = reliability(a);

  const thesis = a.research?.impliedReturn;
  const implied = thesis ?? a.impliedReturn;
  if (implied == null) {
    return { expected: marketUsd + tilt - taxDrag, confidence: Math.max(0.03, 0.2 * rel.factor), source: `${market.name} market return (no stock estimate)`, taxDrag, tilt, group: market.key, reliability: rel };
  }
  const usd = (1 + implied) / (1 + (market.depreciationVsUsd || 0)) - 1;
  const capped = Math.max(-0.2, Math.min(0.4, usd));
  const coverage = a.scoreCoverage ?? 0.5;
  const vw = calibratedValueWeight(opts.signalQuality, market.key);
  return {
    expected: marketUsd + vw.weight * (capped - marketUsd) + tilt - taxDrag,
    confidence: Math.max(0.03, (0.35 * coverage + 0.1) * rel.factor),
    source: thesis != null ? 'market return + research thesis estimate + factor scores, after dividend tax' : 'market return + valuation (normalised earnings) + factor scores, after dividend tax',
    taxDrag,
    tilt,
    group: market.key,
    reliability: rel,
    valueWeight: vw
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
    // region: a wide list sized for the future portfolio put 80% of the stock
    // sleeve in Japan. A level with one value in the sleeve (Pakistan's
    // region) has nothing to spread across, so it is skipped.
    const levels = [['sector', p.sectorCap ?? 1], ['industry', p.industryCap ?? 1], ['region', p.regionCap ?? 1]]
      .filter(([, c]) => c > 0 && c < 1)
      .filter(([field]) => new Set(g.idx.map((i) => assets[i][field]).filter(Boolean)).size > 1);
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
    // Regions cut across sectors: the sleeve holds at most the smaller of the two.
    const regions = new Map();
    for (const i of g.idx) {
      const c = capOf('region', i);
      const key = c ? c.name : `#${i}`;
      regions.set(key, { cap: c ? c.max : Infinity, room: (regions.get(key)?.room || 0) + upper[i] });
    }
    const capacity = Math.min(
      [...sectors.values()].reduce((s, v) => s + Math.min(v.cap, v.room), 0),
      [...regions.values()].reduce((s, v) => s + Math.min(v.cap, v.room), 0)
    );
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

  const views = assets.map((a, i) => (a.expected != null ? { index: i, q: a.expected, confidence: a.confidence ?? 0.3, group: a.viewGroup ?? null } : null)).filter(Boolean);
  // Stock views carry (1 - VALUE_WEIGHT) of their market's estimate, and its error.
  const sharedSd = (p.marketViewSd ?? MARKET_VIEW_SD) * (1 - VALUE_WEIGHT);
  const sharedVariance = Object.fromEntries([...new Set(views.map((v) => v.group).filter(Boolean))].map((g) => [g, sharedSd ** 2]));
  const bl = blackLitterman({ S, wRef, delta, tau, views, rf, sharedVariance });

  // Minimum position: a holding is either 0 or at least minPosition (a few
  // percent: $90 crumbs are tracking work with no effect). Not a convex
  // constraint, so the recommended portfolio is pruned: solve, drop the
  // smallest positions under the floor, solve again, until none are left.
  const minPos = p.minPosition ?? 0;
  // The investor's own risk aversion, when given. `delta` is only what makes
  // the policy mix optimal (about 3.5 in November 2026); it still sets the
  // Black-Litterman prior. 1 = growth-optimal (Kelly), 2 = half Kelly.
  const lambda = p.riskAversion > 0 ? p.riskAversion : delta;
  const solveRecommended = (up) => meanVariance({ mu: bl.mu, S, lambda, lower, upper: up, groups: allGroups, w0: wRef });
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
  if (capGroups.length) notes.push(`Concentration limits: no sector above ${Math.round((p.sectorCap ?? 1) * 100)}%, no industry above ${Math.round((p.industryCap ?? 1) * 100)}% and no market above ${Math.round((p.regionCap ?? 1) * 100)}% of a stock sleeve (${capGroups.length} limits binding on the candidates).`);
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
    riskAversion: lambda,
    riskAversionImpliedByPolicy: delta,
    covariance: { shrinkage: lw.intensity, averageCorrelation: lw.avgCorrelation },
    assets: assets.map((a, i) => ({
      symbol: a.symbol,
      sleeve: a.sleeve,
      volatility: vol[i],
      view: a.expected,
      viewConfidence: a.confidence,
      viewSource: a.source || null,
      dividendTax: a.taxDrag ?? null,
      factorTilt: a.tilt ?? null,
      reliability: a.reliability ?? null,
      valueWeight: a.valueWeight?.weight ?? null,
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
