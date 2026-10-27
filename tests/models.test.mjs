import test from 'node:test';
import assert from 'node:assert/strict';
import { ledoitWolf, sampleCov, monthlyReturns } from '../src/utils/models/risk.js';
import { project, meanVariance, blackLitterman, riskParity, stats, invert, matVec } from '../src/utils/models/optimize.js';
import { projectPlan, stressTest, rng } from '../src/utils/models/simulate.js';
import { constructPortfolio, assetView } from '../src/utils/models/construct.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

function randomReturns(T, vols, corr, seed = 7) {
  const r = rng(seed);
  const normal = () => {
    const u = Math.max(r(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  };
  return Array.from({ length: T }, () => {
    const common = normal();
    return vols.map((v) => v * (Math.sqrt(corr) * common + Math.sqrt(1 - corr) * normal()) + 0.005);
  });
}

test('matrix inverse', () => {
  const A = [[4, 1], [2, 3]];
  const I = invert(A).map((row) => matVec(A, row));
  // A * A^-1 columns: check via product of A and inverse rows transposed
  const inv = invert(A);
  const prod = A.map((row) => inv[0].map((_, j) => row.reduce((s, a, k) => s + a * inv[k][j], 0)));
  close(prod[0][0], 1);
  close(prod[0][1], 0);
  close(prod[1][1], 1);
  assert.ok(I.length === 2);
});

test('Ledoit-Wolf shrinkage stays between sample and target', () => {
  const R = randomReturns(60, [0.04, 0.06, 0.05, 0.08], 0.3);
  const lw = ledoitWolf(R);
  assert.ok(lw.intensity >= 0 && lw.intensity <= 1);
  const { S } = sampleCov(R);
  // Variances are untouched by a constant-correlation target.
  for (let i = 0; i < 4; i++) close(lw.S[i][i], S[i][i], 1e-12);
});

test('projection respects bounds, budget and sleeves', () => {
  const v = [0.9, 0.5, -0.2, 0.3, 0.1];
  const w = project(v, [0, 0, 0, 0, 0], [0.5, 0.5, 0.5, 0.5, 0.5], [
    { idx: [0, 1], min: 0.35, max: 0.45 },
    { idx: [2, 3, 4], min: 0.55, max: 0.65 }
  ]);
  close(w.reduce((a, b) => a + b, 0), 1, 1e-9);
  assert.ok(w.every((x) => x >= -1e-9 && x <= 0.5 + 1e-9));
  const g1 = w[0] + w[1];
  assert.ok(g1 >= 0.35 - 1e-6 && g1 <= 0.45 + 1e-6, `g1 ${g1}`);
});

test('minimum variance of two assets matches the closed form', () => {
  const s1 = 0.04;
  const s2 = 0.09;
  const s12 = 0.012;
  const S = [[s1, s12], [s12, s2]];
  const w = meanVariance({ mu: null, S, lambda: 1, iters: 20000 });
  close(w[0], (s2 - s12) / (s1 + s2 - 2 * s12), 1e-5);
});

test('Black-Litterman: no views gives the prior; a near-certain view wins', () => {
  const S = [[0.04, 0.01], [0.01, 0.09]];
  const wRef = [0.6, 0.4];
  const a = blackLitterman({ S, wRef, delta: 3, tau: 0.05, views: [], rf: 0.02 });
  assert.deepEqual(a.mu, a.prior);
  const b = blackLitterman({ S, wRef, delta: 3, tau: 0.05, views: [{ index: 1, q: 0.3, confidence: 0.99 }], rf: 0.02 });
  assert.ok(Math.abs(b.mu[1] - 0.3) < 0.01, `posterior ${b.mu[1]}`);
  assert.ok(b.mu[0] > a.prior[0]); // correlated asset is pulled up too
});

test('risk parity equalises risk contributions', () => {
  const S = [[0.04, 0.006, 0.002], [0.006, 0.09, 0.01], [0.002, 0.01, 0.16]];
  const w = riskParity({ S });
  const rc = stats(w, null, S).riskContributions;
  for (const x of rc) close(x, 1 / 3, 1e-4);
});

test('projection with no volatility matches compound arithmetic', () => {
  const R = Array.from({ length: 24 }, () => [0.01, 0.01]);
  const out = projectPlan({ R, symbols: ['A', 'B'], expected: [Math.pow(1.01, 12) - 1, Math.pow(1.01, 12) - 1], weights: [0.5, 0.5], startValues: [1000, 0], monthly: 100, years: 1, paths: 20, seed: 3 });
  // FV = 1000*1.01^12 + 100 * sum_{k=0..11} 1.01^k (money arrives after each month's return)
  let fv = 1000 * Math.pow(1.01, 12);
  for (let k = 0; k < 12; k++) fv += 100 * Math.pow(1.01, k);
  close(out.byYear[0].median, fv, 1e-6);
  close(out.byYear[0].invested, 1000 + 1200, 1e-9);
  assert.equal(out.byYear[0].probBelowInvested, 0);
});

test('stress test applies own history, proxies and shocks', () => {
  const series = [{ date: '2020-02-19', usd: 100 }, { date: '2020-03-23', usd: 70 }];
  const res = stressTest(
    [
      { symbol: 'A', value: 1000, currency: 'USD', series },
      { symbol: 'P', value: 1000, currency: 'PKR', series: [], proxy: [{ date: '2020-02-19', usd: 10 }, { date: '2020-03-23', usd: 8 }] }
    ],
    { historical: [{ key: 'c', name: 'c', from: '2020-02-19', to: '2020-03-23' }], hypothetical: [{ key: 'h', name: 'h', shocks: { pkr: -0.3, globalEquity: -0.1 } }] }
  );
  close(res[0].portfolioReturn, (-300 - 200) / 2000);
  close(res[0].coverage, 1);
  assert.equal(res[0].holdings[1].basis, 'market proxy');
  close(res[1].portfolioReturn, (-100 - 300) / 2000);
});

test('monthlyReturns fills a short history from its proxy and ends at the last full month', () => {
  const mk = (start, n, f) => Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(start, i, 28));
    return { date: d.toISOString().slice(0, 10), price: f(i) };
  });
  const idx = mk(2020, 40, (i) => 100 * Math.pow(1.01, i));
  const young = mk(2021, 28, (i) => 50 * Math.pow(1.02, i)); // starts a year later
  const out = monthlyReturns({ IDX: { history: idx, currency: 'USD' }, Y: { history: young, currency: 'USD', proxy: 'IDX' } }, { months: 36, today: '2023-05-15' });
  assert.ok(out.filled.Y > 0);
  assert.equal(out.months[out.months.length - 1], '2023-04');
  assert.ok(out.R.every((row) => row.every((x) => x != null)));
});

test('construction end to end: weights valid, sleeves within bounds', () => {
  const T = 72;
  const R = randomReturns(T, [0.04, 0.045, 0.07, 0.08, 0.09], 0.4, 11);
  const hist = (j) => {
    let px = 100;
    return R.map((row, t) => {
      px *= 1 + row[j];
      const d = new Date(Date.UTC(2019, t, 28));
      return { date: d.toISOString().slice(0, 10), price: px };
    });
  };
  const assets = [
    { symbol: 'CORE1', sleeve: 'globalCore', currency: 'USD', history: hist(0), expected: 0.07, confidence: 0.6 },
    { symbol: 'CORE2', sleeve: 'globalCore', currency: 'USD', history: hist(1), expected: 0.08, confidence: 0.6 },
    { symbol: 'G1', sleeve: 'globalStocks', currency: 'USD', history: hist(2), expected: 0.1, confidence: 0.3 },
    { symbol: 'G2', sleeve: 'globalStocks', currency: 'USD', history: hist(3), expected: 0.09, confidence: 0.3 },
    { symbol: 'PK1', sleeve: 'pakistan', currency: 'USD', history: hist(4), expected: 0.15, confidence: 0.3 }
  ];
  const out = constructPortfolio({ assets, today: '2025-06-01', maxStockWeight: 0.35 });
  for (const [key, pf] of Object.entries(out.portfolios)) {
    const sum = Object.values(pf.weights).reduce((a, b) => a + b, 0);
    close(sum, 1, 1e-6);
    if (key === 'riskParity') continue;
    assert.ok(pf.sleeves.globalCore >= 0.35 - 1e-4 && pf.sleeves.globalCore <= 0.45 + 1e-4, `${key} core ${pf.sleeves.globalCore}`);
  }
  assert.ok(out.portfolios.recommended.expectedReturn >= out.portfolios.minimumVariance.expectedReturn - 1e-9);
  assert.ok(out.portfolios.minimumVariance.volatility <= out.portfolios.recommended.volatility + 1e-9);
});

test('asset views: funds use their CMA; stocks are shrunk toward the market', () => {
  const er = {
    funds: [{ symbol: 'ISWD', expected: { base: { usd: 0.065 } } }],
    markets: [{ key: 'us', name: 'United States', expected: { base: { usd: 0.07 } }, depreciationVsUsd: 0 }, { key: 'psx', name: 'Pakistan', expected: { base: { usd: 0.15 } }, depreciationVsUsd: 0.1 }]
  };
  assert.equal(assetView({ symbol: 'ISWD' }, er).expected, 0.065);
  const s = assetView({ symbol: 'X', currency: 'USD', region: 'us', impliedReturn: 0.17, scoreCoverage: 1 }, er);
  close(s.expected, 0.5 * 0.17 + 0.5 * 0.07);
  const p = assetView({ symbol: 'P', currency: 'PKR', impliedReturn: 0.32 }, er);
  close(p.expected, 0.5 * (1.32 / 1.1 - 1) + 0.5 * 0.15);
});

test('concentration limits and minimum position shape a wide candidate list', () => {
  const T = 60;
  const n = 12;
  const R = randomReturns(T, Array.from({ length: n }, (_, j) => 0.05 + 0.005 * j), 0.3, 17);
  const hist = (j) => {
    let px = 100;
    return R.map((row, t) => {
      px *= 1 + row[j];
      return { date: new Date(Date.UTC(2020, t, 28)).toISOString().slice(0, 10), price: px };
    });
  };
  // Four cheap tankers the views love, plus a spread of other businesses.
  const sectors = ['Energy', 'Energy', 'Energy', 'Energy', 'Healthcare', 'Healthcare', 'Technology', 'Industrials', 'Basic Materials'];
  const assets = [
    { symbol: 'CORE', sleeve: 'globalCore', currency: 'USD', history: hist(0), expected: 0.07, confidence: 0.6 },
    ...sectors.map((sector, k) => ({ symbol: `S${k}`, sleeve: 'globalStocks', currency: 'USD', history: hist(k + 1), sector, industry: k < 4 ? 'Oil & Gas Midstream' : `${sector} A`, expected: k < 4 ? 0.2 : 0.09, confidence: 0.45 })),
    { symbol: 'PK1', sleeve: 'pakistan', currency: 'USD', history: hist(10), expected: 0.12 },
    { symbol: 'PK2', sleeve: 'pakistan', currency: 'USD', history: hist(11), expected: 0.12 }
  ];
  const sleeves = { globalCore: { target: 0.35, min: 0.35, max: 0.4 }, globalStocks: { target: 0.35, min: 0.3, max: 0.35 }, pakistan: { target: 0.3, min: 0.28, max: 0.3 } };
  const free = constructPortfolio({ assets, sleeves, today: '2025-03-01', maxStockWeight: 0.1, sectorCap: 1, industryCap: 1 });
  const capped = constructPortfolio({ assets, sleeves, today: '2025-03-01', maxStockWeight: 0.1, sectorCap: 0.4, industryCap: 0.25, minPosition: 0.04 });
  const energy = (pf) => ['S0', 'S1', 'S2', 'S3'].reduce((s, k) => s + (pf.weights[k] || 0), 0);
  // Unconstrained, the tankers take most of the sleeve; capped, one industry holds at most 25% of it.
  assert.ok(energy(free.portfolios.recommended) > 0.25 * 0.35 + 0.01, `free energy ${energy(free.portfolios.recommended)}`);
  assert.ok(energy(capped.portfolios.recommended) <= 0.25 * 0.35 + 1e-4, `capped energy ${energy(capped.portfolios.recommended)}`);
  for (const [s, w] of Object.entries(capped.portfolios.recommended.weights)) assert.ok(w === 0 || w >= 0.04 - 1e-4, `${s} ${w}`);
  close(Object.values(capped.portfolios.recommended.weights).reduce((a, b) => a + b, 0), 1, 1e-4);
  assert.ok(capped.notes.some((x) => /Concentration limits/.test(x)));
});

test('a sleeve with too few candidates is capped, not infeasible', () => {
  const T = 60;
  const R = randomReturns(T, [0.04, 0.07, 0.08, 0.09, 0.09], 0.4, 5);
  const hist = (j) => {
    let px = 100;
    return R.map((row, t) => {
      px *= 1 + row[j];
      return { date: new Date(Date.UTC(2020, t, 28)).toISOString().slice(0, 10), price: px };
    });
  };
  const assets = [
    { symbol: 'CORE', sleeve: 'globalCore', currency: 'USD', history: hist(0), expected: 0.07 },
    { symbol: 'G1', sleeve: 'globalStocks', currency: 'USD', history: hist(1), expected: 0.09 },
    { symbol: 'G2', sleeve: 'globalStocks', currency: 'USD', history: hist(2), expected: 0.09 },
    { symbol: 'P1', sleeve: 'pakistan', currency: 'USD', history: hist(3), expected: 0.12 },
    { symbol: 'P2', sleeve: 'pakistan', currency: 'USD', history: hist(4), expected: 0.12 }
  ];
  const out = constructPortfolio({ assets, today: '2025-03-01', maxStockWeight: 0.1 });
  const rec = out.portfolios.recommended;
  close(Object.values(rec.weights).reduce((a, b) => a + b, 0), 1, 1e-6);
  assert.ok(rec.sleeves.globalStocks <= 0.2 + 1e-6);
  assert.ok(rec.sleeves.pakistan <= 0.2 + 1e-6);
  assert.ok(out.notes.length === 2, out.notes.join(' | '));
});
