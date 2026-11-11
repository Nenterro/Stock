/**
 * One-off analysis (November 2026 model review): how the optimum moves with
 * the investor's risk aversion, the sleeve bounds and the Pakistan return
 * assumption, and how well the predicted volatility holds out of sample.
 *
 * A direct solve on the production building blocks (same returns, covariance
 * and Black-Litterman as constructPortfolio), with sleeve bounds and a
 * per-stock cap only: no concentration caps, minimum position or alternative
 * portfolios, which make a full run take over ten minutes.
 *
 *   node mcp/scripts/utility-sweep.mjs SYM1,SYM2,... > out.json
 */
import { api } from '../lib/api.js';
import * as pf from '../lib/portfolio.js';
import { buildInputs } from '../../src/utils/models/pipeline.js';
import { DEFAULT_SLEEVES } from '../../src/utils/models/construct.js';
import { monthlyReturns, ledoitWolf, annualise } from '../../src/utils/models/risk.js';
import { blackLitterman, impliedDelta, meanVariance, stats, dot } from '../../src/utils/models/optimize.js';

const extra = (process.argv[2] || '').split(',').filter(Boolean);
const pos = await pf.positions({ currency: 'USD' });
const settings = (await pf.research()).find((r) => r.kind === 'settings');
const rf = settings?.data?.riskFreeRate?.USD ?? 0.04;
const fxSeries = await api.fxSeries();
const inputs = await buildInputs({
  holdings: pos.holdings,
  extraSymbols: extra,
  fetchers: {
    histories: (syms, range = '10y') => api.historyBatch(syms, range),
    expectedReturns: () => api.expectedReturns(),
    screenerRow: (s) => api.screenerRow(s)
  }
});

const rets = monthlyReturns(Object.fromEntries(inputs.assets.map((a) => [a.symbol, { history: a.history, currency: a.currency, proxy: a.proxy }])), { fxSeries, months: 60, proxies: inputs.proxies });
const assets = rets.symbols.map((s) => inputs.assets.find((a) => a.symbol === s));
const n = assets.length;
const MAX_STOCK = 0.075;
const upper = assets.map((a) => (a.sleeve === 'globalCore' ? 1 : MAX_STOCK));
const lower = assets.map(() => 0);
const sleeveKeys = ['globalCore', 'globalStocks', 'pakistan'];
const idxOf = (k) => assets.map((a, i) => (a.sleeve === k ? i : -1)).filter((i) => i >= 0);

function solve({ R, sleeves, riskAversion, pakistanHaircut = 0, evalR = null }) {
  const S = annualise(ledoitWolf(R).S);
  const vol = S.map((row, i) => Math.sqrt(row[i]));
  const groups = sleeveKeys.map((k) => ({ name: k, key: k, idx: idxOf(k), min: sleeves[k].min, max: sleeves[k].max, target: sleeves[k].target }));
  const wRef = new Array(n).fill(0);
  for (const g of groups) {
    const inv = g.idx.map((i) => 1 / vol[i]);
    const s = inv.reduce((a, b) => a + b, 0);
    g.idx.forEach((i, k) => (wRef[i] = (g.target * inv[k]) / s));
  }
  const expected = assets.map((a) => (a.expected == null ? null : a.expected - (a.sleeve === 'pakistan' ? pakistanHaircut : 0)));
  const delta = impliedDelta(wRef, S, dot(wRef, expected.map((e) => e ?? rf)) - rf);
  const views = assets.map((a, i) => (expected[i] != null ? { index: i, q: expected[i], confidence: a.confidence ?? 0.3 } : null)).filter(Boolean);
  const bl = blackLitterman({ S, wRef, delta, tau: 3 / R.length, views, rf });
  const lambda = riskAversion ?? delta;
  const w = meanVariance({ mu: bl.mu, S, lambda, lower, upper, groups, w0: wRef });
  const st = stats(w, bl.mu, S, rf);
  const out = {
    riskAversion: lambda,
    expectedReturn: st.expectedReturn,
    volatility: st.volatility,
    sharpe: st.sharpe,
    // Expected long-run compound growth: mean - variance / 2.
    growth: st.expectedReturn - st.volatility ** 2 / 2,
    sleeves: Object.fromEntries(groups.map((g) => [g.key, g.idx.reduce((s, i) => s + w[i], 0)])),
    positions: w.filter((x) => x > 0.01).length,
    top: Object.fromEntries(assets.map((a, i) => [a.symbol, w[i]]).filter(([, x]) => x > 0.01).sort((a, b) => b[1] - a[1]).slice(0, 18))
  };
  if (evalR) {
    // Realised volatility of these weights (held fixed) over months the
    // covariance never saw.
    const p = evalR.map((row) => dot(row, w));
    const m = p.reduce((a, b) => a + b, 0) / p.length;
    out.realisedVolatility = Math.sqrt((p.reduce((a, b) => a + (b - m) ** 2, 0) / (p.length - 1)) * 12);
    const pr = evalR.map((row) => dot(row, wRef));
    const mr = pr.reduce((a, b) => a + b, 0) / pr.length;
    out.referenceRealisedVolatility = Math.sqrt((pr.reduce((a, b) => a + (b - mr) ** 2, 0) / (pr.length - 1)) * 12);
    out.referencePredictedVolatility = stats(wRef, bl.mu, S, rf).volatility;
  }
  return out;
}

const policy = DEFAULT_SLEEVES;
const free = Object.fromEntries(sleeveKeys.map((k) => [k, { ...DEFAULT_SLEEVES[k], min: 0, max: 1 }]));
const R = rets.R;
const half = Math.floor(R.length / 2);
const result = { months: R.length, assets: n, dropped: rets.dropped, rf, sweep: [], pakistan: [], outOfSample: [] };
for (const [name, sleeves] of [['policy', policy], ['free', free]]) {
  for (const riskAversion of [undefined, 2.5, 2, 1.5, 1]) result.sweep.push({ sleeves: name, ...solve({ R, sleeves, riskAversion }) });
  // Pakistan's base case is about twice its long-run realised dollar return.
  for (const pakistanHaircut of [0, 0.03, 0.05]) result.pakistan.push({ sleeves: name, pakistanHaircut, ...solve({ R, sleeves, riskAversion: 2, pakistanHaircut }) });
  // Fit on the first half, hold through the second.
  result.outOfSample.push({ sleeves: name, ...solve({ R: R.slice(0, half), sleeves, evalR: R.slice(half) }) });
}
console.log(JSON.stringify(result));
process.exit(0);
