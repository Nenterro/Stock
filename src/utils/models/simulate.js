/**
 * Monte Carlo projection of a contribution plan, and stress tests.
 *
 * Projection: block bootstrap of historical monthly USD returns. Whole blocks
 * of consecutive months are resampled together across all assets, so fat
 * tails, cross-market correlation and crisis episodes (including the PKR's)
 * keep their real shape instead of being smoothed into a normal distribution.
 * Each asset's historical mean is replaced by its expected return, so the
 * projection isn't just "the last five years again". Contributions go to the
 * positions furthest below target weight; nothing is sold.
 */

/** Small, fast, seedable PRNG (mulberry32), so a projection is reproducible. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * @param {Object} p
 *   R            T x N historical monthly returns (from risk.monthlyReturns)
 *   symbols      N asset names
 *   expected     N expected annual returns (total, USD) - each asset is re-centred on these
 *   weights      N target weights (sum 1)
 *   startValues  N current values (USD); zeros for a fresh start
 *   monthly      contribution per month (USD)
 *   contributionGrowth  annual growth of the contribution (e.g. 0.05)
 *   years        horizon
 *   paths        simulations (default 5000)
 *   block        block length in months (default 6)
 *   seed
 */
export function projectPlan(p) {
  const T = p.R.length;
  const N = p.symbols.length;
  const months = Math.round((p.years || 10) * 12);
  const paths = p.paths || 5000;
  const block = Math.max(1, Math.min(p.block || 6, T));
  const rand = rng(p.seed ?? 42);
  const w = p.weights;
  const start = p.startValues || new Array(N).fill(0);
  const monthly0 = p.monthly || 0;
  const growth = p.contributionGrowth || 0;

  // Re-centre: replace each asset's historical monthly mean with its expected.
  const histMean = Array.from({ length: N }, (_, j) => p.R.reduce((s, row) => s + row[j], 0) / T);
  const target = (p.expected || histMean.map((m) => (1 + m) ** 12 - 1)).map((e) => (1 + e) ** (1 / 12) - 1);
  const Radj = p.R.map((row) => row.map((x, j) => x - histMean[j] + target[j]));

  const checkpoints = [];
  for (let y = 1; y <= Math.ceil(months / 12); y++) checkpoints.push(Math.min(y * 12, months));
  const values = checkpoints.map(() => new Float64Array(paths));
  const contributedAt = checkpoints.map(() => 0);
  const maxDD = new Float64Array(paths);

  for (let s = 0; s < paths; s++) {
    const v = Float64Array.from(start);
    let monthly = monthly0;
    let peak = v.reduce((a, b) => a + b, 0);
    let worst = 0;
    let cp = 0;
    let contributed = 0;
    let t = 0;
    while (t < months) {
      const b0 = Math.floor(rand() * (T - block + 1));
      for (let k = 0; k < block && t < months; k++, t++) {
        const r = Radj[b0 + k];
        let total = 0;
        for (let j = 0; j < N; j++) {
          v[j] *= 1 + r[j];
          total += v[j];
        }
        // Drawdown on market moves only, before this month's money arrives.
        if (total > peak) peak = total;
        if (peak > 0) worst = Math.min(worst, total / peak - 1);

        if (monthly > 0) {
          const after = total + monthly;
          let gapSum = 0;
          const gaps = new Float64Array(N);
          for (let j = 0; j < N; j++) {
            gaps[j] = Math.max(0, after * w[j] - v[j]);
            gapSum += gaps[j];
          }
          for (let j = 0; j < N; j++) v[j] += gapSum > 0 ? (monthly * gaps[j]) / gapSum : monthly * w[j];
          contributed += monthly;
          peak += monthly;
        }
        if ((t + 1) % 12 === 0) monthly *= 1 + growth;
        if (cp < checkpoints.length && t + 1 === checkpoints[cp]) {
          values[cp][s] = v.reduce((a, b) => a + b, 0);
          if (s === 0) contributedAt[cp] = contributed + start.reduce((a, b) => a + b, 0);
          cp++;
        }
      }
    }
    maxDD[s] = worst;
  }

  const byYear = checkpoints.map((m, i) => {
    const sorted = Array.from(values[i]).sort((a, b) => a - b);
    const invested = contributedAt[i];
    return {
      year: m / 12,
      invested,
      p5: quantile(sorted, 0.05),
      p25: quantile(sorted, 0.25),
      median: quantile(sorted, 0.5),
      p75: quantile(sorted, 0.75),
      p95: quantile(sorted, 0.95),
      probBelowInvested: sorted.filter((x) => x < invested).length / paths
    };
  });
  const dd = Array.from(maxDD).sort((a, b) => a - b);
  return {
    paths,
    months,
    blockMonths: block,
    historyMonths: T,
    byYear,
    maxDrawdown: { median: quantile(dd, 0.5), p10: quantile(dd, 0.1), p1: quantile(dd, 0.01) }
  };
}

/* ------------------------------------------------------------- stress tests */

export const HISTORICAL_SCENARIOS = [
  { key: 'gfc', name: 'Global financial crisis', from: '2007-10-31', to: '2009-02-27' },
  { key: 'pk2018', name: 'Pakistan 2017-18 sell-off and devaluation', from: '2017-05-24', to: '2018-12-31' },
  { key: 'covid', name: 'COVID crash', from: '2020-02-19', to: '2020-03-23' },
  { key: 'pk2022', name: 'Pakistan 2022-23 currency crisis', from: '2022-03-31', to: '2023-06-30' },
  { key: 'us2022', name: '2022 rate shock (tech bear market)', from: '2021-12-31', to: '2022-10-14' }
];

export const HYPOTHETICAL_SCENARIOS = [
  { key: 'pkr30', name: 'Rupee falls 30% overnight', shocks: { pkr: -0.3 } },
  { key: 'psx30', name: 'PSX falls 30% in rupees, rupee falls 15%', shocks: { psxLocal: -0.3, pkr: -0.15 } },
  { key: 'tech40', name: 'Global tech falls 40%, other stocks 15%', shocks: { tech: -0.4, globalEquity: -0.15 } },
  { key: 'global25', name: 'Global stocks fall 25%, Pakistan 10%', shocks: { globalEquity: -0.25, psxLocal: -0.1 } }
];

function closeOnOrBefore(series, date) {
  let best = null;
  for (const p of series) {
    if (p.date <= date) best = p;
    else break;
  }
  return best;
}

/**
 * @param {Array} holdings  [{ symbol, value (USD), currency, sector, kind,
 *                            series: [{date, usd}] (adjusted, USD), proxy: series }]
 */
export function stressTest(holdings, scenarios = { historical: HISTORICAL_SCENARIOS, hypothetical: HYPOTHETICAL_SCENARIOS }) {
  const total = holdings.reduce((a, h) => a + h.value, 0);
  const out = [];

  // A series only covers a window if it starts on or before the window's start.
  const covers = (s, from) => s?.length && s[0].date <= from;
  for (const sc of scenarios.historical || []) {
    let pnl = 0;
    let covered = 0;
    const rows = [];
    for (const h of holdings) {
      const src = covers(h.series, sc.from) ? h.series : covers(h.proxy, sc.from) ? h.proxy : null;
      const a = src && closeOnOrBefore(src, sc.from);
      const b = src && closeOnOrBefore(src, sc.to);
      const r = a && b && a.usd > 0 ? b.usd / a.usd - 1 : null;
      rows.push({ symbol: h.symbol, return: r, basis: r == null ? 'no data' : src === h.series ? 'own history' : 'market proxy' });
      if (r != null) {
        pnl += h.value * r;
        covered += h.value;
      }
    }
    const coverage = total ? covered / total : 0;
    out.push({
      ...sc,
      type: 'historical',
      // On the part with data; null when under half the portfolio is covered.
      portfolioReturn: coverage >= 0.5 ? pnl / covered : null,
      coverage,
      loss: coverage >= 0.5 ? (pnl / covered) * total : null,
      holdings: rows
    });
  }

  for (const sc of scenarios.hypothetical || []) {
    const s = sc.shocks;
    let pnl = 0;
    const rows = [];
    for (const h of holdings) {
      let r;
      if (h.currency === 'PKR') r = (1 + (s.psxLocal || 0)) * (1 + (s.pkr || 0)) - 1;
      else if (h.sector === 'Technology' || h.techHeavy) r = s.tech ?? s.globalEquity ?? 0;
      else r = s.globalEquity ?? 0;
      rows.push({ symbol: h.symbol, return: r });
      pnl += h.value * r;
    }
    out.push({ ...sc, type: 'hypothetical', portfolioReturn: total ? pnl / total : null, loss: pnl, holdings: rows });
  }
  return out;
}
