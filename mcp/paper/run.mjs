/**
 * Nightly paper-trading run (forward test of strategies). Called by
 * mcp/automation/run.mjs `paper` (cron on the home server, after every
 * market's close). Plain code, no Claude.
 *
 * Records live in the private Personal Investment repository, under
 * strategies/:
 *   rules.json, README.md   each strategy's frozen rules, version, start date
 *   universe/<YYYY-MM>.json the month's fixed universe (no survivorship bias)
 *   state/<id>.json         positions, cash, pending orders, NAV, costs
 *   trades/<id>.csv         every fill
 *   random.json             the luck test: random 20-stock portfolios a month
 *   scoreboard.md           the comparison
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { STRATEGIES, EXTRA_SYMBOLS } from './strategies.mjs';
import { newPortfolio, markToMarket, fillPending, recordNav, deposit, metrics, monthEnds, value, barAt, START_USD } from './engine.mjs';
import { closes } from './indicators.mjs';

const GLOBAL_UNIVERSE = 250;
const PSX_UNIVERSE = 60;
// Typical daily value traded, USD, where the screener has none (funds).
const FUND_LIQUIDITY = { ISWD: 10e6, ISDE: 10e6, ISDU: 20e6, 'HSKD.L': 2e6, MZNPETF: 1e6, ACWI: 500e6, SPUS: 20e6, SPTE: 2e6, UMMA: 5e6 };

const readJson = (f, dflt) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return dflt;
  }
};
const writeJson = (f, x) => writeFileSync(f, JSON.stringify(x, null, 1));

/** This month's universe: fixed for the month and saved, so later months can't rewrite it. */
async function universe(api, dir, date, excludedIndustry, dry) {
  const month = date.slice(0, 7);
  const file = join(dir, 'universe', `${month}.json`);
  const saved = readJson(file, null);
  if (saved) return saved;
  const g = [];
  for (const grade of ['A', 'B']) {
    const r = await api.screener({ scope: 'global', kind: 'stock', dataGrade: grade, max_debtToMarketCap: '0.33', max_cashToMarketCap: '0.33', max_interestIncomeToRevenue: '0.05', min_avgValueTraded20d: '5000000', min_marketCapUsd: '1000000000', sort: '-avgValueTraded20d', limit: 500 });
    g.push(...(r?.rows || []));
  }
  const global = g
    .filter((r) => r.sector !== 'Financial Services' && !excludedIndustry.test(r.industry || ''))
    .sort((a, b) => (b.avgValueTraded20d || 0) - (a.avgValueTraded20d || 0))
    .slice(0, GLOBAL_UNIVERSE);
  const p = await api.screener({ scope: 'psx', shariah: 'true', kind: 'stock', min_avgValueTraded20d: '20000000', sort: '-avgValueTraded20d', limit: PSX_UNIVERSE });
  const pk = p?.rows || [];
  const rates = (await api.rates())?.rates || {};
  const row = (r, liq) => ({ symbol: r.symbol, currency: r.currency, country: r.country || null, region: r.region || null, sector: r.sector || null, industry: r.industry || null, liquidityUsd: liq });
  const u = {
    month,
    builtAt: new Date().toISOString(),
    rules: `Global: Shariah-screened stocks (debt and cash each under 33% of market value, interest income under 5% of revenue; no financials or excluded industries), data grade A or B, market cap over $1bn, the ${GLOBAL_UNIVERSE} most traded. PSX: the ${PSX_UNIVERSE} most traded KMI Shariah stocks (over PKR 20m a day).`,
    stocks: [...global.map((r) => row(r, r.avgValueTraded20d)), ...pk.map((r) => row(r, rates.PKR > 0 && r.avgValueTraded20d ? r.avgValueTraded20d / rates.PKR : null))]
  };
  if (!dry) {
    mkdirSync(join(dir, 'universe'), { recursive: true });
    writeJson(file, u);
  }
  return u;
}

/** Tonight's screener rows for the universe (revisions and other fields). */
async function universeRows(api, u) {
  const out = new Map();
  const want = new Set(u.stocks.map((s) => s.symbol));
  for (const q of [
    { scope: 'global', kind: 'stock', min_avgValueTraded20d: '2000000', sort: '-avgValueTraded20d', limit: 2000 },
    { scope: 'psx', kind: 'stock', min_avgValueTraded20d: '5000000', sort: '-avgValueTraded20d', limit: 300 }
  ]) {
    const r = await api.screener(q);
    for (const row of r?.rows || []) if (want.has(row.symbol)) out.set(row.symbol, row);
  }
  return out;
}

async function histories(api, symbols, log) {
  const out = {};
  const list = [...new Set(symbols)];
  for (let i = 0; i < list.length; i += 40) {
    const chunk = list.slice(i, i + 40);
    try {
      Object.assign(out, await api.historyBatch(chunk, '1y'));
    } catch (e) {
      log(`history batch failed (${chunk[0]}...): ${e.message}`);
    }
  }
  return out;
}

/** The suggested Pakistan share from the monthly signals table (last row), as a fraction. */
function pakistanShare(pi) {
  const f = join(pi, 'research', 'pakistan-signals.md');
  if (!existsSync(f)) return null;
  const lines = readFileSync(f, 'utf8').split('\n').filter((l) => l.trim().startsWith('|'));
  const header = lines[0]?.split('|').map((c) => c.trim().toLowerCase()) || [];
  const col = header.findIndex((c) => c.includes('suggested'));
  const rows = lines.slice(2);
  const last = rows.at(-1)?.split('|').map((c) => c.trim());
  const nums = (last?.[col] || '').match(/\d+(\.\d+)?/g)?.map(Number) || [];
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length / 100 : null;
}

/** Random portfolios for a finished month: the luck test. */
function randomPortfolios(month, symbols, bars, n = 1000, size = 20, cost = 0.004) {
  const start = `${month}-01`;
  const rets = [];
  for (const s of symbols) {
    const b = bars(s);
    const before = [...b].reverse().find((x) => x.date < start);
    const inMonth = b.filter((x) => x.date.slice(0, 7) === month);
    if (!before || !inMonth.length) continue;
    const r = inMonth.at(-1).adjClose / before.adjClose - 1;
    if (Number.isFinite(r) && r > -0.9 && r < 3) rets.push(r);
  }
  if (rets.length < size * 2) return null;
  // Seeded by month, so the draw is reproducible.
  let seed = [...month].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = [];
  for (let k = 0; k < n; k++) {
    let s = 0;
    const used = new Set();
    while (used.size < size) used.add(Math.floor(rand() * rets.length));
    for (const i of used) s += rets[i];
    out.push(s / size - cost);
  }
  out.sort((a, b) => a - b);
  return { month, stocks: rets.length, portfolios: n, percentiles: Array.from({ length: 21 }, (_, i) => out[Math.min(n - 1, Math.round((i / 20) * (n - 1)))]) };
}

/** Where a return falls among the random portfolios (0..1). */
function percentileIn(r, pct) {
  if (!pct) return null;
  let i = 0;
  while (i < pct.length && pct[i] <= r) i++;
  return Math.max(0, Math.min(1, (i - 0.5) / (pct.length - 1)));
}

const pctFmt = (x, d = 1) => (x == null || !Number.isFinite(x) ? '-' : `${(x * 100).toFixed(d)}%`);
const usdFmt = (x) => (x == null ? '-' : `$${Math.round(x).toLocaleString('en-US')}`);

function rulesFile(dir) {
  return readJson(join(dir, 'rules.json'), {});
}

function writeReadme(dir, rules) {
  const groups = [...new Set(STRATEGIES.map((s) => s.group))];
  const body = [
    '# Strategy forward test (paper trading)',
    '',
    'Every strategy trades paper money under fixed, written rules, decided at a close and filled at the next close, net of commissions, spreads, stamp duties and currency conversion. Rules are frozen: a change starts a new version with its own record. Started 2026-11-25 (phase 1). Run nightly by `mcp/automation/run.mjs paper`; code in `mcp/paper/` of the Stock Tracker repo.',
    '',
    'Each starts with $30,000 of paper money (the contribution strategies add it monthly). Judge only after enough time: frequent strategies after 3-6 months, monthly ones after 2-4 quarters, and always against the random portfolios (`random.json`): beating the funds but not most random portfolios is luck.',
    '',
    ...groups.flatMap((g) => [
      `## ${g}`,
      '',
      ...STRATEGIES.filter((s) => s.group === g).flatMap((s) => {
        const r = rules[s.id];
        return [`### ${s.name} (\`${s.id}\`, v${r?.version ?? s.version}, since ${r?.startedAt ?? '-'})`, '', r?.rules ?? s.rules, ''];
      })
    ])
  ].join('\n');
  writeFileSync(join(dir, 'README.md'), body);
}

function scoreboard(dir, states, random, date, dry) {
  const rows = [];
  for (const s of STRATEGIES) {
    const p = states[s.id];
    const m = p && metrics(p);
    // Monthly returns against that month's random portfolios.
    const me = p ? monthEnds(p) : [];
    const beats = [];
    for (let i = 1; i < me.length; i++) {
      const r = random.months?.[me[i].month];
      if (!r) continue;
      const flows = p.flows.filter((f) => f.date > me[i - 1].date && f.date <= me[i].date).reduce((a, f) => a + f.usd, 0);
      const ret = me[i - 1].value > 0 ? (me[i].value - flows) / me[i - 1].value - 1 : null;
      if (ret != null) beats.push(percentileIn(ret, r.percentiles));
    }
    rows.push({ s, m, luck: beats.length ? beats.reduce((a, b) => a + b, 0) / beats.length : null, months: beats.length });
  }
  const groups = [...new Set(STRATEGIES.map((s) => s.group))];
  const table = (list) => [
    '| Strategy | Return | A year | Volatility | Worst drawdown | Sharpe | Beat random | Trades | Costs | Positions |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...list.map(({ s, m, luck, months }) =>
      m
        ? `| ${s.name} | ${pctFmt(m.return)} | ${pctFmt(m.annual)} | ${pctFmt(m.volatility)} | ${pctFmt(m.maxDrawdown)} | ${m.sharpe == null ? '-' : m.sharpe.toFixed(2)} | ${luck == null ? '-' : `${Math.round(luck * 100)}% (${months} mo)`} | ${m.trades} | ${usdFmt(m.costs)} (${pctFmt(m.costsPct, 2)}) | ${m.positions} |`
        : `| ${s.name} | not started | | | | | | | | |`
    )
  ];
  const md = [
    `# Scoreboard, ${date}`,
    '',
    'Paper money, net of trading costs. "A year" appears after 30 days; volatility and Sharpe after 20 trading days. "Beat random": the average share of random 20-stock portfolios from the same universe each strategy beat, month by month (50% = no better than luck). Realised gains would owe about 15% tax (not deducted). Too early to judge anything before 3-6 months (frequent strategies) or 2-4 quarters (monthly ones).',
    '',
    ...groups.flatMap((g) => [`## ${g}`, '', ...table(rows.filter((r) => r.s.group === g)), ''])
  ].join('\n');
  if (!dry) writeFileSync(join(dir, 'scoreboard.md'), md);
  return { md, rows };
}

/**
 * @param {Object} o { api, pf, pi (records dir), date, dry, log, saveInsight, excludedIndustry }
 */
export async function runPaper(o) {
  const { api, pf, pi, date, log } = o;
  const dir = join(pi, 'strategies');
  if (!o.dry) for (const d of ['', 'state', 'trades', 'universe']) mkdirSync(join(dir, d), { recursive: true });

  const u = await universe(api, dir, date, o.excludedIndustry, o.dry);
  const rows = await universeRows(api, u);
  const research = await pf.research();
  const snapRec = research.filter((r) => r.kind === 'model_snapshot').sort((a, b) => (a.symbol < b.symbol ? 1 : -1))[0];
  const snapshot = snapRec ? { date: snapRec.symbol, variants: snapRec.data?.variants || [], symbols: snapRec.data?.symbols || null } : null;
  const targets = research.find((r) => r.kind === 'targets')?.data || null;

  // Prices for the universe, the funds and benchmarks, and anything held or targeted.
  const states = {};
  for (const s of STRATEGIES) states[s.id] = readJson(join(dir, 'state', `${s.id}.json`), null);
  const held = Object.values(states).flatMap((p) => (p ? [...Object.keys(p.positions), ...(p.pending?.buys || []).map((b) => b.symbol), ...Object.keys(p.pending?.targets || {})] : []));
  const wanted = [
    ...u.stocks.map((s) => s.symbol),
    ...EXTRA_SYMBOLS,
    ...held,
    ...Object.keys(targets?.targets || {}),
    ...(snapshot?.variants || []).flatMap((v) => Object.keys(v.weights || {})),
    ...(snapshot?.symbols || [])
  ].map((s) => String(s).toUpperCase());
  const hist = await histories(api, wanted, log);
  const rates = (await api.rates())?.rates || {};
  const info = new Map(u.stocks.map((s) => [s.symbol, s]));
  const series = new Map();
  for (const [sym, h] of Object.entries(hist)) {
    const bars = (h?.history || []).filter((b) => b.date <= date && b.price > 0).map((b) => ({ ...b, adjClose: b.adjClose > 0 ? b.adjClose : b.price }));
    if (bars.length) series.set(sym.toUpperCase(), { bars, currency: String(h.currency || info.get(sym)?.currency || 'USD').toUpperCase() });
  }
  log(`${series.size} of ${new Set(wanted).size} price series`);
  const market = {
    rates,
    bars: (s) => series.get(String(s).toUpperCase())?.bars || [],
    info: (s) => ({ currency: series.get(s)?.currency || info.get(s)?.currency || 'USD', country: info.get(s)?.country || rows.get(s)?.country || null }),
    liquidity: (s) => info.get(s)?.liquidityUsd ?? FUND_LIQUIDITY[s] ?? null
  };
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const stocks = u.stocks.map((s) => s.symbol).filter((s) => series.has(s));

  // Frozen rules: record each strategy's rules when it starts.
  const rules = rulesFile(dir);
  const fills = {};
  for (const s of STRATEGIES) {
    let p = states[s.id];
    if (p && p.version !== s.version) {
      renameSync(join(dir, 'state', `${s.id}.json`), join(dir, 'state', `${s.id}.v${p.version}.json`));
      p = null;
    }
    if (!p) {
      p = newPortfolio({ id: s.id, version: s.version, startedAt: date, cash: s.startCash ?? START_USD });
      rules[s.id] = { version: s.version, name: s.name, group: s.group, rules: s.rules, startedAt: date };
    } else if (rules[s.id]?.rules !== s.rules && rules[s.id]?.version === s.version) {
      log(`WARNING ${s.id}: rules text changed without a new version; the recorded rules stand`);
    }
    if (p.lastRunDate === date) {
      states[s.id] = p;
      continue;
    }
    const newMonth = !p.lastRunDate || p.lastRunDate.slice(0, 7) !== date.slice(0, 7);
    const log2 = [];
    markToMarket(p, date, market);
    fillPending(p, date, market, log2);
    const add = s.contribute?.({ date, newMonth }, p) || 0;
    if (add > 0) deposit(p, date, add);
    const ctx = {
      date,
      weekday,
      newMonth,
      newQuarter: newMonth && [0, 3, 6, 9].includes(new Date(`${date}T12:00:00Z`).getUTCMonth()),
      market,
      stocks,
      rows,
      bars: market.bars,
      lastBarDate: (x) => market.bars(x).at(-1)?.date,
      snapshot,
      targets,
      pakistanShare: pakistanShare(pi),
      value: value(p, date, market)
    };
    if (!p.pending) {
      try {
        const order = s.decide(ctx, p);
        if (order) p.pending = order;
      } catch (e) {
        log(`${s.id} decide failed: ${e.stack || e.message}`);
      }
    }
    recordNav(p, date, market);
    p.lastRunDate = date;
    states[s.id] = p;
    fills[s.id] = log2;
  }

  // The luck test, for each finished month not yet drawn.
  const randomFile = join(dir, 'random.json');
  const random = readJson(randomFile, { months: {} });
  const prevMonth = (() => {
    const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  })();
  if (!random.months[prevMonth] && prevMonth >= '2026-11') {
    const pu = readJson(join(dir, 'universe', `${prevMonth}.json`), u);
    const r = randomPortfolios(prevMonth, pu.stocks.map((s) => s.symbol).filter((s) => series.has(s)), market.bars);
    if (r) random.months[prevMonth] = r;
  }

  const board = scoreboard(dir, states, random, date, o.dry);
  if (o.dry) {
    log(board.md);
    for (const [id, f] of Object.entries(fills)) if (f.length) log(`${id}: ${f.length} fills`);
    for (const s of STRATEGIES) {
      const p = states[s.id];
      if (p?.pending) log(`${s.id} pending: ${p.pending.targets ? `rebalance to ${Object.keys(p.pending.targets).length} names` : `sell ${p.pending.sells?.length || 0}, buy ${(p.pending.buys || []).map((b) => b.symbol).join(' ')}`} (${p.pending.reason})`);
    }
    return board;
  }

  writeJson(join(dir, 'rules.json'), rules);
  writeReadme(dir, rules);
  writeJson(randomFile, random);
  for (const s of STRATEGIES) {
    writeJson(join(dir, 'state', `${s.id}.json`), states[s.id]);
    const f = fills[s.id] || [];
    if (f.length) {
      const file = join(dir, 'trades', `${s.id}.csv`);
      if (!existsSync(file)) writeFileSync(file, 'decided,filled,symbol,side,shares,price,currency,value_usd,cost_usd,reason\n');
      appendFileSync(file, f.map((t) => [t.date, t.fillDate, t.symbol, t.side, +t.shares.toFixed(4), +t.price.toFixed(4), t.currency, t.value.toFixed(2), t.cost.total.toFixed(2), JSON.stringify(t.reason || '')].join(',')).join('\n') + '\n');
    }
  }
  // Weekly in the app: Friday's run (and the first).
  if (weekday === 5 || !o.insightId) {
    const saved = await o.saveInsight({
      id: o.insightId,
      kind: 'note',
      title: `Strategy scoreboard, week of ${date}`,
      summary: 'Paper-trading forward test of the strategies (net of costs). Too early to judge before 3-6 months.',
      body: board.md
    });
    o.onInsight?.(saved.id);
  }
  return board;
}
