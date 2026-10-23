/**
 * Portfolio Math Utilities
 *
 * Models a pure stock portfolio (no cash account): every BUY/TAX is new money
 * entering, every SELL/DIVIDEND is money leaving, and portfolio value is the
 * market value of the shares held.
 *
 * Everything is keyed on 'YYYY-MM-DD' calendar day strings and compared through
 * UTC-midnight timestamps, so the results do not shift with the viewer's
 * timezone.
 */

const MS_PER_DAY = 86400000;
const DAYS_PER_YEAR = 365;

/* -------------------------------------------------------------------------- */
/* Date helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Extract the calendar day ('YYYY-MM-DD') from an ISO string or Date. */
export function toDayStr(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const str = String(value);
  // Already a plain date, or an ISO timestamp we want the date part of.
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? null : toDayStr(parsed);
}

/** UTC-midnight epoch ms for a 'YYYY-MM-DD' string. Timezone independent. */
export function dayStrToMs(dayStr) {
  if (!dayStr) return NaN;
  const [y, m, d] = dayStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function msToDayStr(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function todayDayStr() {
  return toDayStr(new Date());
}

/* -------------------------------------------------------------------------- */
/* XIRR / Money-Weighted Return                                               */
/* -------------------------------------------------------------------------- */

/**
 * Solve for the money-weighted return of a set of dated cash flows.
 *
 * Rather than solving for an annualised rate `r` (which explodes to absurd
 * magnitudes over short horizons and has to be clamped, producing the spikes
 * this chart used to show), we solve directly for `u`, the growth factor over
 * the *whole* period:
 *
 *     NPV(u) = SUM_i  amount_i * u^(-w_i) = 0,   w_i = (t_i - t_0) / (t_n - t_0)
 *
 * `w_i` is each flow's position in [0, 1] across the period, so `u` stays a
 * small, well-conditioned number. The cumulative return is exactly `u - 1`, and
 * the annualised rate is recovered as `u^(1/years) - 1`.
 *
 * Sign convention: amount > 0 is money entering the portfolio (buys, taxes),
 * amount < 0 is money leaving it (sells, dividends, and the terminal value).
 *
 * @param {{amount:number, date:Date|string}[]} cashFlows
 * @param {number|null} warmStart previous solution, used as the initial guess
 * @returns {{annualized:number, cumulative:number, growth:number}}
 */
export function calculateXIRR(cashFlows, warmStart = null) {
  const empty = { annualized: 0, cumulative: 0, growth: 1 };
  if (!cashFlows || cashFlows.length < 2) return empty;

  // Normalise to (weight, amount) pairs.
  const flows = cashFlows
    .map(cf => {
      const ms = cf.date instanceof Date ? cf.date.getTime() : dayStrToMs(toDayStr(cf.date));
      return { ms, amount: Number(cf.amount) || 0 };
    })
    .filter(f => Number.isFinite(f.ms) && f.amount !== 0)
    .sort((a, b) => a.ms - b.ms);

  if (flows.length < 2) return empty;

  const hasPositive = flows.some(f => f.amount > 0);
  const hasNegative = flows.some(f => f.amount < 0);
  if (!hasPositive || !hasNegative) return empty;

  const startMs = flows[0].ms;
  const endMs = flows[flows.length - 1].ms;
  const spanMs = endMs - startMs;

  // All flows on the same day: no time value, fall back to a simple ratio.
  if (spanMs <= 0) {
    let inflow = 0;
    let outflow = 0;
    flows.forEach(f => (f.amount > 0 ? (inflow += f.amount) : (outflow -= f.amount)));
    if (inflow <= 0) return empty;
    const growth = outflow / inflow;
    return { annualized: (growth - 1) * 100, cumulative: (growth - 1) * 100, growth };
  }

  const totalYears = spanMs / MS_PER_DAY / DAYS_PER_YEAR;
  const weights = flows.map(f => (f.ms - startMs) / spanMs);
  const amounts = flows.map(f => f.amount);
  const n = flows.length;

  const npv = (u) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += amounts[i] * Math.pow(u, -weights[i]);
    return sum;
  };

  const dNpv = (u) => {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      if (weights[i] === 0) continue;
      sum += -weights[i] * amounts[i] * Math.pow(u, -weights[i] - 1);
    }
    return sum;
  };

  const U_MIN = 1e-6;
  const U_MAX = 1e6;

  // 1. Safeguarded Newton from the warm start (previous day's answer). With a
  //    good seed this converges in two or three iterations.
  let u = warmStart && warmStart > U_MIN && warmStart < U_MAX ? warmStart : 1.1;
  let solved = false;
  for (let i = 0; i < 40; i++) {
    const y = npv(u);
    if (Math.abs(y) < 1e-9) {
      solved = true;
      break;
    }
    const dy = dNpv(u);
    if (!Number.isFinite(dy) || Math.abs(dy) < 1e-14) break;
    let next = u - y / dy;
    if (!Number.isFinite(next)) break;
    // Keep the iterate positive and inside the bracket.
    if (next <= U_MIN) next = (u + U_MIN) / 2;
    if (next >= U_MAX) next = (u + U_MAX) / 2;
    const converged = Math.abs(next - u) < 1e-12 * Math.max(1, u);
    u = next;
    if (converged) {
      solved = true;
      break;
    }
  }

  // 2. Bisection fallback. NPV(u) runs from -inf (u -> 0) to the sum of the
  //    t=0 flows (u -> inf), so a sign change is guaranteed to exist.
  if (!solved || !Number.isFinite(u)) {
    let lo = U_MIN;
    let hi = U_MAX;
    const fLo = npv(lo);
    const fHi = npv(hi);
    if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return empty;
    for (let i = 0; i < 200; i++) {
      const mid = Math.sqrt(lo * hi); // geometric midpoint - u spans orders of magnitude
      const fMid = npv(mid);
      if (!Number.isFinite(fMid)) break;
      if (fLo * fMid <= 0) hi = mid;
      else lo = mid;
      if (hi / lo < 1 + 1e-12) break;
    }
    u = Math.sqrt(lo * hi);
  }

  if (!Number.isFinite(u) || u <= 0) return empty;

  const cumulative = (u - 1) * 100;
  const annualized = totalYears > 0.003 ? (Math.pow(u, 1 / totalYears) - 1) * 100 : cumulative;

  return { annualized, cumulative, growth: u };
}

/* -------------------------------------------------------------------------- */
/* Currency helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build a USD->PKR rate lookup that carries the last known rate forward across
 * weekends and holidays, and backfills before the series starts.
 */
export function buildFxLookup(fxSeries, fallbackRate = 278.0) {
  const entries = Object.entries(fxSeries || {})
    .map(([dayStr, rate]) => ({ ms: dayStrToMs(dayStr), rate: Number(rate) }))
    .filter(e => Number.isFinite(e.ms) && e.rate > 0)
    .sort((a, b) => a.ms - b.ms);

  if (entries.length === 0) return () => fallbackRate;

  let cursor = 0;
  let lastQueryMs = -Infinity;

  return (ms) => {
    // Callers walk forward in time; reset the cursor if they don't.
    if (ms < lastQueryMs) cursor = 0;
    lastQueryMs = ms;
    while (cursor + 1 < entries.length && entries[cursor + 1].ms <= ms) cursor++;
    if (ms < entries[0].ms) return entries[0].rate;
    return entries[cursor].rate;
  };
}

/** Convert between USD and PKR at a given USD->PKR rate. */
export function convertAmount(amount, fromCurrency, toCurrency, usdToPkr) {
  const from = (fromCurrency || 'USD').toUpperCase();
  const to = (toCurrency || 'USD').toUpperCase();
  if (from === to) return amount;
  const rate = usdToPkr > 0 ? usdToPkr : 278.0;
  if (from === 'PKR' && to === 'USD') return amount / rate;
  if (from === 'USD' && to === 'PKR') return amount * rate;
  return amount;
}

/* -------------------------------------------------------------------------- */
/* Transaction normalisation                                                  */
/* -------------------------------------------------------------------------- */

const TRADE_TYPES = ['buy', 'sell', 'dividend', 'tax'];

function tickerOf(tx) {
  return (tx.ticker || tx.asset || '').toUpperCase().trim();
}

/**
 * Reduce a raw transaction to the fields the maths needs, in the asset's own
 * (native) currency. `amount` is always the positive magnitude - direction is
 * carried by `type`.
 */
function normalizeTransaction(tx, fallbackFxRate) {
  const type = (tx.type || '').toLowerCase();
  if (!TRADE_TYPES.includes(type)) return null;

  const dayStr = toDayStr(tx.date);
  if (!dayStr) return null;

  const shares = Number(tx.shares) || Number(tx.quantity) || 0;
  const price = Number(tx.price) || 0;
  const fees = Number(tx.fees) || 0;

  let amountNative;
  if (type === 'buy') amountNative = shares * price + fees;
  else if (type === 'sell') amountNative = shares * price - fees;
  // DIVIDEND is stored positive and TAX negative by the entry form; both are
  // magnitudes here, the direction comes from the type.
  else amountNative = Math.abs(Number(tx.amount) || 0);

  return {
    type,
    dayStr,
    ms: dayStrToMs(dayStr),
    ticker: tickerOf(tx),
    shares,
    priceNative: price,
    feesNative: fees,
    amountNative,
    currency: (tx.currency || '').toUpperCase() || null,
    // Rate captured when the transaction was entered; used when we have no
    // historical FX series to consult.
    fxRateOnDate: Number(tx.fxRateOnDate) || fallbackFxRate
  };
}

/**
 * Work out each ticker's native trading currency from the best source
 * available, falling back to the PSX/PKR naming heuristic only as a last
 * resort.
 */
function resolveCurrencies(normalized, livePrices, historicalPrices) {
  const currencies = {};
  normalized.forEach(tx => {
    if (!tx.ticker || currencies[tx.ticker]) return;
    const hist = historicalPrices?.[tx.ticker];
    const live = livePrices?.[tx.ticker];
    currencies[tx.ticker] =
      (hist && !Array.isArray(hist) && hist.currency) ||
      (live && live.currency) ||
      tx.currency ||
      (/\.(KA|PSX)$/.test(tx.ticker) ? 'PKR' : 'USD');
    currencies[tx.ticker] = currencies[tx.ticker].toUpperCase();
  });
  return currencies;
}

/* -------------------------------------------------------------------------- */
/* Price tape                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A per-ticker sorted tape of observed native-currency closing prices, built
 * from the backend's daily history plus the prices on the user's own trades.
 *
 * Lookups carry the last close forward (so weekends and holidays hold their
 * value instead of collapsing to zero) and back-fill the earliest known price
 * for days before the history begins. There is no interpolation: a price is
 * only ever a real observed close.
 */
function buildPriceTapes(normalized, livePrices, historicalPrices, currencies) {
  const tapes = {};

  const push = (ticker, dayStr, price) => {
    if (!ticker || !(price > 0)) return;
    if (!tapes[ticker]) tapes[ticker] = { points: new Map() };
    // Backend history wins over a trade price for the same day, and it is
    // merged second, so a plain set is the right precedence.
    tapes[ticker].points.set(dayStr, price);
  };

  // 1. Prices observed on the user's own buy/sell tickets.
  normalized.forEach(tx => {
    if ((tx.type === 'buy' || tx.type === 'sell') && tx.priceNative > 0) {
      push(tx.ticker, tx.dayStr, tx.priceNative);
    }
  });

  // 2. Real daily closes from the backend (authoritative).
  Object.entries(historicalPrices || {}).forEach(([ticker, entry]) => {
    const key = ticker.toUpperCase();
    const history = Array.isArray(entry) ? entry : entry?.history;
    if (!Array.isArray(history)) return;
    history.forEach(hp => {
      const dayStr = toDayStr(hp.date);
      const price = Number(hp.price);
      if (dayStr && price > 0) push(key, dayStr, price);
    });
  });

  // 3. Today's live quote, so the final point reflects the real-time price.
  const today = todayDayStr();
  Object.entries(livePrices || {}).forEach(([ticker, quote]) => {
    const key = ticker.toUpperCase();
    const price = typeof quote === 'object' ? Number(quote?.price) : Number(quote);
    if (price > 0 && tapes[key]) push(key, today, price);
  });

  // Freeze into sorted arrays with a forward-walking cursor.
  Object.keys(tapes).forEach(ticker => {
    const sorted = [...tapes[ticker].points.entries()]
      .map(([dayStr, price]) => ({ ms: dayStrToMs(dayStr), price }))
      .sort((a, b) => a.ms - b.ms);
    tapes[ticker] = { entries: sorted, cursor: 0, lastMs: -Infinity, currency: currencies[ticker] || 'USD' };
  });

  return tapes;
}

/** Last observed close at or before `ms`, or the earliest known close. */
function priceAsOf(tape, ms) {
  if (!tape || tape.entries.length === 0) return 0;
  if (ms < tape.lastMs) tape.cursor = 0;
  tape.lastMs = ms;
  const { entries } = tape;
  while (tape.cursor + 1 < entries.length && entries[tape.cursor + 1].ms <= ms) tape.cursor++;
  if (ms < entries[0].ms) return entries[0].price;
  return entries[tape.cursor].price;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Money-weighted (XIRR) return of the whole portfolio as of `asOfDate`.
 *
 * @returns {{annualized:number, cumulative:number, growth:number}}
 */
export function calculateAllTimeMWR(
  transactions,
  currentPortfolioValue,
  displayCurrency = 'USD',
  currentFxRate = 278.0,
  asOfDate = new Date(),
  fxSeries = null
) {
  if (!transactions || transactions.length === 0) return { annualized: 0, cumulative: 0, growth: 1 };

  const asOfDayStr = toDayStr(asOfDate) || todayDayStr();
  const asOfMs = dayStrToMs(asOfDayStr);
  const fxAt = buildFxLookup(fxSeries, currentFxRate);

  const normalized = transactions
    .map(tx => normalizeTransaction(tx, currentFxRate))
    .filter(tx => tx && tx.ms <= asOfMs)
    .sort((a, b) => a.ms - b.ms);

  if (normalized.length === 0) return { annualized: 0, cumulative: 0, growth: 1 };

  const currencies = resolveCurrencies(normalized, {}, {});

  const cashFlows = normalized
    .map(tx => {
      const nativeCurrency = currencies[tx.ticker] || tx.currency || 'USD';
      const rate = fxSeries ? fxAt(tx.ms) : tx.fxRateOnDate;
      const amount = convertAmount(tx.amountNative, nativeCurrency, displayCurrency, rate);
      if (!(amount > 0)) return null;
      // Buys and taxes are capital going in; sells and dividends come back out.
      const isInflow = tx.type === 'buy' || tx.type === 'tax';
      return { date: tx.dayStr, amount: isInflow ? amount : -amount };
    })
    .filter(Boolean);

  if (currentPortfolioValue > 0) {
    cashFlows.push({ date: asOfDayStr, amount: -currentPortfolioValue });
  }

  return calculateXIRR(cashFlows);
}

/**
 * Build the daily portfolio time series that the graph renders.
 *
 * Each point carries the market value, cost basis, unrealised/realised P&L and
 * both return measures as of that calendar day:
 *
 *   - `twrPct`  time-weighted return, chain-linked daily as
 *               (endValue - netExternalFlow) / previousValue, so deposits and
 *               withdrawals do not register as performance.
 *   - `mwrPct`  cumulative money-weighted return (XIRR) if the portfolio were
 *               liquidated that day.
 *
 * @param {Array}  transactions
 * @param {Object} livePrices        { TICKER: { price, currency } }
 * @param {Object} historicalPrices  { TICKER: { currency, history: [{date, price}] } }
 * @param {string} displayCurrency   'USD' | 'PKR'
 * @param {number} currentFxRate     current USD->PKR, used as a fallback
 * @param {Object} fxSeries          { 'YYYY-MM-DD': usdToPkr } historical rates
 * @param {Object} opts              { mwr = true } - false skips the money-weighted solve
 */
export function generatePortfolioTimeSeries(
  transactions,
  livePrices = {},
  historicalPrices = {},
  displayCurrency = 'USD',
  currentFxRate = 278.0,
  fxSeries = null,
  { mwr = true } = {}
) {
  if (!transactions || transactions.length === 0) return [];

  const normalized = transactions
    .map(tx => normalizeTransaction(tx, currentFxRate))
    .filter(Boolean)
    .sort((a, b) => a.ms - b.ms);

  if (normalized.length === 0) return [];

  const currencies = resolveCurrencies(normalized, livePrices, historicalPrices);
  const tapes = buildPriceTapes(normalized, livePrices, historicalPrices, currencies);
  const fxAt = buildFxLookup(fxSeries, currentFxRate);
  const haveFxSeries = Boolean(fxSeries && Object.keys(fxSeries).length > 0);

  const startMs = normalized[0].ms;
  const endMs = Math.max(startMs, dayStrToMs(todayDayStr()));

  // Rolling portfolio state.
  const heldShares = {};      // ticker -> share count
  const costDisplay = {};     // ticker -> book cost in display currency
  let realizedPnl = 0;
  // Money in (buys, taxes) minus money out (sales, dividends): what the
  // portfolio has cost on net. Value minus this is exactly the total P&L, so
  // the two lines cross where MWR changes sign.
  let netInvested = 0;
  let cumulativeTwr = 1.0;
  let prevValue = 0;
  let txIndex = 0;

  // Money-weighted flows accumulate as we walk forward; the solver is warm
  // started from the previous day so each day costs only a few iterations.
  const mwrFlows = [];
  let mwrWarmStart = null;

  const series = [];
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
    timeZone: 'UTC'
  });

  for (let ms = startMs; ms <= endMs; ms += MS_PER_DAY) {
    const dayStr = msToDayStr(ms);
    const fxRate = fxAt(ms);

    // --- 1. Apply every transaction dated on or before this day ------------
    let externalFlow = 0; // display currency, + = capital in, - = capital out

    while (txIndex < normalized.length && normalized[txIndex].ms <= ms) {
      const tx = normalized[txIndex++];
      const nativeCurrency = currencies[tx.ticker] || tx.currency || 'USD';
      // Prefer the rate that actually applied on the trade date.
      const txRate = haveFxSeries ? fxAt(tx.ms) : tx.fxRateOnDate;
      const amount = convertAmount(tx.amountNative, nativeCurrency, displayCurrency, txRate);

      if (tx.type === 'buy') {
        heldShares[tx.ticker] = (heldShares[tx.ticker] || 0) + tx.shares;
        costDisplay[tx.ticker] = (costDisplay[tx.ticker] || 0) + amount;
        externalFlow += amount;
        netInvested += amount;
        mwrFlows.push({ date: tx.dayStr, amount });
      } else if (tx.type === 'sell') {
        const held = heldShares[tx.ticker] || 0;
        // Average-cost basis: relieve cost in proportion to shares sold.
        const soldFraction = held > 0 ? Math.min(1, tx.shares / held) : 0;
        const costRemoved = (costDisplay[tx.ticker] || 0) * soldFraction;
        costDisplay[tx.ticker] = (costDisplay[tx.ticker] || 0) - costRemoved;
        heldShares[tx.ticker] = Math.max(0, held - tx.shares);
        if (heldShares[tx.ticker] < 1e-8) {
          heldShares[tx.ticker] = 0;
          costDisplay[tx.ticker] = 0;
        }
        realizedPnl += amount - costRemoved;
        externalFlow -= amount;
        netInvested -= amount;
        mwrFlows.push({ date: tx.dayStr, amount: -amount });
      } else if (tx.type === 'dividend') {
        // Income taken out of the portfolio; it is a return, not a cost change.
        realizedPnl += amount;
        externalFlow -= amount;
        netInvested -= amount;
        mwrFlows.push({ date: tx.dayStr, amount: -amount });
      } else if (tx.type === 'tax') {
        realizedPnl -= amount;
        externalFlow += amount;
        netInvested += amount;
        mwrFlows.push({ date: tx.dayStr, amount });
      }
    }

    // --- 2. Value the holdings at this day's closes ------------------------
    let marketValue = 0;
    let costBasis = 0;
    let holdsUnpricedShares = false;

    for (const ticker of Object.keys(heldShares)) {
      const qty = heldShares[ticker];
      if (!(qty > 0)) continue;
      costBasis += costDisplay[ticker] || 0;

      const tape = tapes[ticker];
      const nativePrice = priceAsOf(tape, ms);
      if (!(nativePrice > 0)) {
        holdsUnpricedShares = true;
        continue;
      }
      marketValue += qty * convertAmount(nativePrice, currencies[ticker] || 'USD', displayCurrency, fxRate);
    }

    // A price gap would otherwise read as the position going to zero. Hold the
    // previous valuation flat instead of inventing a crash.
    if (holdsUnpricedShares && marketValue <= 0 && prevValue > 0) {
      marketValue = prevValue + externalFlow;
    }

    // --- 3. Time-weighted return ------------------------------------------
    // Standard daily chain link: strip out the money that arrived today so only
    // market movement is counted as performance.
    if (prevValue > 0.01) {
      const factor = (marketValue - externalFlow) / prevValue;
      if (Number.isFinite(factor) && factor > 0) cumulativeTwr *= factor;
    }
    prevValue = marketValue;

    // --- 4. Money-weighted return -----------------------------------------
    let mwrPct = 0;
    let mwrAnnualPct = 0;
    // The XIRR solve dominates the cost; callers that only need values and
    // P&L (one series per holding, say) can skip it.
    if (mwr && mwrFlows.length > 0 && marketValue > 0) {
      const flows = mwrFlows.concat([{ date: dayStr, amount: -marketValue }]);
      const result = calculateXIRR(flows, mwrWarmStart);
      if (result.growth > 0) mwrWarmStart = result.growth;
      mwrPct = result.cumulative;
      mwrAnnualPct = result.annualized;
    }

    series.push({
      date: dayStr,
      dateFormatted: dateFormatter.format(new Date(ms)),
      value: marketValue,
      costBasis,
      netInvested,
      unrealizedPnl: marketValue - costBasis,
      realizedPnl,
      pnl: marketValue - costBasis + realizedPnl,
      twrFactor: cumulativeTwr,
      twrPct: (cumulativeTwr - 1) * 100,
      mwrPct,
      mwrAnnualPct
    });
  }

  return series;
}

/**
 * All-time time-weighted return, derived from the same daily series the graph
 * uses so the header and the chart can never disagree.
 */
export function calculateAllTimeTWR(
  transactions,
  livePrices = {},
  historicalPrices = {},
  displayCurrency = 'USD',
  currentFxRate = 278.0,
  fxSeries = null
) {
  const series = generatePortfolioTimeSeries(
    transactions,
    livePrices,
    historicalPrices,
    displayCurrency,
    currentFxRate,
    fxSeries
  );
  return series.length > 0 ? series[series.length - 1].twrPct : 0;
}

/**
 * Re-base a slice of the daily series onto its own starting point, so that a
 * 1M / 3M / YTD / 1Y window reports the return earned *within* that window
 * rather than the all-time figure.
 */
export function rebaseSeries(series) {
  if (!series || series.length === 0) return [];

  const first = series[0];
  const baseTwr = first.twrFactor > 0 ? first.twrFactor : 1;
  // MWR is not chain-linkable, so re-derive the window's growth from the ratio
  // of cumulative growth factors - an approximation, but a consistent one.
  const baseMwrGrowth = 1 + (first.mwrPct || 0) / 100;

  return series.map(pt => {
    const twrPct = (pt.twrFactor / baseTwr - 1) * 100;
    const mwrGrowth = 1 + (pt.mwrPct || 0) / 100;
    const mwrPct = baseMwrGrowth > 0 ? (mwrGrowth / baseMwrGrowth - 1) * 100 : pt.mwrPct;
    return { ...pt, twrPct, mwrPct };
  });
}
