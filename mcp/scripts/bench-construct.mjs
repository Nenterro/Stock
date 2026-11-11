/**
 * Time the full portfolio construction on one real input set.
 *
 *   node mcp/scripts/bench-construct.mjs fetch SYM1,SYM2,... cache.json   # fetch inputs once
 *   node mcp/scripts/bench-construct.mjs run cache.json [riskAversion]    # time a full run
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { runModels, buildInputs } from '../../src/utils/models/pipeline.js';

const [mode, a, b] = process.argv.slice(2);
if (mode === 'fetch') {
  const { api } = await import('../lib/api.js');
  const pf = await import('../lib/portfolio.js');
  const pos = await pf.positions({ currency: 'USD' });
  const settings = (await pf.research()).find((r) => r.kind === 'settings');
  const inputs = await buildInputs({
    holdings: pos.holdings,
    extraSymbols: a.split(','),
    fetchers: { histories: (syms, range = '10y') => api.historyBatch(syms, range), expectedReturns: () => api.expectedReturns(), screenerRow: (s) => api.screenerRow(s) }
  });
  writeFileSync(b, JSON.stringify({ inputs, holdings: pos.holdings, fxSeries: await api.fxSeries(), rf: settings?.data?.riskFreeRate?.USD ?? 0.04 }));
  console.log('cached', inputs.assets.length, 'assets');
} else {
  const c = JSON.parse(readFileSync(a, 'utf8'));
  const t0 = Date.now();
  const r = runModels({ ...c.inputs, holdings: c.holdings, fxSeries: c.fxSeries, rf: c.rf, monthly: 2500, contributionGrowth: 0.05, years: 10, investNow: 30000, minPositionUsd: 500, maxStockWeight: 0.06, riskAversion: b ? Number(b) : undefined, paths: 2000 });
  const p = r.portfolios.recommended;
  console.log(JSON.stringify({
    seconds: (Date.now() - t0) / 1000,
    riskAversion: r.riskAversion,
    expectedReturn: p.expectedReturn,
    volatility: p.volatility,
    sharpe: p.sharpe,
    sleeves: p.sleeves,
    positions: Object.values(p.weights).filter((w) => w > 0.004).length,
    weights: Object.fromEntries(Object.entries(p.weights).filter(([, w]) => w > 0.004).sort((x, y) => y[1] - x[1])),
    year10: r.projections.recommended.byYear.at(-1),
    maxDrawdown: r.projections.recommended.maxDrawdown,
    notes: r.notes
  }));
}
process.exit(0);
