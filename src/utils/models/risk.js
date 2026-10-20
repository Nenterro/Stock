/**
 * Return series and covariance for portfolio models.
 *
 * Everything is in USD monthly simple returns: the currency you invest in and
 * measure wealth in, so PKR depreciation shows up as the risk it is. Prices
 * are adjusted closes (splits, bonuses and dividends out), month-end points.
 *
 * Short histories: an asset with fewer months than the window is completed
 * with its proxy's returns (its market index) for the missing early months,
 * recorded in `filled`, so a stock listed two years ago doesn't shrink the
 * whole window. Covariance is shrunk toward constant correlation
 * (Ledoit & Wolf, 2004): sample covariances of 20-50 assets from 5 years of
 * months are noisy enough to send an optimiser after estimation error.
 */

import { buildFxLookup, dayStrToMs, toDayStr } from '../portfolio_math.js';

/** Month-end adjusted closes in USD, keyed 'YYYY-MM'. */
export function monthEndUsd(history = [], currency = 'USD', fxSeries = null) {
  const fxAt = buildFxLookup(fxSeries, 278);
  const out = new Map();
  for (const p of history) {
    const d = toDayStr(p.date);
    if (!d) continue;
    const px = Number(p.adjClose) > 0 ? Number(p.adjClose) : Number(p.price);
    if (!(px > 0)) continue;
    const usd = String(currency).toUpperCase() === 'PKR' ? px / fxAt(dayStrToMs(d)) : px;
    out.set(d.slice(0, 7), usd); // later days in the month overwrite earlier ones
  }
  return out;
}

function monthsBack(lastMonth, n) {
  const [y, m] = lastMonth.split('-').map(Number);
  const out = [];
  for (let k = n; k >= 0; k--) {
    const d = new Date(Date.UTC(y, m - 1 - k, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

/**
 * Aligned monthly USD returns.
 *
 * @param {Object} assets  { SYMBOL: { history, currency, proxy? } } - proxy is
 *                         another key in `assets` or in `proxies`
 * @param {Object} opts    { fxSeries, months = 60, proxies: { SYMBOL: {history, currency} }, minOwnMonths = 12 }
 * @returns {{ symbols, months, R: number[][] (T x N), filled: {SYMBOL: n}, dropped: string[] }}
 */
export function monthlyReturns(assets, opts = {}) {
  const months = opts.months || 60;
  const minOwn = opts.minOwnMonths ?? 12;
  const proxies = opts.proxies || {};
  const prices = {};
  let lastMonth = null;
  for (const [sym, a] of Object.entries(assets)) {
    const m = monthEndUsd(a.history, a.currency, opts.fxSeries);
    prices[sym] = m;
    const keys = [...m.keys()].sort();
    if (keys.length && (!lastMonth || keys[keys.length - 1] > lastMonth)) lastMonth = keys[keys.length - 1];
  }
  const proxyPrices = {};
  for (const [sym, a] of Object.entries(proxies)) proxyPrices[sym] = monthEndUsd(a.history, a.currency, opts.fxSeries);
  if (!lastMonth) return { symbols: [], months: [], R: [], filled: {}, dropped: Object.keys(assets) };

  // The current calendar month is partial; end at the last complete one.
  const thisMonth = (opts.today || new Date().toISOString()).slice(0, 7);
  const endMonth = lastMonth >= thisMonth ? monthsBack(thisMonth, 1)[0] : lastMonth;
  const axis = monthsBack(endMonth, months);
  const ret = (map, i) => {
    const a = map?.get(axis[i - 1]);
    const b = map?.get(axis[i]);
    return a > 0 && b > 0 ? b / a - 1 : null;
  };

  const symbols = [];
  const cols = [];
  const filled = {};
  const dropped = [];
  for (const sym of Object.keys(assets)) {
    const own = [];
    for (let i = 1; i < axis.length; i++) own.push(ret(prices[sym], i));
    const ownCount = own.filter((x) => x != null).length;
    if (ownCount < minOwn) {
      dropped.push(sym);
      continue;
    }
    const proxyKey = assets[sym].proxy;
    const proxyMap = proxyKey ? prices[proxyKey] || proxyPrices[proxyKey] : null;
    let nFilled = 0;
    const col = own.map((x, k) => {
      if (x != null) return x;
      const p = proxyMap ? ret(proxyMap, k + 1) : null;
      if (p != null) nFilled += 1;
      return p;
    });
    if (col.some((x) => x == null)) {
      // Still gaps (no proxy, or proxy also missing): fill with 0 only inside
      // the series, after its first observation; drop leading gaps by trimming.
      const firstIdx = col.findIndex((x) => x != null);
      for (let k = firstIdx; k < col.length; k++) if (col[k] == null) col[k] = 0;
    }
    if (nFilled) filled[sym] = nFilled;
    symbols.push(sym);
    cols.push(col);
  }

  // Trim leading months where any asset is still missing.
  let start = 0;
  while (start < axis.length - 1 && cols.some((c) => c[start] == null)) start++;
  const T = axis.length - 1 - start;
  const R = [];
  for (let t = 0; t < T; t++) R.push(cols.map((c) => c[start + t]));
  return { symbols, months: axis.slice(start + 1), R, filled, dropped };
}

export function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
}

/** Sample covariance of a T x N matrix (columns are assets). */
export function sampleCov(R) {
  const T = R.length;
  const N = R[0]?.length || 0;
  const mu = Array.from({ length: N }, (_, j) => mean(R.map((row) => row[j])));
  const S = Array.from({ length: N }, () => new Array(N).fill(0));
  for (const row of R) {
    for (let i = 0; i < N; i++) {
      const di = row[i] - mu[i];
      for (let j = i; j < N; j++) S[i][j] += di * (row[j] - mu[j]);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = i; j < N; j++) {
      S[i][j] /= T - 1;
      S[j][i] = S[i][j];
    }
  }
  return { S, mu };
}

/**
 * Ledoit-Wolf shrinkage toward a constant-correlation target.
 * Returns the shrunk covariance and the intensity used (0 = sample, 1 = target).
 */
export function ledoitWolf(R) {
  const T = R.length;
  const N = R[0]?.length || 0;
  if (T < 3 || N === 0) return { S: [], intensity: null };
  const { S, mu } = sampleCov(R);
  const sd = S.map((row, i) => Math.sqrt(Math.max(row[i], 1e-16)));
  let rSum = 0;
  let pairs = 0;
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    rSum += S[i][j] / (sd[i] * sd[j]);
    pairs += 1;
  }
  const rBar = pairs ? rSum / pairs : 0;
  const F = S.map((row, i) => row.map((_, j) => (i === j ? S[i][i] : rBar * sd[i] * sd[j])));

  // Asymptotic quantities (Ledoit & Wolf 2004, "Honey, I shrunk...").
  const X = R.map((row) => row.map((x, j) => x - mu[j]));
  let piSum = 0;
  const piMat = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    let s = 0;
    for (let t = 0; t < T; t++) s += (X[t][i] * X[t][j] - S[i][j]) ** 2;
    piMat[i][j] = s / T;
    piSum += piMat[i][j];
  }
  let rho = 0;
  for (let i = 0; i < N; i++) rho += piMat[i][i];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (i === j) continue;
    let tii = 0;
    let tjj = 0;
    for (let t = 0; t < T; t++) {
      tii += (X[t][i] ** 2 - S[i][i]) * (X[t][i] * X[t][j] - S[i][j]);
      tjj += (X[t][j] ** 2 - S[j][j]) * (X[t][i] * X[t][j] - S[i][j]);
    }
    tii /= T;
    tjj /= T;
    rho += (rBar / 2) * ((sd[j] / sd[i]) * tii + (sd[i] / sd[j]) * tjj);
  }
  let gamma = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) gamma += (F[i][j] - S[i][j]) ** 2;
  const kappa = gamma > 0 ? (piSum - rho) / gamma : 0;
  const delta = Math.max(0, Math.min(1, kappa / T));
  const shrunk = S.map((row, i) => row.map((s, j) => delta * F[i][j] + (1 - delta) * s));
  return { S: shrunk, sample: S, mu, intensity: delta, avgCorrelation: rBar };
}

/** Annualise a monthly covariance matrix. */
export function annualise(S) {
  return S.map((row) => row.map((x) => x * 12));
}

export function correlationFromCov(S) {
  const sd = S.map((row, i) => Math.sqrt(Math.max(row[i], 0)));
  return S.map((row, i) => row.map((x, j) => (sd[i] && sd[j] ? x / (sd[i] * sd[j]) : 0)));
}
