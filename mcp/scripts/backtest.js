#!/usr/bin/env node
/**
 * Walk-forward backtest of the investment system (see Personal Investment/
 * status.md, "Backtest"). Runs on the home server or anywhere with the
 * stock-api token.
 *
 * Each month, using only what was known at that month's end (the backend's
 * time machine, /api/backtest/rows):
 *   1. holdings are marked to market; a PSX stock that stopped trading is
 *      sold at its last price; PSX dividends are taxed
 *   2. the month's contribution arrives in USD
 *   3. the strategy sets target weights (rebalancing every `rebalance`
 *      months; new money every month)
 *   4. trades follow the policy's currency rule: USD can become PKR, never
 *      the reverse. New money tops up the underweight side; within each
 *      currency, holdings are traded to target on rebalance dates.
 *
 * Strategies (all fed the same contributions):
 *   acwi            100% MSCI ACWI (plain global benchmark)
 *   iswd            100% MSCI World Islamic
 *   passive         policy split: 70% MSCI World Islamic, 30% PSX passive
 *                   (top 30 Shariah stocks by market cap, cap-weighted: a
 *                   KMI-30 rebuilt from point-in-time data)
 *   picks           policy split, PSX sleeve = top N by composite score
 *                   (Shariah, grade A/B), equal weight
 *   optimizer       the production portfolio construction
 *                   (src/utils/models/construct.js) on Islamic funds + the
 *                   top-N PSX candidates, views from as-of valuations
 *   optimizer-gold  optimizer with gold (GLD) allowed in the global core
 *
 * Not testable, so not tested: global individual stock picking (the global
 * stocks sleeve falls to the funds, as the production code itself does when
 * it has no candidates), historical views on global funds (no point-in-time
 * P/E for the Islamic indices: funds get no view, i.e. equilibrium).
 *
 * Usage: node mcp/scripts/backtest.js [--strategy=all|acwi|...] [--from=2014-07]
 *        [--to=2022-12] [--holdout] [--monthly=2500] [--picks=15] [--rebalance=3]
 *        [--out=path.json]
 * 2023-01 onwards is held out unless --holdout is given (look once, at the end).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { json } from '../lib/backend.js';
import { constructPortfolio, assetView, DEFAULT_SLEEVES } from '../../src/utils/models/construct.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);
const HOLDOUT_FROM = '2023-01';
const CFG = {
  from: args.from || '2014-07',
  to: args.holdout === 'true' ? args.to || '2026-09' : args.to && args.to < HOLDOUT_FROM ? args.to : '2022-12',
  monthly: Number(args.monthly || 2500),
  initial: Number(args.initial || 0),
  picks: Number(args.picks || 15),
  rebalance: Number(args.rebalance || 3),
  // Per-side trading costs, the USD->PKR conversion spread, Pakistani taxes
  // (flat filer rates; the actual rates changed over the period).
  costs: { psx: 0.0035, fund: 0.001, fx: 0.0075 },
  tax: { psxDividend: 0.15, psxCgt: 0.15 },
  strategies: (args.strategy || 'all') === 'all' ? ['acwi', 'iswd', 'passive', 'picks', 'optimizer', 'optimizer-gold'] : args.strategy.split(',')
};

const addMonths = (m, k) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1 + k, 1)).toISOString().slice(0, 7);
};
const monthList = (a, b) => {
  const out = [];
  for (let m = a; m <= b; m = addMonths(m, 1)) out.push(m);
  return out;
};

/* ------------------------------------------------------------------ data */

let D = null;
async function loadData() {
  const s = await json('/api/backtest/series?psx=all');
  const byM = (list, field) => new Map(list.map((x) => [x.m, field ? x[field] : x]));
  D = {
    funds: Object.fromEntries(Object.entries(s.assets).map(([k, v]) => [k, byM(v.months, 'tr')])),
    usdpkr: byM(s.fx.USDPKR, 'rate'),
    psx: Object.fromEntries(Object.entries(s.psx).map(([k, v]) => [k, { byM: byM(v), last: v[v.length - 1]?.m }])),
    notes: s.notes
  };
  const st = await json('/api/archive/status');
  D.archivePeriods = st.periods;
}

// Time-machine rows, cached per archive state (they change as reports arrive).
async function rowsAt(m) {
  const dir = join(here, '..', '.backtest-cache', `archive-${D.archivePeriods}`);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `rows-${m}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  const r = await json(`/api/backtest/rows?month=${m}`);
  writeFileSync(f, JSON.stringify(r));
  return r;
}

/* ------------------------------------------------------------- strategies */

const shariahCandidates = (rows) => rows.filter((r) => r.isShariah === true && r.dataGrade !== 'C' && r.price > 0);

function pkPassive(rows) {
  const cand = shariahCandidates(rows).filter((r) => r.marketCapPkr > 0).sort((a, b) => b.marketCapPkr - a.marketCapPkr).slice(0, 30);
  const tot = cand.reduce((s, r) => s + r.marketCapPkr, 0);
  return tot > 0 ? Object.fromEntries(cand.map((r) => [r.symbol, r.marketCapPkr / tot])) : {};
}

function pkPicks(rows, n) {
  const cand = shariahCandidates(rows).filter((r) => r.score != null).sort((a, b) => b.score - a.score).slice(0, n);
  return Object.fromEntries(cand.map((r) => [r.symbol, 1 / cand.length]));
}

/** History for the production optimiser: monthly points up to month m. */
function fundHistory(key, m) {
  const out = [];
  for (const [mm, tr] of D.funds[key] || []) if (mm <= m) out.push({ date: `${mm}-28`, adjClose: tr });
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
function psxHistory(sym, m) {
  const out = [];
  for (const [mm, x] of D.psx[sym]?.byM || []) if (mm <= m) out.push({ date: `${mm}-28`, adjClose: x.adj });
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
function fxSeriesTo(m) {
  const out = {};
  for (const [mm, r] of D.usdpkr) if (mm <= m) out[`${mm}-28`] = r;
  return out;
}

function optimizerWeights(at, m, { gold = false } = {}) {
  const funds = ['ISWD', 'ISDU', 'ISDE', ...(gold ? ['GLD'] : [])].filter((k) => D.funds[k]?.get(m));
  const cands = shariahCandidates(at.rows).filter((r) => r.score != null).sort((a, b) => b.score - a.score).slice(0, CFG.picks);
  const mk = at.markets.psx;
  // The expected-returns payload shape the production view logic reads.
  const er = mk ? { markets: [{ key: 'psx', name: 'Pakistan (PSX)', expected: mk.expected, depreciationVsUsd: at.assumptions.pkrDepreciation?.rate ?? 0.08 }], funds: [] } : null;
  const assets = [
    ...funds.map((k) => ({ symbol: k, sleeve: 'globalCore', currency: 'USD', history: fundHistory(k, m), expected: null, ...(k === 'GLD' ? { max: 0.15 } : {}) })),
    ...cands.map((r) => {
      const v = assetView({ symbol: r.symbol, kind: 'stock', currency: 'PKR', region: 'pk', impliedReturn: r.impliedReturn, scoreCoverage: r.scores?.coverage }, er);
      return { symbol: r.symbol, sleeve: 'pakistan', currency: 'PKR', history: psxHistory(r.symbol, m), expected: v?.expected ?? null, confidence: v?.confidence };
    })
  ];
  const res = constructPortfolio({ assets, sleeves: DEFAULT_SLEEVES, fxSeries: fxSeriesTo(m), today: `${addMonths(m, 1)}-01`, months: 60, maxStockWeight: 0.1 });
  const w = res.portfolios.recommended.weights;
  const usd = {};
  const pkr = {};
  for (const a of res.assets) (a.sleeve === 'pakistan' ? pkr : usd)[a.symbol] = w[a.symbol] || 0;
  return { usd, pkr, notes: res.notes };
}

/** Target weights: { usd: {fund: w}, pkr: {symbol: w} }, all summing to 1. */
async function targets(strategy, m) {
  if (strategy === 'acwi') return { usd: { ACWI: 1 }, pkr: {} };
  if (strategy === 'iswd') return { usd: { ISWD: 1 }, pkr: {} };
  const at = await rowsAt(m);
  const scale = (o, k) => Object.fromEntries(Object.entries(o).map(([s, w]) => [s, w * k]));
  if (strategy === 'passive' || strategy === 'picks') {
    const pk = strategy === 'passive' ? pkPassive(at.rows) : pkPicks(at.rows, CFG.picks);
    // No eligible PSX names yet: the Pakistan share waits in the global core.
    if (!Object.keys(pk).length) return { usd: { ISWD: 1 }, pkr: {}, note: 'no eligible PSX names' };
    return { usd: { ISWD: 0.7 }, pkr: scale(pk, 0.3) };
  }
  if (strategy === 'optimizer' || strategy === 'optimizer-gold') {
    try {
      return optimizerWeights(at, m, { gold: strategy === 'optimizer-gold' });
    } catch (err) {
      const pk = pkPicks(at.rows, CFG.picks);
      return Object.keys(pk).length ? { usd: { ISWD: 0.7 }, pkr: scale(pk, 0.3), note: `optimizer: ${err.message}; fell back to picks` } : { usd: { ISWD: 1 }, pkr: {}, note: `optimizer: ${err.message}` };
    }
  }
  throw new Error(`unknown strategy ${strategy}`);
}

/* ------------------------------------------------------------ accounting */

const fundPx = (k, m) => D.funds[k]?.get(m) ?? null;
const psxRow = (s, m) => D.psx[s]?.byM.get(m) ?? null;

function value(st, m) {
  const fx = D.usdpkr.get(m);
  let usd = st.usdCash;
  for (const [k, u] of Object.entries(st.funds)) usd += u * (fundPx(k, m) ?? st.lastFundPx[k] ?? 0);
  let pkr = st.pkrCash;
  for (const [s, h] of Object.entries(st.stocks)) pkr += h.units * (psxRow(s, m)?.adj ?? h.lastAdj);
  return { usd, pkr, total: usd + pkr / fx, fx };
}

async function simulate(strategy) {
  const months = monthList(CFG.from, CFG.to);
  const st = { usdCash: 0, pkrCash: 0, funds: {}, stocks: {}, lastFundPx: {}, costs: 0, taxes: 0, delisted: [] };
  const path = [];
  let tgt = null;
  let contributed = 0;
  let prevNav = null;
  const notes = new Set();

  for (const [i, m] of months.entries()) {
    const fx = D.usdpkr.get(m);
    // 1. Mark: delistings, dividend tax.
    for (const [s, h] of Object.entries(st.stocks)) {
      const row = psxRow(s, m);
      if (!row) {
        if ((D.psx[s]?.last || '') < m) {
          // Stopped trading: out at the last traded price.
          const proceeds = h.units * h.lastAdj;
          const tax = Math.max(0, proceeds - h.cost) * CFG.tax.psxCgt;
          st.pkrCash += proceeds - tax;
          st.taxes += tax / fx;
          st.delisted.push({ symbol: s, month: m });
          delete st.stocks[s];
        }
        continue;
      }
      h.lastAdj = row.adj;
      if (row.dps > 0 && row.close > 0) {
        const shares = (h.units * row.adj) / row.close;
        const tax = shares * row.dps * CFG.tax.psxDividend;
        h.units -= tax / row.adj;
        st.taxes += tax / fx;
      }
    }
    for (const k of Object.keys(st.funds)) if (fundPx(k, m)) st.lastFundPx[k] = fundPx(k, m);
    const pre = value(st, m);
    const ret = prevNav ? pre.total / prevNav - 1 : null;

    // 2. Contribution.
    const add = CFG.monthly + (i === 0 ? CFG.initial : 0);
    st.usdCash += add;
    contributed += add;

    // 3. Targets.
    const rebalance = i % CFG.rebalance === 0;
    if (rebalance || !tgt) {
      tgt = await targets(strategy, m);
      if (tgt.note) notes.add(`${m}: ${tgt.note}`);
      for (const n of tgt.notes || []) notes.add(`${m}: ${n}`);
    }
    const pkrShare = Object.values(tgt.pkr).reduce((a, b) => a + b, 0);

    // 4. Trades. Cross-currency: new USD money tops up PKR if it's below target.
    let v = value(st, m);
    const pkrTargetUsd = pkrShare * v.total;
    const gapUsd = pkrTargetUsd - v.pkr / fx;
    if (gapUsd > 0 && st.usdCash > 0) {
      const convert = Math.min(st.usdCash, gapUsd);
      st.usdCash -= convert;
      st.pkrCash += convert * fx * (1 - CFG.costs.fx);
      st.costs += convert * CFG.costs.fx;
    }
    v = value(st, m);
    // USD side: trade funds to their target shares of the USD side.
    const usdW = tgt.usd;
    const usdSum = Object.values(usdW).reduce((a, b) => a + b, 0) || 1;
    const fundTarget = (k) => (usdW[k] / usdSum) * v.usd;
    for (const k of new Set([...Object.keys(st.funds), ...Object.keys(usdW)])) {
      const px = fundPx(k, m);
      if (!px) continue;
      const cur = (st.funds[k] || 0) * px;
      const want = usdW[k] ? fundTarget(k) : 0;
      // Between rebalances, only buy with cash; on rebalance, also sell.
      let delta = want - cur;
      if (!rebalance && delta < 0) continue;
      if (delta > 0) delta = Math.min(delta, st.usdCash / (1 + CFG.costs.fund));
      if (Math.abs(delta) < 1) continue;
      st.funds[k] = (st.funds[k] || 0) + delta / px;
      st.usdCash -= delta + Math.abs(delta) * CFG.costs.fund;
      st.costs += Math.abs(delta) * CFG.costs.fund;
      if (st.funds[k] < 1e-9) delete st.funds[k];
    }
    // PKR side: trade stocks to their target shares of the PKR side.
    v = value(st, m);
    const pkrSum = pkrShare || 1;
    const stockTarget = (s) => ((tgt.pkr[s] || 0) / pkrSum) * v.pkr;
    const sells = [];
    const buys = [];
    for (const s of new Set([...Object.keys(st.stocks), ...Object.keys(tgt.pkr)])) {
      const row = psxRow(s, m);
      if (!row) continue;
      const cur = (st.stocks[s]?.units || 0) * row.adj;
      const delta = stockTarget(s) - cur;
      if (delta < 0 && rebalance) sells.push([s, delta, row]);
      if (delta > 0) buys.push([s, delta, row]);
    }
    for (const [s, delta, row] of sells) {
      const h = st.stocks[s];
      const amount = -delta;
      const frac = Math.min(1, amount / (h.units * row.adj));
      const costBasis = h.cost * frac;
      const tax = Math.max(0, amount - costBasis) * CFG.tax.psxCgt;
      const fee = amount * CFG.costs.psx;
      h.units *= 1 - frac;
      h.cost -= costBasis;
      st.pkrCash += amount - tax - fee;
      st.taxes += tax / fx;
      st.costs += fee / fx;
      if (h.units * row.adj < 1) delete st.stocks[s];
    }
    const want = buys.reduce((a, b) => a + b[1], 0);
    const scaleBuys = want > 0 ? Math.min(1, st.pkrCash / (want * (1 + CFG.costs.psx))) : 0;
    for (const [s, delta, row] of buys) {
      const amount = delta * scaleBuys;
      if (amount < 1) continue;
      const fee = amount * CFG.costs.psx;
      st.stocks[s] ||= { units: 0, cost: 0, lastAdj: row.adj };
      st.stocks[s].units += amount / row.adj;
      st.stocks[s].cost += amount;
      st.pkrCash -= amount + fee;
      st.costs += fee / fx;
    }

    const post = value(st, m);
    prevNav = post.total;
    path.push({ m, nav: post.total, contributed, ret, pkrShare: post.pkr / fx / post.total, holdings: Object.keys(st.stocks).length });
  }
  return { strategy, path, costs: st.costs, taxes: st.taxes, delisted: st.delisted, notes: [...notes].slice(0, 40) };
}

/* --------------------------------------------------------------- metrics */

function irr(flows) {
  // Monthly flows (negative = contribution), last = final value; annualised.
  const npv = (r) => flows.reduce((s, f, i) => s + f / (1 + r) ** i, 0);
  let lo = -0.99;
  let hi = 1;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (npv(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (1 + (lo + hi) / 2) ** 12 - 1;
}

function metrics(sim) {
  const p = sim.path;
  const rets = p.map((x) => x.ret).filter((x) => x != null);
  const idx = [1];
  for (const r of rets) idx.push(idx[idx.length - 1] * (1 + r));
  let peak = 1;
  let mdd = 0;
  for (const v of idx) {
    peak = Math.max(peak, v);
    mdd = Math.min(mdd, v / peak - 1);
  }
  const years = rets.length / 12;
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / (rets.length - 1));
  let worst12 = 0;
  for (let i = 12; i < idx.length; i++) worst12 = Math.min(worst12, idx[i] / idx[i - 12] - 1);
  const flows = p.map((x, i) => -(x.contributed - (i ? p[i - 1].contributed : 0)));
  flows[flows.length - 1] += p[p.length - 1].nav;
  return {
    strategy: sim.strategy,
    finalValue: Math.round(p[p.length - 1].nav),
    contributed: Math.round(p[p.length - 1].contributed),
    moneyWeightedReturn: irr(flows),
    timeWeightedCagr: idx[idx.length - 1] ** (1 / years) - 1,
    volatility: sd * Math.sqrt(12),
    returnToVol: (idx[idx.length - 1] ** (1 / years) - 1) / (sd * Math.sqrt(12)),
    maxDrawdown: mdd,
    worst12Months: worst12,
    avgPkrShare: p.reduce((a, x) => a + x.pkrShare, 0) / p.length,
    costsUsd: Math.round(sim.costs),
    taxesUsd: Math.round(sim.taxes),
    delistedHoldings: sim.delisted.length
  };
}

/* ------------------------------------------------------------------ main */

await loadData();
console.error(`Backtest ${CFG.from}..${CFG.to}${CFG.to >= HOLDOUT_FROM ? ' (INCLUDES HOLD-OUT)' : ''}, $${CFG.monthly}/month, archive periods ${D.archivePeriods}`);
const results = [];
for (const s of CFG.strategies) {
  const sim = await simulate(s);
  const mt = metrics(sim);
  results.push({ ...mt, notes: sim.notes, path: sim.path });
  console.error(`${s.padEnd(15)} final $${mt.finalValue.toLocaleString()} of $${mt.contributed.toLocaleString()} | MWR ${(mt.moneyWeightedReturn * 100).toFixed(1)}% | TWR ${(mt.timeWeightedCagr * 100).toFixed(1)}% | vol ${(mt.volatility * 100).toFixed(1)}% | maxDD ${(mt.maxDrawdown * 100).toFixed(1)}% | PKR ${(mt.avgPkrShare * 100).toFixed(0)}%`);
}
const out = { config: CFG, archivePeriods: D.archivePeriods, dataNotes: D.notes, generatedAt: new Date().toISOString(), results };
if (args.out) writeFileSync(args.out, JSON.stringify(out, null, 1));
else console.log(JSON.stringify(out.results.map(({ path, ...r }) => r), null, 1));
