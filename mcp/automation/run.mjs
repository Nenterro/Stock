#!/usr/bin/env node
/**
 * Scheduled automation: the plain-code tasks, no Claude needed. Runs from
 * cron on the home server (or by hand on the dev PC) and writes its results
 * into the app (Insights, research records), so decisions are prepared
 * before they are needed.
 *
 *   node mcp/automation/run.mjs models        weekly: optimiser variants, saved
 *                                             as a snapshot, and the next batch's
 *                                             contribution plan
 *   node mcp/automation/run.mjs alerts        nightly: holdings checks (thesis
 *                                             triggers, Shariah ratios, earnings
 *                                             flags, big moves, risk register);
 *                                             an alert only when something new
 *   node mcp/automation/run.mjs bookkeeping   monthly: last month's returns for
 *                                             the forward-test portfolios, and
 *                                             ledger entries scored when due
 *
 * Options: --dry (compute and print, write nothing)
 *          --pi <dir> (the Personal Investment records; default
 *          $PERSONAL_INVESTMENT_DIR, else ~/personal-investment)
 *
 * The Personal Investment folder is a private git repository (home server
 * bare repo); this script pulls it before reading and commits and pushes what
 * it writes there.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { api } from '../lib/api.js';
import * as pf from '../lib/portfolio.js';
import * as store from '../lib/store.js';
import { buildInputs, runModels } from '../../src/utils/models/pipeline.js';
import { POLICY_SLEEVES } from '../../src/utils/models/construct.js';
import { planContribution } from '../../src/utils/portfolio_analytics.js';

const args = process.argv.slice(2);
const task = args[0];
const DRY = args.includes('--dry');
const piIdx = args.indexOf('--pi');
const PI = piIdx >= 0 ? args[piIdx + 1] : process.env.PERSONAL_INVESTMENT_DIR || join(homedir(), 'personal-investment');
const TODAY = new Date().toISOString().slice(0, 10);
const log = (...a) => console.log(`[automation:${task}]`, ...a);

/* ------------------------------------------------------------------ helpers */

const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '-' : `${(x * 100).toFixed(d)}%`);
const usd = (x) => (x == null ? '-' : `$${Math.round(x).toLocaleString('en-US')}`);

async function saveInsight({ id, kind, title, summary, body, symbols = [], verdict = null, confidence = null }) {
  const item = {
    kind,
    title,
    body,
    symbols: symbols.map((s) => s.toUpperCase()),
    author: 'Claude (automation)',
    meta: { summary, verdict, confidence, dataAsOf: TODAY, savedAt: new Date().toISOString(), automated: task }
  };
  if (DRY) {
    log(`would save insight "${title}"\n${body}`);
    return { id: id || 'dry' };
  }
  const I = store.COLLECTIONS.insights;
  if (id) {
    try {
      return await store.update(I, id, item);
    } catch {
      // Deleted in the app: start a new one.
    }
  }
  return store.create(I, item);
}

async function research(kind, symbol) {
  const rows = await pf.research();
  return rows.find((r) => r.kind === kind && String(r.symbol || '').toUpperCase() === String(symbol).toUpperCase()) || null;
}

async function upsertResearch(kind, symbol, data, { replace = false } = {}) {
  if (DRY) return log(`would save research ${kind}/${symbol}`);
  const existing = await research(kind, symbol);
  const item = { kind, symbol: String(symbol).toUpperCase(), data: { ...(replace ? {} : existing?.data || {}), ...data, updatedAt: new Date().toISOString() } };
  const R = store.COLLECTIONS.research;
  const saved = existing ? await store.update(R, existing.id, item) : await store.create(R, item);
  pf.invalidate('research');
  return saved;
}

/** Automation bookkeeping (insight ids to revise, alert state). */
async function state() {
  return (await research('automation_state', '*'))?.data || {};
}

function git(...a) {
  return execFileSync('git', ['-C', PI, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function piPull() {
  if (!existsSync(join(PI, '.git'))) return false;
  try {
    git('pull', '-q', '--rebase');
  } catch (e) {
    log(`git pull failed (working on the local copy): ${e.message.split('\n')[0]}`);
  }
  return true;
}

function piCommit(message) {
  if (DRY || !existsSync(join(PI, '.git'))) return;
  try {
    git('add', '-A');
    if (!git('status', '--porcelain')) return;
    git('commit', '-q', '-m', `${message}\n\nAutomated (mcp/automation/run.mjs ${task}).`);
    git('pull', '-q', '--rebase');
    git('push', '-q');
  } catch (e) {
    log(`git commit/push failed: ${e.message.split('\n')[0]}`);
  }
}

/** Theses with their front matter (symbol, status, review, triggers). */
function readTheses() {
  const dir = join(PI, 'theses');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md') && !x.startsWith('_'))) {
    const text = readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n');
    const m = text.match(/^---\n([\s\S]*?)\n---\n/);
    const fm = { triggers: {} };
    if (m) {
      let inTriggers = false;
      for (const line of m[1].split('\n')) {
        const clean = line.replace(/\s+#.*$/, '');
        const t = clean.match(/^ {2}(\w+):\s*(.+)$/);
        const k = clean.match(/^(\w+):\s*(.*)$/);
        if (t && inTriggers) fm.triggers[t[1]] = Number(t[2]);
        else if (k) {
          inTriggers = k[1] === 'triggers';
          if (!inTriggers) fm[k[1]] = k[2].trim();
        }
      }
    }
    out.push({ file: f, symbol: (fm.symbol || f.replace(/\.md$/, '')).toUpperCase(), ...fm });
  }
  return out;
}

/* ------------------------------------------------------------ candidates */

// Business activities excluded before the optimiser sees a stock (MSCI
// Islamic-style). The thesis check is still Claude's: this only keeps
// obvious non-starters out of the automated runs.
const EXCLUDED_INDUSTRY = /tobacco|winer|distill|brewer|gambling|casino|lodging|aerospace & defense|entertainment|banks|insurance|asset management|capital markets|credit services|mortgage|financial conglomerates|shell companies/i;
const CORE_FUNDS = ['ISWD', 'ISDE', 'ISDU', 'IGDA', 'UMMA', 'SPUS', 'HLAL', 'MZNPETF'];

async function candidates(holdings, rows) {
  const held = holdings.map((h) => h.ticker);
  const targets = Object.keys(rows.find((r) => r.kind === 'targets')?.data?.targets || {});
  const watch = rows.filter((r) => r.kind === 'watch').map((r) => r.symbol);
  const theses = readTheses().filter((t) => !['rejected', 'exited'].includes(t.status)).map((t) => t.symbol);
  const g = await api.screener({ scope: 'global', kind: 'stock', dataGrade: 'A', max_debtToMarketCap: '0.33', max_cashToMarketCap: '0.33', max_interestIncomeToRevenue: '0.05', sort: '-score', limit: 600 });
  const perSector = new Map();
  for (const r of g?.rows || []) {
    if (r.sector === 'Financial Services' || EXCLUDED_INDUSTRY.test(r.industry || '')) continue;
    const list = perSector.get(r.sector) || [];
    if (list.length < 7) perSector.set(r.sector, [...list, r.symbol]);
  }
  const p = await api.screener({ scope: 'psx', shariah: 'true', dataGrade: 'A', min_avgValueTraded20d: '10000000', sort: '-score', limit: 25 });
  const psx = (p?.rows || []).filter((r) => r.kind === 'stock').map((r) => r.symbol);
  return [...new Set([...held, ...targets, ...watch, ...theses, ...CORE_FUNDS, ...[...perSector.values()].flat(), ...psx].map((s) => String(s).toUpperCase()))];
}

/* ------------------------------------------------------------------ models */

const SETTINGS_DEFAULTS = { batchUsd: 2500, investNow: 30000, minPositionUsd: 500, maxStockWeight: 0.06 };

async function models() {
  piPull();
  const rows = await pf.research();
  const settings = rows.find((r) => r.kind === 'settings')?.data || {};
  const pos = await pf.positions({ currency: 'USD' });
  const symbols = await candidates(pos.holdings, rows);
  log(`${symbols.length} candidates`);
  const inputs = await buildInputs({
    holdings: pos.holdings,
    extraSymbols: symbols,
    fetchers: { histories: (s, range = '10y') => api.historyBatch(s, range), expectedReturns: () => api.expectedReturns(), screenerRow: (s) => api.screenerRow(s) }
  });
  const fxSeries = await api.fxSeries();
  const cfg = { ...SETTINGS_DEFAULTS, ...(settings.automation || {}) };
  const base = {
    ...inputs,
    holdings: pos.holdings,
    fxSeries,
    rf: settings.riskFreeRate?.USD ?? 0.04,
    monthly: settings.monthlyContribution?.currency === 'USD' ? settings.monthlyContribution.amount : 2800,
    contributionGrowth: 0.05,
    years: 10,
    investNow: cfg.investNow,
    minPositionUsd: cfg.minPositionUsd,
    maxStockWeight: cfg.maxStockWeight,
    riskAversion: settings.riskAversion,
    paths: 2000
  };
  const variants = [
    ['Unconstrained', {}],
    ['Old policy bounds', { sleeves: POLICY_SLEEVES }],
    ['Risk implied by the policy mix', { riskAversion: null }]
  ];
  const results = [];
  for (const [name, over] of variants) {
    const t0 = Date.now();
    const r = runModels({ ...base, ...over });
    const rec = r.portfolios.recommended;
    const y = r.projections.recommended.byYear.at(-1);
    results.push({
      name,
      riskAversion: r.riskAversion,
      expectedReturn: rec.expectedReturn,
      volatility: rec.volatility,
      sharpe: rec.sharpe,
      sleeves: rec.sleeves,
      weights: Object.fromEntries(Object.entries(rec.weights).filter(([, w]) => w > 0.004).sort((a, b) => b[1] - a[1])),
      year10: { median: y.median, p5: y.p5, p95: y.p95, invested: y.invested, probBelowInvested: y.probBelowInvested },
      maxDrawdown: r.projections.recommended.maxDrawdown,
      seconds: (Date.now() - t0) / 1000
    });
    log(`${name}: ${pct(rec.expectedReturn)} / ${pct(rec.volatility)} in ${results.at(-1).seconds}s`);
  }
  const views = Object.fromEntries(inputs.assets.map((a) => [a.symbol, { view: a.expected, tilt: a.tilt, tax: a.taxDrag }]));

  // Changes in the unconstrained run since the last snapshot.
  const prevRec = rows.filter((r) => r.kind === 'model_snapshot').sort((a, b) => (a.symbol < b.symbol ? 1 : -1))[0];
  const prev = prevRec?.data?.variants?.[0]?.weights || null;
  const now = results[0].weights;
  const changes = prev
    ? [...new Set([...Object.keys(prev), ...Object.keys(now)])]
        .map((s) => ({ s, d: (now[s] || 0) - (prev[s] || 0) }))
        .filter((x) => Math.abs(x.d) >= 0.015)
        .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
    : null;

  await upsertResearch('model_snapshot', TODAY, { variants: results, candidates: symbols.length, excluded: inputs.excluded, settings: cfg, riskAversion: settings.riskAversion ?? null }, { replace: true });

  const table = (w) =>
    Object.entries(w)
      .slice(0, 25)
      .map(([s, x]) => `${s} ${pct(x)}`)
      .join(', ');
  const body = [
    `Weekly optimiser runs on ${symbols.length} candidates (holdings, targets, watchlist, open theses, core funds, the top Shariah-screened global stocks per sector, the top liquid PSX Shariah stocks). Sized for +${usd(cfg.investNow)}, minimum position ${usd(cfg.minPositionUsd)}, stock cap ${pct(cfg.maxStockWeight, 0)}. The output is an input to judgement, not a decision.`,
    '',
    '| Run | Risk aversion | Expected | Volatility | Funds | Stocks | Pakistan | 10y median (p5) | Worst-10% drawdown |',
    '|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.name} | ${r.riskAversion.toFixed(1)} | ${pct(r.expectedReturn)} | ${pct(r.volatility)} | ${pct(r.sleeves.globalCore, 0)} | ${pct(r.sleeves.globalStocks, 0)} | ${pct(r.sleeves.pakistan, 0)} | ${usd(r.year10.median)} (${usd(r.year10.p5)}) | ${pct(r.maxDrawdown.p10, 0)} |`),
    '',
    ...results.map((r) => `**${r.name}:** ${table(r.weights)}`),
    '',
    changes == null ? '_First snapshot: no changes to compare._' : changes.length ? `**Changes since ${prevRec.symbol} (unconstrained run, 1.5+ points):** ${changes.map((c) => `${c.s} ${c.d > 0 ? '+' : ''}${(c.d * 100).toFixed(1)}`).join(', ')}` : `_No change of 1.5 points or more since ${prevRec.symbol}._`,
    '',
    inputs.excluded?.length ? `Left out: ${inputs.excluded.map((x) => `${x.symbol} (${x.reason})`).join('; ')}.` : ''
  ].join('\n');
  const st = await state();
  const saved = await saveInsight({
    id: st.modelInsightId,
    kind: 'rebalance-plan',
    title: `Model runs, week of ${TODAY}`,
    summary: `Unconstrained: ${pct(results[0].expectedReturn)} expected, ${pct(results[0].volatility)} volatility; funds ${pct(results[0].sleeves.globalCore, 0)}, stocks ${pct(results[0].sleeves.globalStocks, 0)}, Pakistan ${pct(results[0].sleeves.pakistan, 0)}.`,
    body
  });

  // The next batch, against the saved planner targets (the System's).
  const targets = rows.find((r) => r.kind === 'targets')?.data;
  let planId = st.planInsightId;
  if (targets?.targets) {
    const t = targets.targets;
    const missing = [...new Set([...Object.keys(t), 'ISWD'].map((s) => s.toUpperCase()))].filter((s) => !pos.holdings.some((h) => h.ticker === s));
    const prices = {};
    const nativeCcy = Object.fromEntries(pos.holdings.map((h) => [h.ticker, String(h.nativeCurrency || 'USD').toUpperCase()]));
    if (missing.length) {
      const q = await api.quotes(missing);
      for (const s of missing) {
        const quote = q[s];
        if (!quote?.price) continue;
        const native = String(quote.currency || 'USD').toUpperCase();
        nativeCcy[s] = native;
        prices[s] = native === 'USD' ? quote.price : native === 'PKR' ? quote.price / pos.fxRate : quote.price * pos.fxRate;
      }
    }
    const lots = Object.fromEntries(Object.keys(t).filter((s) => /\.(T|SI)$/i.test(s)).map((s) => [s.toUpperCase(), 100]));
    const plan = planContribution(pos.holdings, t, cfg.batchUsd, { prices, wholeShares: true, minTrade: 150, lots, standIn: 'ISWD' });
    const pkrBuys = (plan.buys || []).filter((b) => nativeCcy[b.ticker] === 'PKR');
    const planBody = [
      `Pre-computed for the next ${usd(cfg.batchUsd)} batch against the saved targets (${targets.setBy || 'unknown'}, ${String(targets.updatedAt || '').slice(0, 10)}), prices of ${TODAY}. Recomputed weekly; check prices before placing orders.`,
      '',
      '| Buy | Amount | Shares | Price |',
      '|---|---|---|---|',
      ...(plan.buys || []).map((b) => `| ${b.ticker} | ${usd(b.amount)} | ${b.shares ?? '-'} | ${b.price != null ? `$${b.price.toFixed(2)}` : '-'} |`),
      '',
      `Left over: ${usd(plan.leftover)}.`,
      plan.waiting?.length ? `Waiting for a whole lot: ${plan.waiting.map((w) => `${w.ticker} (ready at a ${usd(w.readyAtPortfolio)} portfolio)`).join(', ')}.` : '',
      pkrBuys.length ? `PSX buys need a USD→PKR transfer (batched every 2-3 months by policy): ${pkrBuys.map((b) => b.ticker).join(', ')}.` : '',
      plan.warnings?.length ? `Notes: ${plan.warnings.join(' ')}` : ''
    ].join('\n');
    const p = await saveInsight({
      id: st.planInsightId,
      kind: 'contribution-plan',
      title: `Ready: next ${usd(cfg.batchUsd)} batch`,
      summary: (plan.buys || []).map((b) => `${b.ticker} ${usd(b.amount)}`).join(', ') || 'Nothing to buy against the current targets.',
      body: planBody,
      symbols: (plan.buys || []).map((b) => b.ticker)
    });
    planId = p.id;
  }
  await upsertResearch('automation_state', '*', { modelInsightId: saved.id, planInsightId: planId, lastModels: TODAY });
}

/* ------------------------------------------------------------------ alerts */

async function alerts() {
  piPull();
  const pos = await pf.positions({ currency: 'USD' });
  const total = pos.totals?.marketValue || pos.holdings.reduce((s, h) => s + (h.marketValue || 0), 0);
  const theses = Object.fromEntries(readTheses().map((t) => [t.symbol, t]));
  const risks = (await api.newsRisks({}).catch(() => null))?.risks || [];
  const recent = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const found = [];
  const add = (key, symbol, text, level = 'watch') => found.push({ key, symbol, text, level });

  for (const h of pos.holdings) {
    const s = h.ticker;
    const row = await api.screenerRow(s).catch(() => null);
    const th = theses[s];
    const tr = th?.triggers || {};
    const price = h.priceNative ?? h.price;
    const weight = total > 0 ? h.marketValue / total : null;
    if (tr.addBelow > 0 && price <= tr.addBelow) add(`add:${s}`, s, `${s} at ${price} is at or below its thesis add level (${tr.addBelow}).`, 'opportunity');
    if (tr.trimAbovePrice > 0 && price >= tr.trimAbovePrice) add(`trimPrice:${s}`, s, `${s} at ${price} is at or above its thesis trim price (${tr.trimAbovePrice}).`, 'action');
    if (tr.trimAboveWeight > 0 && weight >= tr.trimAboveWeight) add(`trimWeight:${s}`, s, `${s} is ${pct(weight)} of the portfolio, above its thesis trim weight (${pct(tr.trimAboveWeight, 0)}).`, 'action');
    if (th?.review && th.review <= TODAY) add(`review:${s}:${th.review}`, s, `${s}: thesis review date ${th.review} has passed.`, 'action');
    if (row) {
      const d = row.debtToMarketCap;
      const c = row.cashToMarketCap;
      const ii = row.interestIncomeToRevenue;
      if (row.region === 'pk') {
        if (row.isShariah === false) add(`shariah:${s}`, s, `${s} is no longer flagged Shariah-compliant on PSX.`, 'action');
      } else {
        if (d > 0.33) add(`shariahDebt:${s}`, s, `${s}: debt is ${pct(d)} of market value, above the one-third Shariah limit.`, 'action');
        if (c > 0.33) add(`shariahCash:${s}`, s, `${s}: cash is ${pct(c)} of market value, above the one-third Shariah limit.`, 'action');
        if (ii > 0.05) add(`shariahInterest:${s}`, s, `${s}: interest income is ${pct(ii)} of revenue, above the 5% Shariah limit.`, 'action');
      }
      // Net debt / EBITDA from the screener's ratios: EV = cap x (1 + d - c).
      if (tr.netDebtToEbitdaMax > 0 && d != null && c != null && row.evToEbitda > 0) {
        const nd = ((d - c) * row.evToEbitda) / (1 + d - c);
        if (nd > tr.netDebtToEbitdaMax) add(`netDebt:${s}`, s, `${s}: net debt is ${nd.toFixed(1)}x EBITDA, above its thesis limit (${tr.netDebtToEbitdaMax}x).`, 'action');
      }
      if (row.earningsCheck) add(`earnings:${s}:${row.earningsCheck.asOf}`, s, `${s}: its P/E was adjusted by the earnings check (${row.earningsCheck.changes.map((x) => x.rule).join(', ')}; reported ${row.earningsCheck.peReported?.toFixed(1)}, used ${row.peTTM?.toFixed(1)}). Read the latest results.`);
      if (row.earningsFlags) add(`earningsFlag:${s}`, s, `${s}: earnings figures disagree and could not be reconciled (${row.earningsFlags.map((x) => x.rule).join(', ')}).`);
      if (row.priceAsOf && (Date.now() - Date.parse(`${row.priceAsOf}T00:00:00Z`)) / 86400000 > 6) add(`stale:${s}`, s, `${s}: price last updated ${row.priceAsOf}.`);
    }
    const move = h.dayChangePct;
    if (move != null && Math.abs(move) >= 0.08) add(`move:${s}:${TODAY}`, s, `${s} moved ${pct(move)} on the day.`);
  }
  // New or escalated severity 4-5 risks touching a holding or its market.
  const heldSet = new Set(pos.holdings.map((h) => h.ticker));
  const markets = new Set(pos.holdings.map((h) => (h.nativeCurrency === 'PKR' ? 'PK' : 'GLOBAL')));
  for (const r of risks) {
    if (r.status !== 'active' || r.severity < 4 || (r.updated || '') < recent) continue;
    const touches = (r.symbols || []).some((x) => heldSet.has(x)) || (r.markets || []).some((m) => markets.has(m) || m === 'US');
    if (touches) add(`risk:${r.id}:${r.severity}:${r.direction}`, null, `Risk register: "${r.title}" is severity ${r.severity}, ${r.direction}. ${r.summary}`);
  }

  const st = await state();
  const seen = st.alerts || {};
  const fresh = found.filter((f) => !seen[f.key]);
  const nextSeen = Object.fromEntries(found.map((f) => [f.key, seen[f.key] || TODAY]));
  log(`${found.length} active, ${fresh.length} new`);
  if (fresh.length) {
    const order = { action: 0, opportunity: 1, watch: 2 };
    const lines = [...found].sort((a, b) => order[a.level] - order[b.level]).map((f) => `- ${fresh.includes(f) ? '**New:** ' : ''}[${f.level}] ${f.text}${!fresh.includes(f) ? ` _(since ${seen[f.key]})_` : ''}`);
    await saveInsight({
      kind: 'note',
      title: `Alert: ${fresh.length} new on ${TODAY}`,
      summary: fresh.map((f) => f.text).join(' ').slice(0, 390),
      body: [`Nightly holdings check, ${TODAY}. Thesis triggers come from the front matter of each thesis; Shariah limits are the AAOIFI-style ratios in the policy.`, '', ...lines].join('\n'),
      symbols: [...new Set(fresh.map((f) => f.symbol).filter(Boolean))]
    });
  }
  await upsertResearch('automation_state', '*', { alerts: nextSeen, lastAlerts: TODAY });
}

/* -------------------------------------------------------------- bookkeeping */

/** Month-end USD adjusted closes: { SYMBOL: Map('YYYY-MM' -> usd) }. */
async function monthEnds(symbols, fxSeries) {
  const hist = await api.historyBatch(symbols, '2y');
  const fxDates = Object.keys(fxSeries || {}).sort();
  const fxAt = (d) => {
    let best = fxSeries[fxDates[0]];
    for (const x of fxDates) {
      if (x <= d) best = fxSeries[x];
      else break;
    }
    return best;
  };
  const out = {};
  for (const [s, h] of Object.entries(hist)) {
    const m = new Map();
    for (const p of h.history || []) {
      const d = String(p.date).slice(0, 10);
      const px = p.adjClose > 0 ? p.adjClose : p.price;
      if (!(px > 0)) continue;
      m.set(d.slice(0, 7), String(h.currency).toUpperCase() === 'PKR' ? px / fxAt(d) : px);
    }
    out[s] = m;
  }
  return out;
}

const prevMonthOf = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
};

/** Return of a weight set over one month; unpriced names are left out and the rest renormalised. */
function weightedReturn(weights, prices, month) {
  let num = 0;
  let den = 0;
  for (const [s, w] of Object.entries(weights)) {
    if (s === 'CASH') {
      den += w;
      continue;
    }
    const a = prices[s]?.get(prevMonthOf(month));
    const b = prices[s]?.get(month);
    if (!(a > 0 && b > 0)) continue;
    num += w * (b / a - 1);
    den += w;
  }
  return den > 0.5 ? num / den : null;
}

const BENCHMARKS = {
  'Funds-only': { ISWD: 0.7, MZNPETF: 0.3 },
  'Market (ACWI)': { ACWI: 1 },
  // Approximate: the October 2026 holdings before the restructure.
  Previous: { SPTE: 0.138, UMMA: 0.138, SPUS: 0.138, ISDU: 0.138, ISDE: 0.125, FFC: 0.108, MEBL: 0.108, OGDC: 0.107 }
};

async function bookkeeping() {
  piPull();
  const month = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const rows = await pf.research();
  const ft = rows.find((r) => r.kind === 'forward_test' && r.symbol === '*')?.data || {};
  const recorded = ft.portfolios || {};
  // Weights in force at the start of the month: the latest recorded before it ends.
  const asOf = (list) => (list || []).filter((x) => x.from <= `${month}-31`).sort((a, b) => (a.from < b.from ? 1 : -1))[0]?.weights || null;
  const snapshots = rows.filter((r) => r.kind === 'model_snapshot' && r.symbol <= `${month}-31`).sort((a, b) => (a.symbol < b.symbol ? 1 : -1));
  const sets = {
    System: asOf(recorded.System),
    Optimiser: snapshots[0]?.data?.variants?.[0]?.weights || asOf(recorded.Optimiser),
    ...BENCHMARKS
  };
  const symbols = [...new Set(Object.values(sets).filter(Boolean).flatMap((w) => Object.keys(w)).filter((s) => s !== 'CASH'))];
  const fxSeries = await api.fxSeries();
  const prices = await monthEnds(symbols, fxSeries);
  const result = { month };
  for (const [name, w] of Object.entries(sets)) result[name] = w ? weightedReturn(w, prices, month) : null;
  // Actual: the app's own time-weighted return.
  const perf = await pf.performance({ currency: 'USD', interval: 'monthly' });
  const pts = perf.points || [];
  const end = pts.find((p) => p.date.slice(0, 7) === month);
  const start = pts.filter((p) => p.date.slice(0, 7) < month).at(-1);
  result.Actual = end && start ? (1 + end.twr) / (1 + start.twr) - 1 : null;
  log(JSON.stringify(result));

  // Ledger entries due: "Claude right if A < B" (or >), each side a list of tickers.
  const ftPath = join(PI, 'forward-test.md');
  let md = existsSync(ftPath) ? readFileSync(ftPath, 'utf8').replace(/\r\n/g, '\n') : null;
  const scored = [];
  if (md) {
    const lines = md.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const cells = lines[i].split('|').map((c) => c.trim());
      // | # | Date | Model said | Claude did | Why | Claude right if | Review | Result |
      if (cells.length < 10 || !/^\d+$/.test(cells[1]) || cells[8] || !/^\d{4}-\d{2}-\d{2}$/.test(cells[7]) || cells[7] > TODAY) continue;
      const m = cells[6].match(/^(.+?)\s*([<>])\s*(.+)$/);
      if (!m) continue;
      const left = m[1].split(/[,\s]+/).filter(Boolean);
      const right = m[3].split(/[,\s]+/).filter(Boolean);
      const hist = await api.historyBatch([...left, ...right], '2y');
      const ret = (list) => {
        const rs = list.map((s) => {
          const h = (hist[s.toUpperCase()]?.history || []).map((p) => ({ d: String(p.date).slice(0, 10), px: p.adjClose > 0 ? p.adjClose : p.price }));
          const a = h.filter((p) => p.d <= cells[2]).at(-1);
          const b = h.filter((p) => p.d <= cells[7]).at(-1);
          return a && b ? b.px / a.px - 1 : null;
        }).filter((x) => x != null);
        return rs.length ? rs.reduce((x, y) => x + y, 0) / rs.length : null;
      };
      const l = ret(left);
      const r = ret(right);
      if (l == null || r == null) continue;
      const right_ = m[2] === '<' ? l < r : l > r;
      cells[8] = `${right_ ? 'Claude right' : 'Claude wrong'}: ${m[1]} ${pct(l)} vs ${m[3]} ${pct(r)} (total return, ${cells[2]} to ${cells[7]})`;
      lines[i] = `| ${cells.slice(1, 9).join(' | ')} |`;
      scored.push(cells[8]);
    }
    // Monthly log row.
    const row = `| ${month} | ${pct(result.Actual)} | ${pct(result.System)} | ${pct(result.Optimiser)} | ${pct(result['Funds-only'])} | ${pct(result['Market (ACWI)'])} | ${pct(result.Previous)} | automated |`;
    const idx = lines.findIndex((l) => l.startsWith(`| ${month} |`));
    if (idx >= 0 && /^\|\s*[\d-]+\s*\|\s*\|/.test(lines[idx])) lines[idx] = row;
    else if (idx < 0) lines.push(row);
    md = lines.join('\n');
    if (!DRY) writeFileSync(ftPath, md);
  }
  await upsertResearch('forward_test', '*', { months: { ...(ft.months || {}), [month]: result } });
  await saveInsight({
    kind: 'portfolio-review',
    title: `Forward test: ${month}`,
    summary: `Actual ${pct(result.Actual)}, System ${pct(result.System)}, Optimiser ${pct(result.Optimiser)}, Funds-only ${pct(result['Funds-only'])}, ACWI ${pct(result['Market (ACWI)'])}.`,
    body: [
      `Returns for ${month} in USD. Weight-based portfolios are rebalanced monthly to their recorded weights; Actual is the app's time-weighted return. One month is noise: judge after four quarters.`,
      '',
      '| Portfolio | Return |',
      '|---|---|',
      ...['Actual', 'System', 'Optimiser', 'Funds-only', 'Market (ACWI)', 'Previous'].map((k) => `| ${k} | ${pct(result[k])} |`),
      '',
      scored.length ? `**Ledger entries scored:**\n${scored.map((s) => `- ${s}`).join('\n')}` : '_No ledger entries due._'
    ].join('\n')
  });
  piCommit(`Forward test: ${month}${scored.length ? `, ${scored.length} ledger entries scored` : ''}`);
}

/* ---------------------------------------------------------------------- main */

const tasks = { models, alerts, bookkeeping };
if (!tasks[task]) {
  console.error(`Usage: node mcp/automation/run.mjs <${Object.keys(tasks).join('|')}> [--dry] [--pi <dir>]`);
  process.exit(2);
}
try {
  await tasks[task]();
  process.exit(0);
} catch (e) {
  console.error(`[automation:${task}] failed: ${e.stack || e.message}`);
  process.exit(1);
}
