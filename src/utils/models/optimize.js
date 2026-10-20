/**
 * Portfolio construction: Black-Litterman expected returns and a constrained
 * mean-variance optimiser, with minimum-variance, risk-parity and max-Sharpe
 * alternatives for comparison.
 *
 * Why Black-Litterman: plugging raw return forecasts into mean-variance gives
 * extreme, unstable portfolios, because the optimiser chases estimation error.
 * BL starts from the returns implied by a sensible reference portfolio and
 * moves away from them only as far as each view's confidence justifies.
 *
 * Constraints (all optional): long-only bounds per asset, and sleeve bounds
 * on groups of assets (e.g. global funds 35-45%). The feasible set is a box
 * intersected with the budget hyperplane and group slabs; projections onto it
 * use Dykstra's algorithm, and the optimiser is accelerated projected
 * gradient ascent (FISTA). Annual units throughout; weights sum to 1.
 */

/* ------------------------------------------------------------------ algebra */

export function matVec(A, x) {
  return A.map((row) => row.reduce((s, a, j) => s + a * x[j], 0));
}

export function dot(a, b) {
  return a.reduce((s, x, i) => s + x * b[i], 0);
}

/** Inverse by Gauss-Jordan with partial pivoting. */
export function invert(A) {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) throw new Error('Matrix is singular');
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c];
    for (let j = 0; j < 2 * n; j++) M[c][j] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row) => row.slice(n));
}

function addM(A, B) {
  return A.map((row, i) => row.map((x, j) => x + B[i][j]));
}

function scaleM(A, k) {
  return A.map((row) => row.map((x) => x * k));
}

function maxEigen(S) {
  let v = S.map(() => 1);
  let lambda = 0;
  for (let i = 0; i < 100; i++) {
    const w = matVec(S, v);
    const norm = Math.sqrt(dot(w, w)) || 1;
    v = w.map((x) => x / norm);
    lambda = norm;
  }
  return lambda;
}

/* --------------------------------------------------------- portfolio stats */

export function stats(w, mu, S, rf = 0) {
  const Sw = matVec(S, w);
  const variance = Math.max(dot(w, Sw), 0);
  const vol = Math.sqrt(variance);
  const ret = mu ? dot(w, mu) : null;
  const sds = S.map((row, i) => Math.sqrt(Math.max(row[i], 0)));
  return {
    expectedReturn: ret,
    volatility: vol,
    sharpe: ret != null && vol > 0 ? (ret - rf) / vol : null,
    // Share of total risk each position contributes; sums to 1.
    riskContributions: variance > 0 ? w.map((wi, i) => (wi * Sw[i]) / variance) : w.map(() => null),
    // Weighted average volatility / portfolio volatility: >1 means
    // diversification is doing work.
    diversificationRatio: vol > 0 ? dot(w, sds) / vol : null
  };
}

/* ---------------------------------------------------------------- projection */

/** Project v onto { l <= w <= u, sum w = 1 } exactly (bisection on the shift). */
function projectBoxBudget(v, l, u) {
  const f = (tau) => v.reduce((s, x, i) => s + Math.min(u[i], Math.max(l[i], x - tau)), 0) - 1;
  let lo = Math.min(...v.map((x, i) => x - u[i])) - 1;
  let hi = Math.max(...v.map((x, i) => x - l[i])) + 1;
  for (let k = 0; k < 100; k++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  const tau = (lo + hi) / 2;
  return v.map((x, i) => Math.min(u[i], Math.max(l[i], x - tau)));
}

/** Project onto one group slab { min <= sum_{i in g} w_i <= max }. */
function projectGroup(v, g) {
  const s = g.idx.reduce((a, i) => a + v[i], 0);
  const target = s > g.max ? g.max : s < g.min ? g.min : null;
  if (target == null) return v;
  const shift = (target - s) / g.idx.length;
  const out = [...v];
  for (const i of g.idx) out[i] += shift;
  return out;
}

/** Dykstra's alternating projections onto box+budget and each group slab. */
export function project(v, l, u, groups = [], iters = 400) {
  if (!groups.length) return projectBoxBudget(v, l, u);
  const sets = [(x) => projectBoxBudget(x, l, u), ...groups.map((g) => (x) => projectGroup(x, g))];
  let x = [...v];
  const incr = sets.map(() => v.map(() => 0));
  for (let k = 0; k < iters; k++) {
    let change = 0;
    for (let s = 0; s < sets.length; s++) {
      const y = x.map((xi, i) => xi + incr[s][i]);
      const p = sets[s](y);
      incr[s] = y.map((yi, i) => yi - p[i]);
      change += p.reduce((a, pi, i) => a + Math.abs(pi - x[i]), 0);
      x = p;
    }
    if (change < 1e-12) break;
  }
  // Finish on the box+budget set so bounds and the budget hold exactly.
  return projectBoxBudget(x, l, u);
}

function checkFeasible(n, l, u, groups) {
  const sl = l.reduce((a, b) => a + b, 0);
  const su = u.reduce((a, b) => a + b, 0);
  if (sl > 1 + 1e-9) throw new Error(`Infeasible: minimum weights add to ${(sl * 100).toFixed(1)}%`);
  if (su < 1 - 1e-9) throw new Error(`Infeasible: maximum weights add to only ${(su * 100).toFixed(1)}%`);
  for (const g of groups) {
    const gu = g.idx.reduce((a, i) => a + u[i], 0);
    const gl = g.idx.reduce((a, i) => a + l[i], 0);
    if (gu < g.min - 1e-9) throw new Error(`Infeasible: ${g.name} needs ${(g.min * 100).toFixed(0)}% but its assets can hold at most ${(gu * 100).toFixed(0)}%`);
    if (gl > g.max + 1e-9) throw new Error(`Infeasible: ${g.name} minimums exceed its ${(g.max * 100).toFixed(0)}% cap`);
  }
}

/* ------------------------------------------------------------------ optimise */

/**
 * maximise mu'w - (lambda/2) w'Sw  subject to bounds and groups.
 * lambda = risk aversion (higher = safer). mu null or zeros = minimum variance.
 */
export function meanVariance({ mu, S, lambda = 3, lower, upper, groups = [], w0 = null, iters = 3000 }) {
  const n = S.length;
  const l = lower || new Array(n).fill(0);
  const u = upper || new Array(n).fill(1);
  checkFeasible(n, l, u, groups);
  const m = mu || new Array(n).fill(0);
  const L = lambda * maxEigen(S) || 1;
  const step = 1 / L;
  let w = project(w0 || new Array(n).fill(1 / n), l, u, groups);
  let y = [...w];
  let t = 1;
  for (let k = 0; k < iters; k++) {
    const Sy = matVec(S, y);
    const grad = m.map((mi, i) => mi - lambda * Sy[i]);
    const wNext = project(y.map((yi, i) => yi + step * grad[i]), l, u, groups, 200);
    const tNext = (1 + Math.sqrt(1 + 4 * t * t)) / 2;
    y = wNext.map((wi, i) => wi + ((t - 1) / tNext) * (wi - w[i]));
    const moved = wNext.reduce((a, wi, i) => a + Math.abs(wi - w[i]), 0);
    w = wNext;
    t = tNext;
    if (moved < 1e-10) break;
  }
  return w;
}

/** Highest Sharpe ratio portfolio within the constraints (search over lambda). */
export function maxSharpe({ mu, S, rf = 0, lower, upper, groups = [] }) {
  let best = null;
  for (const lambda of [0.5, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]) {
    const w = meanVariance({ mu, S, lambda, lower, upper, groups, w0: best?.w });
    const s = stats(w, mu, S, rf);
    if (!best || (s.sharpe ?? -Infinity) > (best.sharpe ?? -Infinity)) best = { w, lambda, sharpe: s.sharpe };
  }
  return best;
}

/**
 * Equal risk contribution (risk parity), long-only, fully invested. Group
 * constraints are applied afterwards by projection, so with tight sleeves
 * the result is "as close to risk parity as the sleeves allow".
 */
export function riskParity({ S, budgets = null, lower, upper, groups = [], iters = 500 }) {
  const n = S.length;
  const b = budgets || new Array(n).fill(1 / n);
  let w = S.map((row, i) => 1 / Math.sqrt(Math.max(row[i], 1e-12)));
  let s = w.reduce((a, x) => a + x, 0);
  w = w.map((x) => x / s);
  for (let k = 0; k < iters; k++) {
    const Sw = matVec(S, w);
    const variance = dot(w, Sw);
    const next = w.map((wi, i) => wi * Math.sqrt((b[i] * variance) / Math.max(wi * Sw[i], 1e-16)));
    s = next.reduce((a, x) => a + x, 0);
    const norm = next.map((x) => x / s);
    const moved = norm.reduce((a, x, i) => a + Math.abs(x - w[i]), 0);
    w = norm;
    if (moved < 1e-10) break;
  }
  if (lower || upper || groups.length) w = project(w, lower || w.map(() => 0), upper || w.map(() => 1), groups);
  return w;
}

/* --------------------------------------------------------- Black-Litterman */

/**
 * @param {number[][]} S     annual covariance
 * @param {number[]}   wRef  reference portfolio (what you'd hold with no views)
 * @param {number}     delta risk aversion implied by the reference portfolio
 * @param {number}     tau   uncertainty of the prior (~1 / years of data)
 * @param {Array}      views [{ index, q (expected total return), confidence 0..1 }]
 * @param {number}     rf    risk-free rate (views and output are total returns)
 * @returns {{ mu, prior }}  posterior and prior expected total returns
 */
export function blackLitterman({ S, wRef, delta = 2.5, tau = 0.05, views = [], rf = 0 }) {
  const n = S.length;
  const pi = matVec(S, wRef).map((x) => delta * x); // implied excess returns
  const prior = pi.map((x) => x + rf);
  if (!views.length) return { mu: prior, prior, implied: pi };

  const tS = scaleM(S, tau);
  const tSinv = invert(tS);
  // Absolute views: P picks one asset each; Omega from confidence
  // (confidence 1 -> view is certain, 0 -> ignored).
  const A = tSinv.map((row) => [...row]);
  const bvec = matVec(tSinv, pi);
  for (const v of views) {
    const c = Math.min(0.99, Math.max(0.01, v.confidence ?? 0.5));
    const omega = (tau * S[v.index][v.index] * (1 - c)) / c;
    A[v.index][v.index] += 1 / omega;
    bvec[v.index] += (v.q - rf) / omega;
  }
  const post = matVec(invert(A), bvec);
  return { mu: post.map((x) => x + rf), prior, implied: pi };
}

/** Risk aversion implied by a reference portfolio's expected excess return. */
export function impliedDelta(wRef, S, expectedExcess) {
  const v = dot(wRef, matVec(S, wRef));
  return v > 0 && expectedExcess > 0 ? Math.min(10, Math.max(1, expectedExcess / v)) : 2.5;
}

export { addM, scaleM };
