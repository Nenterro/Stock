/**
 * Portfolio analytics: positions, look-through exposure, concentration, risk,
 * income, costs and contribution planning.
 *
 * Pure functions with no browser or React dependencies, so the app and the
 * MCP server (mcp/) compute the same numbers from the same code. All weights
 * and returns are fractions (0.12 = 12%); money is in the display currency
 * unless a field says `native`.
 */

import { toDayStr, dayStrToMs, buildFxLookup, convertAmount, generatePortfolioTimeSeries } from './portfolio_math.js';

const TRADING_DAYS = 252;

/* -------------------------------------------------------------------------- */
/* Positions                                                                  */
/* -------------------------------------------------------------------------- */

function tickerOf(tx) {
  return String(tx.ticker || tx.asset || '').toUpperCase().trim();
}

function quotePrice(q) {
  if (q == null) return null;
  const p = typeof q === 'object' ? Number(q.price) : Number(q);
  return p > 0 ? p : null;
}

/**
 * Holdings and closed positions from the transaction list, on average-cost
 * basis - the same convention as the Portfolio page, where cost is
 * shares x price at each buy converted at that day's FX rate.
 *
 * @param {Array}  transactions
 * @param {Object} livePrices  { TICKER: { price, currency, changePercent, name } }
 * @param {Object} opts        { displayCurrency, fxRate, fxSeries, assetMeta }
 *                             assetMeta: { TICKER: { name, currency } } fallbacks
 */
export function computePositions(transactions = [], livePrices = {}, opts = {}) {
  const displayCurrency = (opts.displayCurrency || 'USD').toUpperCase();
  const fxRate = opts.fxRate > 0 ? opts.fxRate : 278;
  const fxAt = opts.fxSeries ? buildFxLookup(opts.fxSeries, fxRate) : null;
  const meta = opts.assetMeta || {};

  const sorted = [...transactions]
    .filter((t) => t && toDayStr(t.date))
    .sort((a, b) => dayStrToMs(toDayStr(a.date)) - dayStrToMs(toDayStr(b.date)));

  const map = new Map();
  for (const tx of sorted) {
    const ticker = tickerOf(tx);
    if (!ticker || ticker === 'CASH') continue;
    const type = String(tx.type || '').toLowerCase();
    if (!map.has(ticker)) {
      map.set(ticker, {
        ticker,
        name: tx.assetName || tx.name || meta[ticker]?.name || ticker,
        nativeCurrency: (livePrices[ticker]?.currency || tx.currency || meta[ticker]?.currency || (/\.(KA|PSX)$/.test(ticker) ? 'PKR' : 'USD')).toUpperCase(),
        portfolios: new Set(),
        shares: 0,
        costDisplay: 0,
        costNative: 0,
        realized: 0,
        dividends: 0,
        taxes: 0,
        fees: 0,
        boughtShares: 0,
        soldShares: 0,
        firstBuy: null,
        lastTrade: null,
        lastTradePrice: 0
      });
    }
    const p = map.get(ticker);
    p.portfolios.add(tx.portfolio || 'Default');
    const day = toDayStr(tx.date);
    const rate = fxAt ? fxAt(dayStrToMs(day)) : Number(tx.fxRateOnDate) || fxRate;
    const shares = Number(tx.shares) || Number(tx.quantity) || 0;
    const price = Number(tx.price) || 0;
    const fees = Number(tx.fees) || 0;
    const toDisplay = (amt) => convertAmount(amt, p.nativeCurrency, displayCurrency, rate);

    if (type === 'buy') {
      p.shares += shares;
      p.boughtShares += shares;
      p.costNative += shares * price;
      p.costDisplay += toDisplay(shares * price);
      p.fees += toDisplay(fees);
      if (!p.firstBuy) p.firstBuy = day;
      p.lastTrade = day;
      if (price > 0) p.lastTradePrice = price;
    } else if (type === 'sell') {
      const held = p.shares;
      const frac = held > 0 ? Math.min(1, shares / held) : 0;
      const costOut = p.costDisplay * frac;
      p.costDisplay -= costOut;
      p.costNative -= p.costNative * frac;
      p.shares = Math.max(0, held - shares);
      p.soldShares += shares;
      p.realized += toDisplay(shares * price) - costOut;
      p.fees += toDisplay(fees);
      if (p.shares < 1e-8) {
        p.shares = 0;
        p.costDisplay = 0;
        p.costNative = 0;
      }
      p.lastTrade = day;
      if (price > 0) p.lastTradePrice = price;
    } else if (type === 'dividend') {
      p.dividends += toDisplay(Math.abs(Number(tx.amount) || 0));
    } else if (type === 'tax') {
      p.taxes += toDisplay(Math.abs(Number(tx.amount) || 0));
    }
  }

  const holdings = [];
  const closed = [];
  for (const p of map.values()) {
    const quote = livePrices[p.ticker];
    const priceNative = quotePrice(quote) ?? (p.lastTradePrice || null);
    const priced = quotePrice(quote) != null;
    const priceDisplay = priceNative != null ? convertAmount(priceNative, p.nativeCurrency, displayCurrency, fxRate) : null;
    const base = {
      ticker: p.ticker,
      name: (typeof quote === 'object' && quote?.name) || p.name,
      nativeCurrency: p.nativeCurrency,
      portfolios: [...p.portfolios],
      realized: p.realized,
      dividends: p.dividends,
      taxes: p.taxes,
      fees: p.fees,
      firstBuy: p.firstBuy,
      lastTrade: p.lastTrade
    };
    if (p.shares > 1e-6) {
      const marketValue = priceDisplay != null ? p.shares * priceDisplay : 0;
      holdings.push({
        ...base,
        shares: p.shares,
        avgCost: p.costDisplay / p.shares,
        avgCostNative: p.costNative / p.shares,
        costBasis: p.costDisplay,
        priceNative,
        price: priceDisplay,
        priced,
        marketValue,
        unrealized: marketValue - p.costDisplay,
        unrealizedPct: p.costDisplay > 0 ? marketValue / p.costDisplay - 1 : null,
        totalReturn: marketValue - p.costDisplay + p.realized + p.dividends - p.taxes,
        dayChangePct: typeof quote === 'object' && typeof quote?.changePercent === 'number' ? quote.changePercent / 100 : null
      });
    } else if (p.soldShares > 0 || p.dividends > 0) {
      closed.push({ ...base, totalReturn: p.realized + p.dividends - p.taxes });
    }
  }

  const totalValue = holdings.reduce((a, h) => a + h.marketValue, 0);
  for (const h of holdings) h.weight = totalValue > 0 ? h.marketValue / totalValue : 0;
  holdings.sort((a, b) => b.marketValue - a.marketValue);

  const totalCost = holdings.reduce((a, h) => a + h.costBasis, 0);
  return {
    displayCurrency,
    fxRate,
    holdings,
    closed,
    totals: {
      marketValue: totalValue,
      costBasis: totalCost,
      unrealized: totalValue - totalCost,
      unrealizedPct: totalCost > 0 ? totalValue / totalCost - 1 : null,
      realized: [...map.values()].reduce((a, p) => a + p.realized, 0),
      dividends: [...map.values()].reduce((a, p) => a + p.dividends, 0),
      taxes: [...map.values()].reduce((a, p) => a + p.taxes, 0),
      fees: [...map.values()].reduce((a, p) => a + p.fees, 0),
      positions: holdings.length,
      unpriced: holdings.filter((h) => !h.priced).map((h) => h.ticker)
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Look-through                                                               */
/* -------------------------------------------------------------------------- */

// Share classes and listings of one company, so a direct GOOG and a fund's
// GOOGL count as the same exposure.
const COMPANY_ALIASES = {
  GOOGL: 'GOOG',
  'BRK-A': 'BRK-B',
  'BRK.B': 'BRK-B',
  '005935.KS': '005930.KS',
  '005930.KQ': '005930.KS',
  '000660.KQ': '000660.KS',
  'FB': 'META'
};

export function companyKey(ticker) {
  const t = String(ticker || '').toUpperCase().trim().replace(/\.(KA|PSX)$/, '');
  return COMPANY_ALIASES[t] || t;
}

function addTo(map, key, value, extra) {
  const cur = map.get(key) || { key, value: 0, ...extra };
  cur.value += value;
  map.set(key, cur);
  return cur;
}

function toList(map, total) {
  return [...map.values()]
    .map((r) => ({ ...r, weight: total > 0 ? r.value / total : 0 }))
    .sort((a, b) => b.value - a.value);
}

/**
 * Unpack fund holdings into underlying exposure.
 *
 * @param {Array}  holdings      from computePositions().holdings
 * @param {Object} fundHoldings  { TICKER: /api/holdings payload }
 * @param {Object} fundamentals  { TICKER: /api/fundamentals payload } - sector
 *                               and country of direct holdings
 *
 * Every breakdown keeps an explicit 'Unknown' bucket for the part of a fund
 * no source discloses, rather than spreading it over the known part.
 */
export function computeLookThrough(holdings = [], fundHoldings = {}, fundamentals = {}) {
  const total = holdings.reduce((a, h) => a + (h.marketValue || 0), 0);
  const companies = new Map();
  const sectors = new Map();
  const countries = new Map();
  const assetClass = new Map();
  const funds = [];

  for (const h of holdings) {
    const value = h.marketValue || 0;
    if (!(value > 0)) continue;
    const fund = fundHoldings[h.ticker];
    const f = fundamentals[h.ticker];

    if (!fund && f?.kind === 'etf') {
      // A fund whose composition no source returned: count it as exposure we
      // cannot see into, never as a "company" of its own.
      addTo(companies, `undisclosed:${h.ticker}`, value, {
        name: `${h.ticker}: composition unavailable`,
        tickers: new Set(),
        direct: 0,
        viaFunds: { [h.ticker]: value },
        undisclosed: true
      });
      addTo(sectors, 'Unknown', value);
      addTo(countries, f?.profile?.country || 'Unknown', value);
      addTo(assetClass, 'Fund (composition unknown)', value);
      continue;
    }

    if (!fund) {
      // A direct holding is its own look-through.
      const key = companyKey(h.ticker);
      const c = addTo(companies, key, value, { name: f?.name || h.name, tickers: new Set(), direct: 0, viaFunds: {} });
      c.tickers.add(h.ticker);
      c.direct += value;
      const sector = f?.profile?.sector || (f?.kind === 'etf' ? 'Unknown' : null) || 'Unknown';
      addTo(sectors, sector, value);
      addTo(countries, f?.profile?.country || 'Unknown', value);
      addTo(assetClass, f?.kind === 'etf' ? 'Fund (composition unknown)' : 'Stock', value);
      continue;
    }

    const listed = (fund.holdings || []).filter((x) => x.weight > 0);
    const coverage = listed.reduce((a, x) => a + x.weight, 0);
    funds.push({
      ticker: h.ticker,
      name: fund.name || h.name,
      value,
      coverage,
      // Total holdings in the fund when a source states it; `listed` is how
      // many of them are actually itemised.
      holdingsCount: fund.holdingsCount ?? null,
      listed: listed.length,
      sectorBasis: fund.sectorBasis,
      countryBasis: fund.countryBasis,
      expenseRatio: fund.expenseRatio ?? null,
      asOf: fund.asOf || null,
      override: Boolean(fund.override)
    });

    for (const x of listed) {
      const key = x.ticker ? companyKey(x.ticker) : `name:${String(x.name).toLowerCase()}`;
      const c = addTo(companies, key, value * x.weight, { name: x.name, tickers: new Set(), direct: 0, viaFunds: {} });
      if (x.ticker) c.tickers.add(x.ticker);
      c.viaFunds[h.ticker] = (c.viaFunds[h.ticker] || 0) + value * x.weight;
    }
    if (coverage < 0.995) {
      const c = addTo(companies, `undisclosed:${h.ticker}`, value * (1 - coverage), {
        name: `${h.ticker}: undisclosed holdings`,
        tickers: new Set(),
        direct: 0,
        viaFunds: { [h.ticker]: value * (1 - coverage) },
        undisclosed: true
      });
      c.undisclosed = true;
    }

    const sectorRows = fund.sectors?.length ? fund.sectors : [{ sector: 'Unknown', weight: 1 }];
    const sectorSum = sectorRows.reduce((a, s) => a + (s.weight || 0), 0);
    for (const s of sectorRows) addTo(sectors, s.sector || 'Unknown', value * (s.weight || 0));
    if (sectorSum < 0.995) addTo(sectors, 'Unknown', value * (1 - sectorSum));

    const countryRows = fund.countries?.length ? fund.countries : [{ country: 'Unknown', weight: 1 }];
    const countrySum = countryRows.reduce((a, s) => a + (s.weight || 0), 0);
    for (const c of countryRows) addTo(countries, c.country || 'Unknown', value * (c.weight || 0));
    if (countrySum < 0.995) addTo(countries, 'Unknown', value * (1 - countrySum));

    const mix = fund.assetMix || {};
    const known = ['stock', 'bond', 'cash', 'other'].reduce((a, k) => a + (Number(mix[k]) || 0), 0);
    if (known > 0.5) {
      addTo(assetClass, 'Stock', value * (Number(mix.stock) || 0));
      addTo(assetClass, 'Bond', value * (Number(mix.bond) || 0));
      addTo(assetClass, 'Cash', value * (Number(mix.cash) || 0));
      addTo(assetClass, 'Other', value * ((Number(mix.other) || 0) + Math.max(0, 1 - known)));
    } else {
      addTo(assetClass, 'Stock', value);
    }
  }

  const companyList = toList(companies, total).map((c) => ({
    key: c.key,
    name: c.name,
    tickers: [...c.tickers],
    value: c.value,
    weight: c.weight,
    direct: c.direct,
    indirect: c.value - c.direct,
    viaFunds: c.viaFunds,
    undisclosed: Boolean(c.undisclosed),
    overlap: c.direct > 0 && c.value - c.direct > 0
  }));

  const known = companyList.filter((c) => !c.undisclosed);
  return {
    total,
    companies: companyList,
    // The biggest real exposures - what a fund's undisclosed tail hides is
    // not a single company and must not rank as one.
    topCompanies: known.slice(0, 25),
    overlaps: known.filter((c) => c.overlap),
    sectors: toList(sectors, total).filter((s) => s.value > 0.0001),
    countries: toList(countries, total).filter((s) => s.value > 0.0001),
    assetClasses: toList(assetClass, total).filter((s) => s.value > 0.0001),
    funds,
    disclosedShare: total > 0 ? known.reduce((a, c) => a + c.value, 0) / total : 0
  };
}

/** Exposure by listing currency and by home market, from direct holdings. */
export function currencyExposure(holdings = []) {
  const total = holdings.reduce((a, h) => a + (h.marketValue || 0), 0);
  const byCurrency = new Map();
  for (const h of holdings) addTo(byCurrency, h.nativeCurrency || 'Unknown', h.marketValue || 0);
  return toList(byCurrency, total);
}

/* -------------------------------------------------------------------------- */
/* Concentration                                                              */
/* -------------------------------------------------------------------------- */

/** Top-N shares and Herfindahl index over a list of weights (fractions). */
export function concentration(weights = []) {
  const w = weights.filter((x) => x > 0).sort((a, b) => b - a);
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  const norm = w.map((x) => x / sum);
  const hhi = norm.reduce((a, x) => a + x * x, 0);
  const top = (n) => norm.slice(0, n).reduce((a, b) => a + b, 0);
  return {
    count: norm.length,
    top1: top(1),
    top3: top(3),
    top5: top(5),
    top10: top(10),
    hhi,
    // "As diversified as N equal-weight positions".
    effectiveN: hhi > 0 ? 1 / hhi : 0
  };
}

/* -------------------------------------------------------------------------- */
/* Risk and benchmark comparison                                              */
/* -------------------------------------------------------------------------- */

function mean(a) {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

function maxDrawdownOf(levels) {
  let peak = -Infinity;
  let worst = 0;
  let peakDate = null;
  let troughDate = null;
  let curPeakDate = null;
  for (const { date, level } of levels) {
    if (level > peak) {
      peak = level;
      curPeakDate = date;
    }
    const dd = peak > 0 ? level / peak - 1 : 0;
    if (dd < worst) {
      worst = dd;
      peakDate = curPeakDate;
      troughDate = date;
    }
  }
  return { maxDrawdown: worst, peakDate, troughDate };
}

/**
 * Risk statistics from the daily series generatePortfolioTimeSeries produces.
 * Uses the time-weighted growth factor, so deposits are not mistaken for gains.
 * Weekend points (no price change) are dropped before computing volatility.
 *
 * @param {Array}  series        [{ date, twrFactor, value }]
 * @param {Object} opts          { riskFreeRate: annual fraction, sinceDate }
 */
export function riskMetrics(series = [], opts = {}) {
  const rf = Number(opts.riskFreeRate) || 0;
  const pts = series.filter((p) => p.twrFactor > 0 && (!opts.sinceDate || p.date >= opts.sinceDate));
  if (pts.length < 20) return null;

  const rets = [];
  for (let i = 1; i < pts.length; i++) {
    const r = pts[i].twrFactor / pts[i - 1].twrFactor - 1;
    const weekday = new Date(`${pts[i].date}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    if (Number.isFinite(r)) rets.push({ date: pts[i].date, r });
  }
  if (rets.length < 15) return null;

  const years = (dayStrToMs(pts[pts.length - 1].date) - dayStrToMs(pts[0].date)) / (365 * 86400000);
  const growth = pts[pts.length - 1].twrFactor / pts[0].twrFactor;
  const cagr = years > 0.08 ? Math.pow(growth, 1 / years) - 1 : null;
  const daily = rets.map((x) => x.r);
  const vol = stdev(daily) * Math.sqrt(TRADING_DAYS);
  const downside = stdev(daily.filter((r) => r < 0)) * Math.sqrt(TRADING_DAYS);
  const dd = maxDrawdownOf(pts.map((p) => ({ date: p.date, level: p.twrFactor })));
  const sorted = [...rets].sort((a, b) => a.r - b.r);

  return {
    from: pts[0].date,
    to: pts[pts.length - 1].date,
    years,
    totalReturn: growth - 1,
    cagr,
    volatility: vol,
    sharpe: cagr != null && vol > 0 ? (cagr - rf) / vol : null,
    sortino: cagr != null && downside > 0 ? (cagr - rf) / downside : null,
    ...dd,
    bestDay: sorted[sorted.length - 1],
    worstDay: sorted[0],
    positiveDays: daily.filter((r) => r > 0).length / daily.length,
    riskFreeRate: rf,
    dailyReturns: rets
  };
}

/**
 * Convert a benchmark's native price history into the display currency at the
 * historical FX rate, so a PKR index can be compared with a USD portfolio.
 */
export function benchmarkInCurrency(history = [], nativeCurrency, displayCurrency, fxSeries, fallbackRate = 278) {
  const fxAt = buildFxLookup(fxSeries, fallbackRate);
  return history
    .map((p) => {
      const day = toDayStr(p.date);
      const rate = fxAt(dayStrToMs(day));
      // Adjusted close where available: a split or dividend is not a loss.
      const px = Number(p.adjClose) > 0 ? Number(p.adjClose) : Number(p.price);
      return { date: day, price: convertAmount(px, nativeCurrency, displayCurrency, rate) };
    })
    .filter((p) => p.price > 0);
}

/**
 * Portfolio vs benchmark over the window both cover: returns, beta,
 * correlation, alpha (annualised, CAPM) and tracking error.
 */
export function compareToBenchmark(risk, benchHistory = [], opts = {}) {
  if (!risk?.dailyReturns?.length || benchHistory.length < 20) return null;
  const rf = Number(opts.riskFreeRate) || 0;
  const bench = benchHistory.filter((p) => p.date >= risk.from && p.date <= risk.to);
  if (bench.length < 20) return null;

  const bRet = new Map();
  for (let i = 1; i < bench.length; i++) bRet.set(bench[i].date, bench[i].price / bench[i - 1].price - 1);

  const xs = [];
  const ys = [];
  for (const { date, r } of risk.dailyReturns) {
    if (bRet.has(date)) {
      xs.push(bRet.get(date));
      ys.push(r);
    }
  }
  if (xs.length < 15) return null;

  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < xs.length; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
    vy += (ys[i] - my) ** 2;
  }
  const beta = vx > 0 ? cov / vx : null;
  const correlation = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : null;
  const diffs = ys.map((y, i) => y - xs[i]);

  const benchGrowth = bench[bench.length - 1].price / bench[0].price;
  const years = risk.years;
  const benchCagr = years > 0.08 ? Math.pow(benchGrowth, 1 / years) - 1 : null;
  const benchVol = stdev(xs) * Math.sqrt(TRADING_DAYS);
  const alpha = risk.cagr != null && benchCagr != null && beta != null ? risk.cagr - (rf + beta * (benchCagr - rf)) : null;

  return {
    benchmark: opts.name || null,
    from: bench[0].date,
    to: bench[bench.length - 1].date,
    benchmarkReturn: benchGrowth - 1,
    benchmarkCagr: benchCagr,
    benchmarkVolatility: benchVol,
    benchmarkMaxDrawdown: maxDrawdownOf(bench.map((p) => ({ date: p.date, level: p.price }))).maxDrawdown,
    portfolioReturn: risk.totalReturn,
    excessReturn: risk.totalReturn - (benchGrowth - 1),
    beta,
    correlation,
    alpha,
    trackingError: stdev(diffs) * Math.sqrt(TRADING_DAYS),
    observations: xs.length
  };
}

/**
 * Pairwise correlation of daily returns over the trailing window.
 * History is { TICKER: { history: [{date, price}] } } as the backend returns.
 */
export function correlationMatrix(historicalPrices = {}, tickers = [], days = 365) {
  const series = {};
  let latest = '';
  for (const t of tickers) {
    const h = historicalPrices[t]?.history || (Array.isArray(historicalPrices[t]) ? historicalPrices[t] : null);
    if (!h?.length) continue;
    series[t] = h;
    const d = toDayStr(h[h.length - 1].date);
    if (d > latest) latest = d;
  }
  const since = new Date(dayStrToMs(latest) - days * 86400000).toISOString().slice(0, 10);
  const rets = {};
  for (const [t, h] of Object.entries(series)) {
    const m = new Map();
    const pts = h.filter((p) => toDayStr(p.date) >= since);
    const px = (p) => (Number(p.adjClose) > 0 ? Number(p.adjClose) : Number(p.price));
    for (let i = 1; i < pts.length; i++) {
      if (px(pts[i - 1]) > 0) m.set(toDayStr(pts[i].date), px(pts[i]) / px(pts[i - 1]) - 1);
    }
    rets[t] = m;
  }

  const names = Object.keys(rets);
  const matrix = names.map((a) =>
    names.map((b) => {
      if (a === b) return 1;
      const xs = [];
      const ys = [];
      for (const [d, r] of rets[a]) {
        // US and PSX sessions do not align day for day; only shared dates count.
        if (rets[b].has(d)) {
          xs.push(r);
          ys.push(rets[b].get(d));
        }
      }
      if (xs.length < 30) return null;
      const mx = mean(xs);
      const my = mean(ys);
      let c = 0;
      let vx = 0;
      let vy = 0;
      for (let i = 0; i < xs.length; i++) {
        c += (xs[i] - mx) * (ys[i] - my);
        vx += (xs[i] - mx) ** 2;
        vy += (ys[i] - my) ** 2;
      }
      return vx > 0 && vy > 0 ? c / Math.sqrt(vx * vy) : null;
    })
  );

  const pairs = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (matrix[i][j] != null) pairs.push({ a: names[i], b: names[j], correlation: matrix[i][j] });
    }
  }
  pairs.sort((x, y) => y.correlation - x.correlation);
  return { tickers: names, matrix, mostCorrelated: pairs.slice(0, 5), leastCorrelated: pairs.slice(-5).reverse(), since };
}

/* -------------------------------------------------------------------------- */
/* Income and costs                                                           */
/* -------------------------------------------------------------------------- */

/** Dividend income by year and by ticker, trailing 12 months and yield on cost. */
export function incomeSummary(transactions = [], positions = null, opts = {}) {
  const displayCurrency = (opts.displayCurrency || positions?.displayCurrency || 'USD').toUpperCase();
  const fxRate = opts.fxRate || positions?.fxRate || 278;
  const fxAt = opts.fxSeries ? buildFxLookup(opts.fxSeries, fxRate) : null;
  const currencyOf = {};
  for (const h of positions?.holdings || []) currencyOf[h.ticker] = h.nativeCurrency;
  for (const h of positions?.closed || []) currencyOf[h.ticker] = h.nativeCurrency;

  const today = opts.today || new Date().toISOString().slice(0, 10);
  const yearAgo = new Date(dayStrToMs(today) - 365 * 86400000).toISOString().slice(0, 10);
  const byYear = {};
  const byTicker = {};
  let ttm = 0;
  let taxTtm = 0;

  for (const tx of transactions) {
    const type = String(tx.type || '').toLowerCase();
    if (type !== 'dividend' && type !== 'tax') continue;
    const day = toDayStr(tx.date);
    if (!day) continue;
    const ticker = tickerOf(tx);
    const native = (currencyOf[ticker] || tx.currency || 'USD').toUpperCase();
    const rate = fxAt ? fxAt(dayStrToMs(day)) : Number(tx.fxRateOnDate) || fxRate;
    const amt = convertAmount(Math.abs(Number(tx.amount) || 0), native, displayCurrency, rate);
    const sign = type === 'dividend' ? 1 : -1;
    const y = day.slice(0, 4);
    byYear[y] = byYear[y] || { year: y, gross: 0, tax: 0 };
    byTicker[ticker] = byTicker[ticker] || { ticker, gross: 0, tax: 0, payments: 0, last: null };
    if (sign > 0) {
      byYear[y].gross += amt;
      byTicker[ticker].gross += amt;
      byTicker[ticker].payments += 1;
      if (!byTicker[ticker].last || day > byTicker[ticker].last) byTicker[ticker].last = day;
      if (day >= yearAgo) ttm += amt;
    } else {
      byYear[y].tax += amt;
      byTicker[ticker].tax += amt;
      if (day >= yearAgo) taxTtm += amt;
    }
  }

  const cost = (positions?.holdings || []).reduce((a, h) => a + h.costBasis, 0);
  const value = (positions?.holdings || []).reduce((a, h) => a + h.marketValue, 0);
  return {
    displayCurrency,
    trailing12m: { gross: ttm, tax: taxTtm, net: ttm - taxTtm },
    yieldOnCost: cost > 0 ? (ttm - taxTtm) / cost : null,
    currentYield: value > 0 ? (ttm - taxTtm) / value : null,
    byYear: Object.values(byYear).sort((a, b) => a.year.localeCompare(b.year)),
    byTicker: Object.values(byTicker).sort((a, b) => b.gross - a.gross)
  };
}

/** What the funds' expense ratios cost per year, in money and as a drag. */
export function feeDrag(holdings = [], expenseRatios = {}) {
  const total = holdings.reduce((a, h) => a + (h.marketValue || 0), 0);
  const rows = holdings
    .filter((h) => typeof expenseRatios[h.ticker] === 'number')
    .map((h) => ({ ticker: h.ticker, expenseRatio: expenseRatios[h.ticker], value: h.marketValue, annualCost: h.marketValue * expenseRatios[h.ticker] }));
  const annualCost = rows.reduce((a, r) => a + r.annualCost, 0);
  return { rows, annualCost, portfolioDrag: total > 0 ? annualCost / total : 0 };
}

/* -------------------------------------------------------------------------- */
/* Contribution planner                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Where new money should go to move toward target weights, without selling.
 *
 * Targets are fractions by ticker; tickers not yet held may be included (pass
 * their price in `prices`). Money goes to the positions furthest below target
 * in proportion to their shortfall. With `wholeShares`, purchases are rounded
 * down to whole shares and leftover cash is reported.
 *
 * @param {Array}  holdings   from computePositions().holdings
 * @param {Object} targets    { TICKER: 0.25, ... }  (normalised if not summing to 1)
 * @param {number} amount     new money in the display currency
 * @param {Object} opts       { prices: { TICKER: displayPrice }, wholeShares, minTrade }
 */
export function planContribution(holdings = [], targets = {}, amount = 0, opts = {}) {
  const prices = { ...(opts.prices || {}) };
  for (const h of holdings) if (h.price > 0 && prices[h.ticker] == null) prices[h.ticker] = h.price;
  const tSum = Object.values(targets).reduce((a, b) => a + (Number(b) || 0), 0);
  if (!(tSum > 0) || !(amount > 0)) return { buys: [], leftover: amount, before: [], after: [], warnings: ['Set targets and an amount first.'] };
  const target = Object.fromEntries(Object.entries(targets).map(([k, v]) => [k.toUpperCase(), (Number(v) || 0) / tSum]));

  const value = Object.fromEntries(holdings.map((h) => [h.ticker, h.marketValue || 0]));
  const current = holdings.reduce((a, h) => a + (h.marketValue || 0), 0);
  const after = current + amount;
  const untargeted = holdings.filter((h) => !(h.ticker in target)).reduce((a, h) => a + h.marketValue, 0);

  // Untargeted positions keep their value; targets apply to the rest.
  const investable = after - untargeted;
  const gaps = Object.entries(target).map(([t, w]) => ({ ticker: t, gap: Math.max(0, investable * w - (value[t] || 0)) }));
  const gapSum = gaps.reduce((a, g) => a + g.gap, 0);
  const warnings = [];
  if (untargeted > 0) warnings.push(`${holdings.filter((h) => !(h.ticker in target)).map((h) => h.ticker).join(', ')} have no target and are left as they are.`);

  let buys = gaps
    .filter((g) => g.gap > 0)
    .map((g) => ({ ticker: g.ticker, amount: gapSum > 0 ? (amount * g.gap) / gapSum : 0 }));
  // If everything is at or over target, spread pro rata to targets.
  if (buys.length === 0) buys = Object.entries(target).map(([t, w]) => ({ ticker: t, amount: amount * w }));

  const minTrade = Number(opts.minTrade) || 0;
  if (minTrade > 0) {
    const small = buys.filter((b) => b.amount < minTrade);
    if (small.length && small.length < buys.length) {
      const freed = small.reduce((a, b) => a + b.amount, 0);
      buys = buys.filter((b) => b.amount >= minTrade);
      const s = buys.reduce((a, b) => a + b.amount, 0);
      buys = buys.map((b) => ({ ...b, amount: b.amount + (freed * b.amount) / s }));
      warnings.push(`Skipped buys under the ${minTrade} minimum: ${small.map((b) => b.ticker).join(', ')}.`);
    }
  }

  let spent = 0;
  buys = buys.map((b) => {
    const price = prices[b.ticker];
    if (!(price > 0)) {
      warnings.push(`No price for ${b.ticker}; amount shown without a share count.`);
      spent += b.amount;
      return { ...b, price: null, shares: null };
    }
    const shares = opts.wholeShares ? Math.floor(b.amount / price) : b.amount / price;
    const cost = shares * price;
    spent += cost;
    return { ...b, price, shares, amount: cost };
  });
  buys = buys.filter((b) => b.amount > 0 || b.shares == null);

  const newValue = { ...value };
  for (const b of buys) newValue[b.ticker] = (newValue[b.ticker] || 0) + b.amount;
  const newTotal = Object.values(newValue).reduce((a, b) => a + b, 0);
  const tickers = [...new Set([...Object.keys(value), ...Object.keys(target)])];
  const row = (t, v, tot) => ({ ticker: t, value: v[t] || 0, weight: tot > 0 ? (v[t] || 0) / tot : 0, target: target[t] ?? null });

  return {
    amount,
    buys: buys.sort((a, b) => b.amount - a.amount),
    leftover: amount - spent,
    before: tickers.map((t) => row(t, value, current)),
    after: tickers.map((t) => row(t, newValue, newTotal)),
    warnings
  };
}

/* -------------------------------------------------------------------------- */
/* The full X-ray                                                             */
/* -------------------------------------------------------------------------- */

export const BENCHMARKS = [
  { symbol: 'KSE100', name: 'KSE-100', currency: 'PKR' },
  { symbol: 'KMI30', name: 'KMI-30 (Shariah)', currency: 'PKR' },
  { symbol: '^GSPC', name: 'S&P 500', currency: 'USD' }
];

/**
 * Everything the Analytics page shows and Claude reasons about, from raw
 * inputs. Callers fetch; this only computes, so both stay in step.
 *
 * @param {Object} input
 *   transactions, livePrices, historicalPrices, fxSeries, fxRate,
 *   displayCurrency, fundHoldings, fundamentals,
 *   benchmarkHistory: { SYMBOL: [{date, price}] } in native currency,
 *   riskFreeRate (annual fraction, optional), series (optional, precomputed)
 */
export function buildXray(input) {
  const displayCurrency = (input.displayCurrency || 'USD').toUpperCase();
  const fxRate = input.fxRate > 0 ? input.fxRate : 278;
  const warnings = [];

  const positions = computePositions(input.transactions, input.livePrices, {
    displayCurrency,
    fxRate,
    fxSeries: input.fxSeries
  });
  if (positions.totals.unpriced.length) {
    warnings.push(`No live price for ${positions.totals.unpriced.join(', ')}; valued at the last trade price.`);
  }

  const lookThrough = computeLookThrough(positions.holdings, input.fundHoldings || {}, input.fundamentals || {});
  if (lookThrough.disclosedShare < 0.9) {
    warnings.push(
      `${((1 - lookThrough.disclosedShare) * 100).toFixed(0)}% of the portfolio sits in fund holdings no source discloses; company-level exposure is a lower bound.`
    );
  }

  const series =
    input.series ||
    generatePortfolioTimeSeries(input.transactions, input.livePrices, input.historicalPrices, displayCurrency, fxRate, input.fxSeries);

  const rf = typeof input.riskFreeRate === 'number' ? input.riskFreeRate : 0;
  if (typeof input.riskFreeRate !== 'number') warnings.push('Risk-free rate not set; Sharpe and alpha use 0%.');

  const today = series.length ? series[series.length - 1].date : new Date().toISOString().slice(0, 10);
  const oneYearAgo = new Date(dayStrToMs(today) - 365 * 86400000).toISOString().slice(0, 10);
  const riskAll = riskMetrics(series, { riskFreeRate: rf });
  const risk1y = riskMetrics(series, { riskFreeRate: rf, sinceDate: oneYearAgo });

  const benchmarks = [];
  for (const b of BENCHMARKS) {
    const hist = input.benchmarkHistory?.[b.symbol];
    if (!hist?.length) continue;
    const inCcy = benchmarkInCurrency(hist, b.currency, displayCurrency, input.fxSeries, fxRate);
    const all = compareToBenchmark(riskAll, inCcy, { riskFreeRate: rf, name: b.name });
    const y1 = compareToBenchmark(risk1y, inCcy, { riskFreeRate: rf, name: b.name });
    if (all || y1) benchmarks.push({ symbol: b.symbol, name: b.name, sinceInception: all, oneYear: y1 });
  }

  const expenseRatios = {};
  for (const [t, f] of Object.entries(input.fundHoldings || {})) if (typeof f.expenseRatio === 'number') expenseRatios[t] = f.expenseRatio;
  for (const [t, f] of Object.entries(input.fundamentals || {})) {
    if (expenseRatios[t] == null && typeof f?.fund?.expenseRatio === 'number') expenseRatios[t] = f.fund.expenseRatio;
  }

  const strip = (r) => (r ? (({ dailyReturns, ...rest }) => rest)(r) : null);

  return {
    asOf: today,
    displayCurrency,
    fxRate,
    positions,
    lookThrough,
    concentration: {
      positions: concentration(positions.holdings.map((h) => h.weight)),
      companies: concentration(lookThrough.companies.filter((c) => !c.undisclosed).map((c) => c.weight)),
      sectors: concentration(lookThrough.sectors.filter((s) => s.key !== 'Unknown').map((s) => s.weight)),
      countries: concentration(lookThrough.countries.filter((s) => s.key !== 'Unknown').map((s) => s.weight))
    },
    currencyExposure: currencyExposure(positions.holdings),
    risk: { sinceInception: strip(riskAll), oneYear: strip(risk1y) },
    benchmarks,
    correlations: correlationMatrix(input.historicalPrices || {}, positions.holdings.map((h) => h.ticker)),
    income: incomeSummary(input.transactions, positions, { displayCurrency, fxRate, fxSeries: input.fxSeries }),
    fees: feeDrag(positions.holdings, expenseRatios),
    shariah: shariahSummary(positions.holdings, input.fundamentals || {}, input.fundHoldings || {}),
    warnings
  };
}

/** Share of the portfolio in holdings flagged Shariah-compliant by a source. */
export function shariahSummary(holdings = [], fundamentals = {}, fundHoldings = {}) {
  const total = holdings.reduce((a, h) => a + (h.marketValue || 0), 0);
  const rows = holdings.map((h) => {
    const f = fundamentals[h.ticker];
    const flag = f?.profile?.isShariah ?? (/islamic|shariah|sharia/i.test(fundHoldings[h.ticker]?.name || h.name || '') ? true : null);
    return { ticker: h.ticker, value: h.marketValue, isShariah: flag };
  });
  const sum = (pred) => rows.filter(pred).reduce((a, r) => a + r.value, 0) / (total || 1);
  return {
    compliant: sum((r) => r.isShariah === true),
    nonCompliant: sum((r) => r.isShariah === false),
    unknown: sum((r) => r.isShariah == null),
    rows
  };
}
