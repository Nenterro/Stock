/**
 * Paper-trading strategies (forward test, started November 2026). Each has
 * written rules (`rules`) that are frozen: changing a strategy means a new
 * `version`, which starts a new record. Rules are also published in the
 * Personal Investment records (strategies/README.md) before they run.
 *
 * decide(ctx, p) runs at a day's close and returns an order set for the
 * engine to fill at the next close (engine.fillPending), or null.
 *   ctx: { date, weekday (0 Sun..6 Sat), newMonth, newQuarter, market,
 *          stocks: universe stock symbols, rows: symbol -> screener row,
 *          bars(sym) (up to date), snapshot, targets, pakistanShare, value }
 */
import { closes, sma, ret, momentum12_1, rsi, high, bullishPatterns, bearishPatterns, volumeRatio } from './indicators.mjs';

const VERSION = 1;

/* ---------------------------------------------------------------- helpers */

function normalise(w) {
  const pos = Object.entries(w).filter(([, x]) => x > 0);
  const s = pos.reduce((a, [, x]) => a + x, 0);
  return s > 0 ? Object.fromEntries(pos.map(([k, x]) => [k, x / s])) : {};
}

/** Rebalance to weights, keeping only symbols with prices. */
function rebalance(ctx, weights, reason) {
  const w = Object.fromEntries(Object.entries(weights).filter(([s]) => ctx.bars(s).length));
  return Object.keys(w).length ? { createdOn: ctx.date, targets: normalise(w), reason } : null;
}

/** Percentile ranks (0..1) of a metric across symbols; null where missing. */
function percentiles(symbols, fn) {
  const vals = symbols.map((s) => [s, fn(s)]).filter(([, v]) => v != null && Number.isFinite(v));
  vals.sort((a, b) => a[1] - b[1]);
  const out = new Map();
  vals.forEach(([s], i) => out.set(s, vals.length > 1 ? i / (vals.length - 1) : 0.5));
  return out;
}

/** Composite score: mean of the available percentiles. */
function composite(symbols, fns) {
  const ps = fns.map((fn) => percentiles(symbols, fn));
  const out = [];
  for (const s of symbols) {
    const v = ps.map((m) => m.get(s)).filter((x) => x != null);
    if (v.length) out.push({ s, score: v.reduce((a, b) => a + b, 0) / v.length });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** A price series is usable when its last bar is recent (no stale or halted stocks). */
function fresh(ctx, s, maxDays = 5) {
  const b = ctx.bars(s);
  return b.length >= 60 && (Date.parse(ctx.date) - Date.parse(b.at(-1).date)) / 86400000 <= maxDays;
}

/** Keep-and-fill selection with a buffer: holdings stay while ranked within `keep`. */
function selectWithBuffer(ranked, held, n, keep) {
  const rank = new Map(ranked.map((x, i) => [x.s, i]));
  const kept = held.filter((s) => (rank.get(s) ?? Infinity) < keep);
  const out = [...kept];
  for (const x of ranked) {
    if (out.length >= n) break;
    if (!out.includes(x.s)) out.push(x.s);
  }
  return out.slice(0, Math.max(n, kept.length));
}

/** Order set from a selection: sell what left, buy new names at an equal slot. */
function equalSlots(ctx, p, selected, n, reason) {
  const held = Object.keys(p.positions);
  const sells = held.filter((s) => !selected.includes(s));
  const slot = ctx.value / n;
  const buys = selected.filter((s) => !held.includes(s)).map((symbol) => ({ symbol, usd: slot }));
  return sells.length || buys.length ? { createdOn: ctx.date, sells, buys, reason } : null;
}

const started = (p) => p.nav.length > 0 || Object.keys(p.positions).length > 0 || p.lastRebalance;

/* ------------------------------------------------------------- strategies */

const FUNDS_ONLY = { ISWD: 0.7, MZNPETF: 0.3 };

export const STRATEGIES = [
  /* --- current approach --- */
  {
    id: 'system',
    name: 'System (pack targets)',
    group: 'Current approach',
    rules: 'Hold the decision pack targets (planner targets saved by set_targets). Rebalance when the targets change and on the first trading day of each month.',
    decide(ctx, p) {
      const t = ctx.targets;
      if (!t?.targets) return null;
      const changed = p.notes.targetsAt !== t.updatedAt;
      if (!changed && started(p) && !ctx.newMonth) return null;
      p.notes.targetsAt = t.updatedAt;
      return rebalance(ctx, t.targets, changed ? 'targets changed' : 'monthly rebalance');
    }
  },
  ...[1, 2, 4].map((ra) => ({
    id: `optimiser-ra${ra}`,
    name: `Optimiser, risk aversion ${ra}`,
    group: 'Current approach',
    rules: `The weekly unconstrained optimiser run at risk aversion ${ra} (${{ 1: 'growth-optimal, full Kelly', 2: 'half Kelly, the current setting', 4: 'conservative' }[ra]}), research verdicts applied, as output with no overrides. Rebalance to the latest run on the first trading day of each month (and at the start).`,
    decide(ctx, p) {
      const w = ctx.snapshot?.variants?.find((v) => v.name === `Risk aversion ${ra}` || (ra === 2 && v.name === 'Unconstrained'))?.weights;
      if (!w || (started(p) && !ctx.newMonth)) return null;
      return rebalance(ctx, w, `monthly rebalance to the ${ctx.snapshot.date} run`);
    }
  })),

  /* --- rules-based active --- */
  {
    id: 'rotation',
    name: 'Monthly rotation (revisions + momentum)',
    group: 'Rules-based active',
    rules: 'Universe stocks ranked by the mean percentile of 90-day EPS estimate revision, revision breadth (up minus down over 30 days) and 12-1 month momentum. Hold the top 20, equal weight; a holding stays while ranked in the top 40. Rebalance on the first trading day of each month.',
    decide(ctx, p) {
      if (started(p) && !ctx.newMonth) return null;
      const syms = ctx.stocks.filter((s) => fresh(ctx, s));
      const ranked = composite(syms, [(s) => ctx.rows.get(s)?.epsRevision90d, (s) => ctx.rows.get(s)?.revisionBreadth, (s) => momentum12_1(closes(ctx.bars(s)))]);
      const pick = selectWithBuffer(ranked, Object.keys(p.positions), 20, 40);
      return rebalance(ctx, Object.fromEntries(pick.map((s) => [s, 1])), 'monthly rotation');
    }
  },
  {
    id: 'active-rules',
    name: 'Frequent trading, rules',
    group: 'Rules-based active',
    rules: 'Twice a week (Monday and Thursday closes). Universe stocks above their 50-day average, ranked by the mean percentile of 30-day EPS estimate revision and 20-day return. Hold the top 15 at equal slots; a holding stays while ranked in the top 30. Sells and new buys only (no trimming).',
    decide(ctx, p) {
      if (started(p) && ![1, 4].includes(ctx.weekday)) return null;
      const syms = ctx.stocks.filter((s) => fresh(ctx, s)).filter((s) => {
        const xs = closes(ctx.bars(s));
        const m = sma(xs, 50);
        return m && xs.at(-1) > m;
      });
      const ranked = composite(syms, [(s) => ctx.rows.get(s)?.epsRevision30d, (s) => ret(closes(ctx.bars(s)), 20)]);
      const pick = selectWithBuffer(ranked, Object.keys(p.positions).filter((s) => syms.includes(s)), 15, 30);
      return equalSlots(ctx, p, pick, 15, 'twice-weekly ranking');
    }
  },

  /* --- technical --- */
  {
    id: 'trend',
    name: 'Technical: trend and momentum',
    group: 'Technical',
    rules: 'Weekly (Monday close). Buy universe stocks with close above the 200-day average, 50-day above 200-day, and within 5% of the 52-week high, ranked by 6-month return: up to 20 at equal slots. Sell when the close falls below the 200-day average, or the stock drops out of the top 60 by 6-month return. Unused slots stay in cash.',
    decide(ctx, p) {
      if (started(p) && ctx.weekday !== 1) return null;
      const syms = ctx.stocks.filter((s) => fresh(ctx, s));
      const f = new Map(
        syms.map((s) => {
          const xs = closes(ctx.bars(s));
          return [s, { c: xs.at(-1), s50: sma(xs, 50), s200: sma(xs, 200), hi: high(xs, Math.min(252, xs.length)), r126: ret(xs, 126) }];
        })
      );
      const byRet = syms.filter((s) => f.get(s).r126 != null).sort((a, b) => f.get(b).r126 - f.get(a).r126);
      const top60 = new Set(byRet.slice(0, 60));
      const held = Object.keys(p.positions);
      const reasons = {};
      const sells = held.filter((s) => {
        const x = f.get(s);
        if (!x || !x.s200 || x.c < x.s200) return (reasons[s] = 'below the 200-day average');
        if (!top60.has(s)) return (reasons[s] = 'out of the top 60 by 6-month return');
        return false;
      });
      const eligible = byRet.filter((s) => {
        const x = f.get(s);
        return x.s200 && x.s50 && x.c > x.s200 && x.s50 > x.s200 && x.c >= 0.95 * x.hi && !held.includes(s);
      });
      const free = 20 - (held.length - sells.length);
      const buys = eligible.slice(0, Math.max(0, free)).map((symbol) => ({ symbol, usd: ctx.value / 20 }));
      return sells.length || buys.length ? { createdOn: ctx.date, sells, buys, reasons, reason: 'trend entry' } : null;
    }
  },
  {
    id: 'fund-timing',
    name: 'Technical: fund trend timing',
    group: 'Technical',
    rules: 'The funds-only mix (70% ISWD, 30% MZNPETF), each sleeve held only while its fund closes above its 10-month (210-day) average; otherwise ISWD\'s 70% goes to the sukuk ETF HSKD and MZNPETF\'s 30% to cash. Checked on the first trading day of each month.',
    decide(ctx, p) {
      if (started(p) && !ctx.newMonth) return null;
      const above = (s) => {
        const xs = closes(ctx.bars(s));
        const m = sma(xs, Math.min(210, xs.length - 1));
        return m != null && xs.at(-1) > m;
      };
      const w = {};
      if (above('ISWD')) w.ISWD = 0.7;
      else if (ctx.bars('HSKD.L').length) w['HSKD.L'] = 0.7;
      if (above('MZNPETF')) w.MZNPETF = 0.3;
      const total = Object.values(w).reduce((a, b) => a + b, 0);
      // Weights below 1 leave the rest in cash (rebalance() would normalise).
      return total > 0 ? { createdOn: ctx.date, targets: w, reason: 'monthly trend check' } : { createdOn: ctx.date, targets: {}, reason: 'all sleeves below trend' };
    }
  },
  {
    id: 'patterns',
    name: 'Technical: chart patterns',
    group: 'Technical',
    rules: 'Daily. Buy on a confirmed bullish breakout (double bottom, inverse head and shoulders, ascending triangle, bull flag, 60-day resistance breakout; close crosses the level with volume 1.5x+ its 20-day average where volume exists), definitions in mcp/paper/indicators.mjs. Up to 15 positions at equal slots, strongest volume first. Sell at the stop (pattern low), the measured-move target, after 40 trading days, or on a bearish breakdown (double top, head and shoulders).',
    decide(ctx, p) {
      const reasons = {};
      const sells = [];
      for (const [s, pos] of Object.entries(p.positions)) {
        const bars = ctx.bars(s);
        if (!bars.length) continue;
        const c = closes(bars).at(-1);
        const m = pos.meta || {};
        const held = bars.filter((b) => b.date > pos.entryDate).length;
        // Stop and target are on the adjusted-close scale the pattern was found on.
        if (m.stopAdj && c <= m.stopAdj) reasons[s] = `stop (${m.pattern})`;
        else if (m.targetAdj && c >= m.targetAdj) reasons[s] = `target (${m.pattern})`;
        else if (held >= 40) reasons[s] = 'time stop (40 days)';
        else {
          const bear = bearishPatterns(bars);
          if (bear.length) reasons[s] = `bearish ${bear[0].pattern}`;
        }
        if (reasons[s]) sells.push(s);
      }
      const holding = Object.keys(p.positions).length - sells.length;
      const free = 15 - holding;
      const buys = [];
      if (free > 0) {
        const found = [];
        for (const s of ctx.stocks) {
          if (p.positions[s] || !fresh(ctx, s, 3)) continue;
          const bars = ctx.bars(s);
          if (bars.at(-1).date !== ctx.lastBarDate(s)) continue;
          const pats = bullishPatterns(bars);
          if (pats.length) found.push({ s, pat: pats[0], vr: volumeRatio(bars) ?? 1 });
        }
        found.sort((a, b) => b.vr - a.vr);
        for (const f of found.slice(0, free)) {
          buys.push({ symbol: f.s, usd: ctx.value / 15, reason: f.pat.pattern, meta: { pattern: f.pat.pattern, stopAdj: f.pat.stop, targetAdj: f.pat.target, level: f.pat.breakout } });
        }
      }
      return sells.length || buys.length ? { createdOn: ctx.date, sells, buys, reasons, reason: 'pattern' } : null;
    }
  },
  {
    id: 'mean-reversion',
    name: 'Technical: short-term mean reversion',
    group: 'Technical',
    rules: 'Daily. Buy universe stocks in a long-term uptrend (close above the 200-day average) whose 2-day RSI is below 10, most oversold first, up to 10 positions at equal slots. Sell when the close rises above the 5-day average, after 10 trading days, or at a 10% loss.',
    decide(ctx, p) {
      const reasons = {};
      const sells = [];
      for (const [s, pos] of Object.entries(p.positions)) {
        const bars = ctx.bars(s);
        if (!bars.length) continue;
        const xs = closes(bars);
        const c = xs.at(-1);
        const held = bars.filter((b) => b.date > pos.entryDate).length;
        const entry = pos.meta?.entryAdj;
        if (held >= 1 && c > sma(xs, 5)) reasons[s] = 'above the 5-day average';
        else if (held >= 10) reasons[s] = 'time stop (10 days)';
        else if (entry && c <= entry * 0.9) reasons[s] = 'stop (-10%)';
        if (reasons[s]) sells.push(s);
      }
      const free = 10 - (Object.keys(p.positions).length - sells.length);
      const buys = [];
      if (free > 0) {
        const cands = [];
        for (const s of ctx.stocks) {
          if (p.positions[s] || !fresh(ctx, s, 3) || ctx.bars(s).at(-1).date !== ctx.lastBarDate(s)) continue;
          const xs = closes(ctx.bars(s));
          const s200 = sma(xs, 200);
          const r2 = rsi(xs, 2);
          if (s200 && xs.at(-1) > s200 && r2 != null && r2 < 10) cands.push({ s, r2, c: xs.at(-1) });
        }
        cands.sort((a, b) => a.r2 - b.r2);
        for (const x of cands.slice(0, free)) buys.push({ symbol: x.s, usd: ctx.value / 10, reason: `RSI(2) ${x.r2.toFixed(1)}`, meta: { entryAdj: x.c } });
      }
      return sells.length || buys.length ? { createdOn: ctx.date, sells, buys, reasons, reason: 'mean reversion' } : null;
    }
  },

  /* --- Claude traders (phase 2) --- */
  ...[
    {
      id: 'claude-news',
      name: 'Claude trader: short-term (news)',
      maxPositions: 10,
      rules:
        'A daily Claude session (Opus, weeknights after the US close, instructions in mcp/automation/TRADER_NEWS.md) trades on news, the risk register and price action, holding days to a few weeks. It sees only its own desk (its portfolio, the universe, its journal) and read-only market and news tools: not the user\'s portfolio, research, insights or the other strategies. Long only, the month\'s universe plus the core funds, at most 10 positions, buys of $300+, no position above 20% of the portfolio; every decision states a reason, a "wrong if" and a horizon. Its orders fill at the next close.'
    },
    {
      id: 'claude-fundamental',
      name: 'Claude trader: fundamental',
      maxPositions: 20,
      rules:
        'A weekly Claude session (Opus, Saturdays, instructions in mcp/automation/TRADER_FUNDAMENTAL.md) picks stocks on fundamentals: valuation on recurring earnings, statements, estimate revisions, results and guidance, and news, holding for months. It sees only its own desk and read-only market tools (no optimiser, no user portfolio, research, insights or other strategies) and keeps its own theses. Long only, the month\'s universe plus the core funds, at most 20 positions, buys of $300+, no position above 20% of the portfolio; every decision states a reason, a "wrong if" and a horizon. Its orders fill at the next close.'
    }
  ].map((t) => ({
    ...t,
    group: 'Claude traders',
    claude: true,
    decide(ctx, p) {
      const o = ctx.claudeOrders?.(t.id);
      if (!o) return null;
      const { order, rejected } = ordersFromClaude(o, p, ctx, { maxPositions: t.maxPositions });
      if (rejected.length) p.notes.rejected = [...(p.notes.rejected || []), ...rejected].slice(-50);
      return order;
    }
  })),

  /* --- controls --- */
  {
    id: 'equal-weight',
    name: 'Equal weight (optimiser candidates)',
    group: 'Controls',
    rules: "Equal weight across the weekly optimiser's candidate list (stocks and funds), rebalanced on the first trading day of each quarter. Tests whether the optimiser's weighting adds anything over the same names held equally.",
    decide(ctx, p) {
      const list = ctx.snapshot?.symbols;
      if (!list?.length || (started(p) && !ctx.newQuarter)) return null;
      return rebalance(ctx, Object.fromEntries(list.map((s) => [s, 1])), 'quarterly equal weight');
    }
  },
  {
    id: 'pakistan-timing',
    name: 'Pakistan timing (signals score)',
    group: 'Controls',
    rules: 'ISWD and MZNPETF, with the Pakistan share set each month from the suggested share in research/pakistan-signals.md (30% until the first score). Compare with funds-only (fixed 30%). Rebalanced on the first trading day of each month.',
    decide(ctx, p) {
      if (started(p) && !ctx.newMonth) return null;
      const k = Math.max(0.1, Math.min(0.4, ctx.pakistanShare ?? 0.3));
      return rebalance(ctx, { ISWD: 1 - k, MZNPETF: k }, `Pakistan ${Math.round(k * 100)}%`);
    }
  },
  {
    id: 'contrib-dca',
    name: 'New money: monthly (DCA)',
    group: 'Controls',
    startCash: 0,
    rules: '$2,500 on the first trading day of each month for 12 months ($30,000 in all), invested straight into the funds-only mix (70% ISWD, 30% MZNPETF). Compare with funds-only, which invests $30,000 at the start (lump sum).',
    contribute(ctx, p) {
      return ctx.newMonth || !started(p) ? (p.flows.length < 12 ? 2500 : 0) : 0;
    },
    decide(ctx, p) {
      return p.cash > 200 ? rebalance(ctx, FUNDS_ONLY, 'invest new money') : null;
    }
  },
  {
    id: 'contrib-dip',
    name: 'New money: wait for dips',
    group: 'Controls',
    startCash: 0,
    rules: "$2,500 on the first trading day of each month for 12 months, held in cash until ISWD closes 10% or more below its 52-week high, then everything goes into the funds-only mix. After the 12th deposit any cash left is invested on the next month's first trading day.",
    contribute(ctx, p) {
      return ctx.newMonth || !started(p) ? (p.flows.length < 12 ? 2500 : 0) : 0;
    },
    decide(ctx, p) {
      if (p.cash < 200) return null;
      const xs = closes(ctx.bars('ISWD'));
      const dip = xs.length && xs.at(-1) <= 0.9 * high(xs, Math.min(252, xs.length));
      const done = p.flows.length >= 12 && ctx.newMonth;
      return dip || done ? rebalance(ctx, FUNDS_ONLY, dip ? 'ISWD 10% below its high' : 'deposits finished') : null;
    }
  },

  /* --- benchmarks --- */
  ...[
    ['funds-only', 'Benchmark: funds only (lump sum)', FUNDS_ONLY],
    ['acwi', 'Benchmark: MSCI ACWI (not Shariah)', { ACWI: 1 }],
    ['mznpetf', 'Benchmark: Meezan Pakistan ETF', { MZNPETF: 1 }],
    ['previous', 'Benchmark: previous holdings', { SPTE: 0.138, UMMA: 0.138, SPUS: 0.138, ISDU: 0.138, ISDE: 0.125, FFC: 0.108, MEBL: 0.108, OGDC: 0.107 }]
  ].map(([id, name, w]) => ({
    id,
    name,
    group: 'Benchmarks',
    rules: `Fixed weights ${Object.entries(w).map(([s, x]) => `${s} ${Math.round(x * 1000) / 10}%`).join(', ')}, rebalanced on the first trading day of each month.`,
    decide(ctx, p) {
      return started(p) && !ctx.newMonth ? null : rebalance(ctx, w, 'monthly rebalance');
    }
  }))
].map((s) => ({ version: VERSION, ...s }));

/** Funds a Claude trader may hold besides the universe stocks (somewhere to wait). */
export const TRADER_FUNDS = ['ISWD', 'ISDE', 'MZNPETF', 'HSKD.L'];

/**
 * Turn a Claude trader's orders.json into an engine order set, enforcing its
 * rules in code: universe or core funds only, sells only of holdings, buys of
 * $300+, at most 20% of the portfolio in one name (including what is held),
 * at most `maxPositions` names. Anything else is rejected with the reason.
 *   o: { asOf, createdOn, decisions: [{ symbol, action: buy|trim|sell, usd?, reason, wrongIf, horizon }] }
 */
export function ordersFromClaude(o, p, ctx, { maxPositions }) {
  const rejected = [];
  const reject = (d, why) => rejected.push({ date: o.createdOn, symbol: d?.symbol ?? null, action: d?.action ?? null, why });
  const allowed = new Set([...ctx.stocks, ...TRADER_FUNDS]);
  const held = new Set(Object.keys(p.positions));
  const heldValue = (s) => {
    const pos = p.positions[s];
    const b = pos && ctx.bars(s).at(-1);
    const fx = pos && (pos.currency === 'USD' ? 1 : ctx.market?.rates?.[pos.currency] > 0 ? 1 / ctx.market.rates[pos.currency] : 0);
    return b && fx ? pos.shares * b.price * fx : 0;
  };
  const sells = [];
  const buys = [];
  const reasons = {};
  const exiting = new Set();
  for (const d0 of Array.isArray(o.decisions) ? o.decisions : []) {
    const d = { ...d0, symbol: String(d0?.symbol || '').toUpperCase(), action: String(d0?.action || '').toLowerCase() };
    if (!d.reason || !d.wrongIf) {
      reject(d, 'missing reason or wrongIf');
      continue;
    }
    if (d.action === 'sell' || d.action === 'trim') {
      if (!held.has(d.symbol)) {
        reject(d, 'not held');
        continue;
      }
      if (d.action === 'trim' && !(Number(d.usd) > 0)) {
        reject(d, 'trim needs usd');
        continue;
      }
      sells.push(d.action === 'sell' ? d.symbol : { symbol: d.symbol, usd: Number(d.usd), reason: d.reason });
      if (d.action === 'sell') exiting.add(d.symbol);
      reasons[d.symbol] = d.reason;
    } else if (d.action === 'buy') {
      const usd = Number(d.usd);
      if (!allowed.has(d.symbol)) {
        reject(d, 'outside the universe and core funds');
        continue;
      }
      if (!(usd >= 300)) {
        reject(d, 'buys must be $300 or more');
        continue;
      }
      if (!ctx.bars(d.symbol).length) {
        reject(d, 'no price data');
        continue;
      }
      const cap = 0.2 * ctx.value - heldValue(d.symbol);
      if (cap < 300) {
        reject(d, 'already at the 20% limit');
        continue;
      }
      buys.push({ symbol: d.symbol, usd: Math.min(usd, cap), reason: d.reason, meta: { reason: d.reason, wrongIf: d.wrongIf, horizon: d.horizon ?? null, decided: o.createdOn } });
    } else reject(d, `unknown action "${d.action}"`);
  }
  // Position limit: names after the sells, new names in the order given.
  const after = new Set([...held].filter((s) => !exiting.has(s)));
  const kept = [];
  for (const b of buys) {
    if (after.has(b.symbol) || after.size < maxPositions) {
      after.add(b.symbol);
      kept.push(b);
    } else reject(b, `more than ${maxPositions} positions`);
  }
  const order = sells.length || kept.length ? { createdOn: o.createdOn, sells, buys: kept, reasons, reason: 'Claude trader' } : null;
  return { order, rejected };
}

/** Every symbol a strategy may need prices for beyond the universe. */
export const EXTRA_SYMBOLS = ['ISWD', 'ISDE', 'MZNPETF', 'HSKD.L', 'ACWI', 'SPTE', 'UMMA', 'SPUS', 'ISDU', 'FFC', 'MEBL', 'OGDC'];
