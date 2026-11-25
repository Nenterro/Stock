/**
 * Paper-trading engine: portfolios, fills, costs, dividends, splits, NAV.
 * Plain code, no Claude. Each strategy (strategies.mjs) decides at a day's
 * close; its orders fill at the *next* close of each symbol, so no strategy
 * trades on a price it could not have had.
 *
 * Money is tracked in USD. Positions hold whole shares (100-share lots in
 * Tokyo and Singapore). Dividends arrive as cash after withholding at
 * source; splits are detected and share counts adjusted.
 */
import { dividendTaxRate } from '../../src/utils/models/construct.js';

export const START_USD = 30000;

/* ------------------------------------------------------------- the market */

/** Market of a symbol, from its suffix and currency. */
export function marketOf(symbol, currency) {
  const s = String(symbol).toUpperCase();
  if (String(currency).toUpperCase() === 'PKR') return 'psx';
  const m = s.match(/\.([A-Z]+)$/);
  const sfx = m ? m[1] : '';
  if (!sfx || sfx === 'US') return 'us';
  return { L: 'uk', HK: 'hk', T: 'jp', SI: 'sg', TO: 'ca', AX: 'au' }[sfx] || 'eu';
}

export const lotSize = (symbol) => (/\.(T|SI)$/i.test(symbol) ? 100 : 1);

const FUNDS = new Set(['ISWD', 'ISDE', 'ISDU', 'IGDA', 'MZNPETF', 'HSKD.L', 'RMAU.L', 'ACWI', 'SPUS', 'HLAL', 'UMMA']);
export const isFund = (symbol) => FUNDS.has(String(symbol).toUpperCase());

/**
 * Cost of one trade in USD (IBKR tiered commissions, approximate, November
 * 2026; PSX broker rates), plus half the bid-ask spread by liquidity, stamp
 * duties and the currency conversion. Returns its parts.
 *   value     trade value in USD
 *   liquidity average daily value traded, USD (null: assume thin)
 */
export function tradeCost({ symbol, currency, value, shares, side, liquidity }) {
  const mkt = marketOf(symbol, currency);
  const v = Math.abs(value);
  let commission;
  let stamp = 0;
  switch (mkt) {
    case 'us':
      commission = Math.min(Math.max(0.35, 0.0035 * shares), 0.01 * v);
      break;
    case 'uk':
      commission = Math.max(1.3, 0.0005 * v);
      // 0.5% stamp duty on buying UK shares (ETFs are exempt).
      if (side === 'buy' && !isFund(symbol)) stamp = 0.005 * v;
      break;
    case 'hk':
      commission = Math.max(2.3, 0.0005 * v);
      stamp = 0.001 * v + 0.0001 * v; // stamp duty both sides, plus levies
      break;
    case 'jp':
      commission = Math.max(0.55, 0.0005 * v);
      break;
    case 'sg':
      commission = Math.max(1.9, 0.0008 * v);
      break;
    case 'ca':
      commission = Math.max(0.72, 0.01 * shares * 0.72);
      break;
    case 'au':
      commission = Math.max(4, 0.0008 * v);
      break;
    case 'psx':
      // Broker 0.15% plus CDC, NCCPL and SECP charges.
      commission = 0.0017 * v;
      break;
    default:
      commission = Math.max(1.35, 0.0005 * v);
      // French financial-transactions tax on buys.
      if (side === 'buy' && /\.PA$/i.test(symbol)) stamp = 0.004 * v;
  }
  const liq = liquidity ?? 0;
  let half = liq >= 100e6 ? 0.0002 : liq >= 20e6 ? 0.0005 : liq >= 5e6 ? 0.001 : liq >= 1e6 ? 0.0025 : 0.005;
  if (isFund(symbol)) half = Math.max(half, 0.001);
  if (mkt === 'psx') half = Math.max(half, 0.002);
  const fx = mkt === 'us' || mkt === 'psx' ? 0 : 0.0003 * v;
  const spread = half * v;
  return { commission, stamp, spread, fx, total: commission + stamp + spread + fx };
}

/* ------------------------------------------------------------- portfolios */

export function newPortfolio({ id, version = 1, startedAt, cash = START_USD }) {
  return {
    id,
    version,
    startedAt,
    cash,
    positions: {},
    pending: null,
    nav: [],
    flows: cash ? [{ date: startedAt, usd: cash }] : [],
    stats: { trades: 0, turnover: 0, commission: 0, stamp: 0, spread: 0, fx: 0, dividends: 0, withholding: 0, realised: {} },
    lastRebalance: null,
    lastRunDate: null,
    notes: {}
  };
}

/** The bar for a date, or the last one before it. */
export function barAt(bars, date) {
  if (!bars?.length) return null;
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].date <= date) return bars[i];
  return null;
}

/** The first bar strictly after a date (the fill bar for an order placed then). */
export function barAfter(bars, date) {
  return bars?.find((b) => b.date > date) || null;
}

const usdPer = (rates, ccy) => {
  const c = String(ccy || 'USD').toUpperCase();
  const r = rates?.[c];
  return c === 'USD' ? 1 : r > 0 ? 1 / r : null;
};

/**
 * Bring each position to the latest bar up to `date`: adjust for splits,
 * pay dividends (after withholding) into cash. Uses today's series for both
 * ends, so a series that Yahoo has re-based since yesterday stays consistent.
 */
export function markToMarket(p, date, market) {
  for (const [sym, pos] of Object.entries(p.positions)) {
    const bars = market.bars(sym);
    const now = barAt(bars, date);
    if (!now) continue;
    const then = pos.lastDate ? bars.find((b) => b.date === pos.lastDate) : null;
    if (then && pos.lastPrice > 0 && then.price > 0) {
      // Split or bonus: yesterday's stored price vs the same bar re-based today.
      const k = pos.lastPrice / then.price;
      if (Math.abs(Math.log(k)) > 0.18) {
        pos.shares = pos.shares * k;
        p.notes[sym] = `share count x${k.toFixed(3)} on ${date} (split or bonus)`;
      }
      if (now.date > then.date) {
        const factor = now.adjClose / then.adjClose / (now.price / then.price);
        if (factor > 1.0005 && factor < 1.5) {
          const fx = usdPer(market.rates, pos.currency) ?? 0;
          const gross = pos.shares * then.price * (factor - 1) * fx;
          const wht = gross * dividendTaxRate({ symbol: sym, kind: isFund(sym) ? 'etf' : 'stock', currency: pos.currency, country: pos.country });
          p.cash += gross - wht;
          p.stats.dividends += gross;
          p.stats.withholding += wht;
        }
      }
    }
    pos.lastDate = now.date;
    pos.lastPrice = now.price;
  }
}

/** Portfolio value in USD at the latest bars up to `date`. */
export function value(p, date, market) {
  let v = p.cash;
  for (const [sym, pos] of Object.entries(p.positions)) {
    const b = barAt(market.bars(sym), date);
    const fx = usdPer(market.rates, pos.currency);
    if (b && fx) v += pos.shares * b.price * fx;
    else if (pos.lastPrice && fx) v += pos.shares * pos.lastPrice * fx;
  }
  return v;
}

function recordTrade(p, t, log) {
  p.stats.trades += 1;
  p.stats.turnover += Math.abs(t.value);
  for (const k of ['commission', 'stamp', 'spread', 'fx']) p.stats[k] += t.cost[k];
  log.push(t);
}

function sell(p, sym, shares, bar, date, market, log, reason) {
  const pos = p.positions[sym];
  if (!pos || shares <= 0) return;
  shares = Math.min(shares, pos.shares);
  const fx = usdPer(market.rates, pos.currency);
  if (!fx) return;
  const val = shares * bar.price * fx;
  const cost = tradeCost({ symbol: sym, currency: pos.currency, value: val, shares, side: 'sell', liquidity: market.liquidity(sym) });
  const basis = pos.costUsd * (shares / pos.shares);
  const year = date.slice(0, 4);
  p.stats.realised[year] = (p.stats.realised[year] || 0) + (val - cost.total - basis);
  p.cash += val - cost.total;
  pos.costUsd -= basis;
  pos.shares -= shares;
  if (pos.shares < 1e-9) delete p.positions[sym];
  recordTrade(p, { date, fillDate: bar.date, symbol: sym, side: 'sell', shares, price: bar.price, currency: pos.currency, value: -val, cost, reason }, log);
}

function buy(p, sym, usdAmount, bar, date, market, log, reason, meta) {
  const info = market.info(sym);
  const currency = info.currency;
  const fx = usdPer(market.rates, currency);
  if (!fx || !(bar.price > 0)) return 0;
  const lot = lotSize(sym);
  const unit = bar.price * fx * lot;
  let lots = Math.floor(usdAmount / unit);
  if (lots <= 0) return 0;
  let val = lots * unit;
  let cost = tradeCost({ symbol: sym, currency, value: val, shares: lots * lot, side: 'buy', liquidity: market.liquidity(sym) });
  while (lots > 0 && val + cost.total > p.cash) {
    lots -= 1;
    val = lots * unit;
    cost = tradeCost({ symbol: sym, currency, value: val, shares: lots * lot, side: 'buy', liquidity: market.liquidity(sym) });
  }
  if (lots <= 0) return 0;
  const shares = lots * lot;
  const pos = p.positions[sym] || { shares: 0, costUsd: 0, currency, country: info.country || null, entryDate: bar.date, meta: meta || null };
  pos.shares += shares;
  pos.costUsd += val + cost.total;
  pos.lastDate = bar.date;
  pos.lastPrice = bar.price;
  if (meta) pos.meta = meta;
  p.positions[sym] = pos;
  p.cash -= val + cost.total;
  recordTrade(p, { date, fillDate: bar.date, symbol: sym, side: 'buy', shares, price: bar.price, currency, value: val, cost, reason }, log);
  return val;
}

/**
 * Fill the pending order set (placed at an earlier close) at each symbol's
 * next close after it was placed. An order set is
 *   { createdOn, targets?: { SYM: weight }, buys?: [{ symbol, usd, meta }],
 *     sells?: [SYM], reason }
 * `targets` rebalances the whole portfolio (anything not listed is sold).
 * Symbols with no bar yet after `createdOn` wait; after 5 days they are
 * dropped (a halted or delisted stock).
 */
export function fillPending(p, date, market, log) {
  const o = p.pending;
  if (!o) return;
  const fillBar = (sym) => {
    const b = barAfter(market.bars(sym), o.createdOn);
    return b && b.date <= date ? b : null;
  };
  const stale = (Date.parse(date) - Date.parse(o.createdOn)) / 86400000 > 5;
  const waiting = [];

  if (o.targets) {
    const syms = [...new Set([...Object.keys(o.targets), ...Object.keys(p.positions)])];
    const ready = syms.filter((s) => fillBar(s));
    if (ready.length < syms.length && !stale) return; // fill a rebalance together
    // Value at the fill prices.
    let total = p.cash;
    for (const [s, pos] of Object.entries(p.positions)) {
      const b = fillBar(s) || barAt(market.bars(s), date);
      const fx = usdPer(market.rates, pos.currency);
      if (b && fx) total += pos.shares * b.price * fx;
    }
    // Sells first (including names no longer targeted), then buys.
    for (const [s, pos] of Object.entries({ ...p.positions })) {
      const b = fillBar(s);
      if (!b) continue;
      const fx = usdPer(market.rates, pos.currency);
      const want = (o.targets[s] || 0) * total;
      const have = pos.shares * b.price * fx;
      if (have > want * 1.02 + 1) {
        const unit = b.price * fx * lotSize(s);
        const excess = Math.ceil((have - want) / unit) * lotSize(s);
        sell(p, s, (o.targets[s] || 0) === 0 ? pos.shares : excess, b, date, market, log, o.reason);
      }
    }
    for (const [s, w] of Object.entries(o.targets)) {
      const b = fillBar(s);
      if (!b || !(w > 0)) continue;
      const pos = p.positions[s];
      const fx = usdPer(market.rates, pos?.currency || market.info(s).currency);
      const have = pos && fx ? pos.shares * b.price * fx : 0;
      const want = w * total;
      // Skip small top-ups of a holding: they cost more than the drift. A
      // new position is bought at any size a whole share allows.
      const min = have > 0 ? Math.max(150, 0.01 * total) : 50;
      if (want - have > min) buy(p, s, want - have, b, date, market, log, o.reason);
    }
    p.pending = null;
    p.lastRebalance = date;
    return;
  }

  for (const s of o.sells || []) {
    const b = fillBar(s);
    if (b) sell(p, s, p.positions[s]?.shares || 0, b, date, market, log, o.reasons?.[s] || o.reason);
    else if (!stale) waiting.push(s);
  }
  const buysWaiting = [];
  for (const x of o.buys || []) {
    const b = fillBar(x.symbol);
    if (b) buy(p, x.symbol, Math.min(x.usd, p.cash), b, date, market, log, x.reason || o.reason, x.meta);
    else if (!stale) buysWaiting.push(x);
  }
  p.pending = waiting.length || buysWaiting.length ? { ...o, sells: waiting, buys: buysWaiting } : null;
}

/** Record the day's NAV (once per date). */
export function recordNav(p, date, market) {
  const v = value(p, date, market);
  if (p.nav.at(-1)?.date === date) p.nav[p.nav.length - 1] = { date, value: v, cash: p.cash };
  else p.nav.push({ date, value: v, cash: p.cash });
  return v;
}

/** Add money (contribution strategies). */
export function deposit(p, date, usdAmount) {
  p.cash += usdAmount;
  p.flows.push({ date, usd: usdAmount });
}

/* ---------------------------------------------------------------- metrics */

/**
 * Performance from the NAV series, net of every cost. Time-weighted, so
 * contributions don't count as returns.
 */
export function metrics(p, rf = 0.04) {
  const nav = p.nav;
  if (nav.length < 2) return null;
  const flowsOn = new Map();
  for (const f of p.flows) flowsOn.set(f.date, (flowsOn.get(f.date) || 0) + f.usd);
  const rets = [];
  for (let i = 1; i < nav.length; i++) {
    const flow = flowsOn.get(nav[i].date) || 0;
    const base = nav[i - 1].value;
    if (base > 0) rets.push((nav[i].value - flow) / base - 1);
  }
  const growth = rets.reduce((g, r) => g * (1 + r), 1);
  const days = (Date.parse(nav.at(-1).date) - Date.parse(nav[0].date)) / 86400000;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const vol = sd * Math.sqrt(252);
  let peak = 1;
  let g = 1;
  let maxDd = 0;
  for (const r of rets) {
    g *= 1 + r;
    peak = Math.max(peak, g);
    maxDd = Math.min(maxDd, g / peak - 1);
  }
  const annual = days >= 30 ? Math.pow(growth, 365 / days) - 1 : null;
  const invested = p.flows.reduce((s, f) => s + f.usd, 0);
  const s = p.stats;
  const costs = s.commission + s.stamp + s.spread + s.fx;
  const realised = Object.values(s.realised).reduce((a, b) => a + b, 0);
  return {
    from: nav[0].date,
    to: nav.at(-1).date,
    days,
    value: nav.at(-1).value,
    invested,
    return: growth - 1,
    annual,
    volatility: rets.length >= 20 ? vol : null,
    sharpe: annual != null && vol > 0 && rets.length >= 20 ? (annual - rf) / vol : null,
    maxDrawdown: maxDd,
    trades: s.trades,
    turnover: invested > 0 ? s.turnover / invested : null,
    costs,
    costsPct: invested > 0 ? costs / invested : null,
    dividends: s.dividends,
    withholding: s.withholding,
    realised,
    // Pakistan taxes capital gains at 15% (filers); an estimate, not deducted from NAV.
    taxEstimate: Math.max(0, realised) * 0.15,
    positions: Object.keys(p.positions).length,
    cashShare: nav.at(-1).value > 0 ? p.cash / nav.at(-1).value : null
  };
}

/** Month-end values (the last NAV of each month) for monthly comparisons. */
export function monthEnds(p) {
  const out = new Map();
  for (const x of p.nav) out.set(x.date.slice(0, 7), x);
  return [...out.entries()].map(([month, x]) => ({ month, ...x }));
}
