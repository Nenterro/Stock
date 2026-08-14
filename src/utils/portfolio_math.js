/**
 * Portfolio Math Utilities
 * Calculates Money-Weighted Return (MWR / XIRR) and Time-Weighted Return (TWR)
 */

/**
 * calculateXIRR (Money-Weighted Return)
 * Input: Array of objects { amount: number, date: Date }
 * amount > 0 means money entering the portfolio (invested capital / buys).
 * amount < 0 means money leaving the portfolio (returns / sells / dividends).
 * Note: 'amount' must be in the same base currency.
 * Returns: Annualized percentage (e.g. 15.5 for 15.5%)
 */
export function calculateXIRR(cashFlows) {
  if (!cashFlows || cashFlows.length < 2) return 0.0;

  // Ensure there is at least one positive and one negative flow
  const hasPositive = cashFlows.some(cf => cf.amount > 0);
  const hasNegative = cashFlows.some(cf => cf.amount < 0);
  if (!hasPositive || !hasNegative) return 0.0;

  // Sort by date ascending
  const sortedFlows = [...cashFlows].sort((a, b) => a.date - b.date);
  const startDate = sortedFlows[0].date;
  const endDate = sortedFlows[sortedFlows.length - 1].date;

  const totalDays = Math.max(0.001, (endDate - startDate) / (1000 * 60 * 60 * 24));
  const totalYears = totalDays / 365.0;

  const npv = (rate) => {
    let sum = 0.0;
    for (const flow of sortedFlows) {
      const days = Math.max(0, (flow.date - startDate) / (1000 * 60 * 60 * 24));
      const years = days / 365.0;
      const base = 1.0 + rate;
      if (base <= 0) return Number.POSITIVE_INFINITY;
      sum += flow.amount / Math.pow(base, years);
    }
    return sum;
  };

  const dNpv = (rate) => {
    let sum = 0.0;
    for (const flow of sortedFlows) {
      const days = Math.max(0, (flow.date - startDate) / (1000 * 60 * 60 * 24));
      const years = days / 365.0;
      const base = 1.0 + rate;
      if (base <= 0) return 0;
      sum -= years * flow.amount / Math.pow(base, years + 1.0);
    }
    return sum;
  };

  let bestRate = null;
  const seeds = [0.1, 0.5, -0.1, 1.0, 5.0, 20.0];
  
  for (const seed of seeds) {
    let rate = seed;
    for (let i = 0; i < 200; i++) {
      const y = npv(rate);
      const dy = dNpv(rate);
      if (Math.abs(dy) < 1e-14) break;
      const step = y / dy;
      rate -= step;
      if (rate <= -0.9999) rate = -0.9999;
      if (Math.abs(step) < 1e-7) {
        bestRate = rate;
        break;
      }
    }
    if (bestRate !== null) break;
  }

  // Fallback: simple return on invested capital if solver failed
  if (bestRate === null) {
    let totalIn = 0;
    let totalOut = 0;
    sortedFlows.forEach(cf => {
      if (cf.amount > 0) totalIn += cf.amount;
      else totalOut += Math.abs(cf.amount);
    });
    if (totalIn === 0) return { annualized: 0.0, cumulative: 0.0 };
    const ret = ((totalOut - totalIn) / totalIn) * 100.0;
    return { annualized: ret, cumulative: ret };
  }

  let annualized = bestRate * 100.0;
  let cumulative = (Math.pow(1.0 + bestRate, totalYears) - 1.0) * 100.0;

  // Return both so the UI can choose what to display
  return {
    annualized,
    cumulative
  };
}

/**
 * calculateAllTimeMWR
 * Helper that builds the cashflow array for the portfolio.
 * - Buys represent money IN (positive)
 * - Sells / Dividends represent money OUT (negative)
 * - The terminal current value represents money OUT (negative) at today's date
 */
export function calculateAllTimeMWR(transactions, currentPortfolioValue, displayCurrency, currentFxRate, asOfDate = new Date()) {
  if (transactions.length === 0) return { annualized: 0, cumulative: 0 };

  const cashFlows = [];
  
  // Filter transactions up to asOfDate
  const pastTransactions = transactions.filter(tx => new Date(tx.date) <= asOfDate);

  pastTransactions.forEach(tx => {
    const type = (tx.type || '').toLowerCase();
    
    // Pure Stock Portfolio Model: Only evaluate stock trades (buys, sells, dividends, taxes)
    if (['buy', 'sell', 'dividend', 'tax'].includes(type)) {
      const isOutflow = (type === 'sell' || type === 'dividend'); // money returning from stock to user
      const isInflow = (type === 'buy' || type === 'tax'); // money deployed into stock by user

      const shares = Number(tx.shares) || Number(tx.quantity) || 0;
      const price = Number(tx.price) || 0;
      const fees = Number(tx.fees) || 0;

      let amountNative = 0;
      if (type === 'buy') amountNative = (shares * price) + fees;
      else if (type === 'sell') amountNative = (shares * price) - fees;
      else if (type === 'dividend' || type === 'tax') amountNative = Math.abs(Number(tx.amount) || 0);

      // Convert to display currency using historical FX
      const txFx = Number(tx.fxRateOnDate) || currentFxRate;
      const assetCurrency = tx.currency || 'USD';

      let amountDisplay = amountNative;
      if (displayCurrency === 'USD' && assetCurrency === 'PKR') {
        amountDisplay = amountNative / txFx;
      } else if (displayCurrency === 'PKR' && assetCurrency === 'USD') {
        amountDisplay = amountNative * txFx;
      }

      if (amountDisplay > 0) {
        cashFlows.push({
          date: new Date(tx.date),
          amount: isOutflow ? -amountDisplay : amountDisplay
        });
      }
    }
  });

  if (currentPortfolioValue > 0) {
    cashFlows.push({
      date: asOfDate,
      amount: -currentPortfolioValue
    });
  }

  return calculateXIRR(cashFlows);
}

/**
 * calculateAllTimeTWR
 * Time-Weighted Return evaluates sub-periods between cash flows.
 * Since we don't have historical prices, we use a modified approach tracking the
 * cumulative net invested capital and market value at the time of each transaction.
 */
export function calculateAllTimeTWR(transactions, currentPortfolioValue, displayCurrency, currentFxRate) {
  if (transactions.length === 0) return 0.0;

  // Sort transactions chronologically
  const sorted = [...transactions]
    .filter(tx => ['buy', 'sell', 'dividend', 'tax'].includes((tx.type || '').toLowerCase()))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  if (sorted.length === 0) return 0.0;

  let cumulativeTwr = 1.0;
  let bv = 0.0; // Beginning value of the current sub-period
  
  // Track held shares per ticker to estimate market value at any point in time
  const heldShares = {};
  const lastKnownPrice = {};

  sorted.forEach(tx => {
    const type = (tx.type || '').toLowerCase();
    const ticker = (tx.asset || tx.ticker || '').toUpperCase();
    const shares = Number(tx.shares) || Number(tx.quantity) || 0;
    const price = Number(tx.price) || 0;
    const fees = Number(tx.fees) || 0;
    const txFx = Number(tx.fxRateOnDate) || currentFxRate;
    const assetCurrency = tx.currency || 'USD';

    // Update last known price if valid
    if (price > 0) {
      let priceDisplay = price;
      if (displayCurrency === 'USD' && assetCurrency === 'PKR') {
        priceDisplay = price / txFx;
      } else if (displayCurrency === 'PKR' && assetCurrency === 'USD') {
        priceDisplay = price * txFx;
      }
      lastKnownPrice[ticker] = priceDisplay;
    }

    // 1. Estimate portfolio value just *before* this transaction occurs (End Value of sub-period)
    let ev = 0.0;
    Object.keys(heldShares).forEach(t => {
      const s = heldShares[t] || 0;
      if (s > 0) {
        ev += s * (lastKnownPrice[t] || 0);
      }
    });

    // 2. Calculate sub-period return
    if (bv > 0.01) {
      cumulativeTwr *= (ev / bv);
    }

    // 3. Calculate external cash flow in display currency
    let amountNative = 0;
    
    if (type === 'buy') amountNative = (shares * price) + fees;
    else if (type === 'sell') amountNative = (shares * price) - fees;
    else if (type === 'dividend' || type === 'tax') amountNative = Number(tx.amount) || 0;

    let amountDisplay = amountNative;
    if (displayCurrency === 'USD' && assetCurrency === 'PKR') {
      amountDisplay = amountNative / txFx;
    } else if (displayCurrency === 'PKR' && assetCurrency === 'USD') {
      amountDisplay = amountNative * txFx;
    }

    let cf = 0;
    if (type === 'buy' || type === 'tax') cf = amountDisplay; // Inflow
    else if (type === 'sell' || type === 'dividend') cf = -amountDisplay; // Outflow

    // 4. Set Beginning Value (BV) for the *next* sub-period
    bv = ev + cf;

    // 5. Update holdings state *after* the transaction
    if (type === 'buy') {
      heldShares[ticker] = (heldShares[ticker] || 0) + shares;
    } else if (type === 'sell') {
      heldShares[ticker] = (heldShares[ticker] || 0) - shares;
      if (heldShares[ticker] < 0.0001) heldShares[ticker] = 0;
    }
  });

  // Final sub-period to today's actual value
  if (currentPortfolioValue > 0 && bv > 0.01) {
    cumulativeTwr *= (currentPortfolioValue / bv);
  }

  return (cumulativeTwr - 1.0) * 100.0;
}

/**
 * generatePortfolioTimeSeries
 * Builds a daily time-series array of portfolio performance points for graphing.
 */
export function generatePortfolioTimeSeries(transactions, livePrices = {}, displayCurrency = 'USD', currentFxRate = 278.0) {
  if (!transactions || transactions.length === 0) return [];

  const sorted = [...transactions]
    .filter(tx => ['buy', 'sell', 'dividend', 'tax'].includes((tx.type || '').toLowerCase()))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  if (sorted.length === 0) return [];

  const firstTxDateStr = (sorted[0].date || '').split('T')[0];
  const [startY, startM, startD] = firstTxDateStr.split('-').map(Number);
  const startDate = new Date(startY, startM - 1, startD);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const series = [];
  const heldShares = {};
  const lastKnownPrice = {};

  let cumulativeTwr = 1.0;
  let prevValue = 0.0;
  let runningCostBasis = 0.0;
  let txIndex = 0;

  const getLocalDayStr = (dateObj) => {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  // Loop day-by-day from first tx date to today
  for (let d = new Date(startDate); d <= today; d.setDate(d.getDate() + 1)) {
    const dayStr = getLocalDayStr(d);
    let externalFlowDisplay = 0;

    // Process all transactions occurring on this day
    while (txIndex < sorted.length) {
      const txDateStr = (sorted[txIndex].date || '').split('T')[0];
      if (txDateStr !== dayStr) break;

      const tx = sorted[txIndex++];
      const type = (tx.type || '').toLowerCase();
      const ticker = (tx.asset || tx.ticker || '').toUpperCase();
      const shares = Number(tx.shares) || Number(tx.quantity) || 0;
      const price = Number(tx.price) || 0;
      const fees = Number(tx.fees) || 0;
      const txFx = Number(tx.fxRateOnDate) || currentFxRate;
      const assetCurrency = tx.currency || 'USD';

      if (price > 0) {
        let priceDisplay = price;
        if (displayCurrency === 'USD' && assetCurrency === 'PKR') priceDisplay = price / txFx;
        else if (displayCurrency === 'PKR' && assetCurrency === 'USD') priceDisplay = price * txFx;
        lastKnownPrice[ticker] = priceDisplay;
      }

      let amountNative = 0;
      if (type === 'buy') amountNative = (shares * price) + fees;
      else if (type === 'sell') amountNative = (shares * price) - fees;
      else if (type === 'dividend' || type === 'tax') amountNative = Number(tx.amount) || 0;

      let amountDisplay = amountNative;
      if (displayCurrency === 'USD' && assetCurrency === 'PKR') amountDisplay = amountNative / txFx;
      else if (displayCurrency === 'PKR' && assetCurrency === 'USD') amountDisplay = amountNative * txFx;

      if (type === 'buy' || type === 'tax') {
        externalFlowDisplay += amountDisplay;
        runningCostBasis += amountDisplay;
        heldShares[ticker] = (heldShares[ticker] || 0) + shares;
      } else if (type === 'sell') {
        externalFlowDisplay -= amountDisplay;
        runningCostBasis = Math.max(0, runningCostBasis - amountDisplay);
        heldShares[ticker] = (heldShares[ticker] || 0) - shares;
        if (heldShares[ticker] < 0.0001) heldShares[ticker] = 0;
      } else if (type === 'dividend') {
        externalFlowDisplay -= amountDisplay;
        runningCostBasis = Math.max(0, runningCostBasis - amountDisplay);
      }
    }

    // Calculate total portfolio market value on this day
    let portfolioValue = 0.0;
    const totalTimeSpan = Math.max(1, today.getTime() - startDate.getTime());
    const currentElapsed = Math.min(totalTimeSpan, Math.max(0, d.getTime() - startDate.getTime()));
    const timeProgress = currentElapsed / totalTimeSpan;

    Object.keys(heldShares).forEach(t => {
      const qty = heldShares[t] || 0;
      if (qty > 0) {
        let price = lastKnownPrice[t] || 0;

        // Fetch live price for ticker if available
        let currentLive = price;
        if (livePrices[t]?.price) {
          const lp = livePrices[t].price;
          const currency = livePrices[t].currency || 'USD';
          if (displayCurrency === 'USD' && currency === 'PKR') currentLive = lp / currentFxRate;
          else if (displayCurrency === 'PKR' && currency === 'USD') currentLive = lp * currentFxRate;
          else currentLive = lp;
        }

        // Interpolate smoothly between buy price and live price across days
        if (currentLive > 0 && price > 0) {
          price = price + (currentLive - price) * timeProgress;
        } else if (currentLive > 0) {
          price = currentLive;
        }

        portfolioValue += qty * price;
      }
    });

    // Sub-period TWR linking
    if (portfolioValue > 0) {
      const denom = prevValue + externalFlowDisplay;
      if (denom > 0.01) {
        const r = portfolioValue / denom;
        cumulativeTwr *= r;
      }
      prevValue = portfolioValue;
    } else if (externalFlowDisplay > 0 && prevValue === 0) {
      prevValue = externalFlowDisplay;
    }

    const twrPct = (cumulativeTwr - 1.0) * 100.0;

    // Calculate MWR as of this day `d`
    const pastTx = sorted.slice(0, txIndex);
    const mwrResult = calculateAllTimeMWR(pastTx, portfolioValue, displayCurrency, currentFxRate, d);
    const mwrPct = mwrResult.cumulative;

    series.push({
      date: dayStr,
      dateFormatted: new Date(dayStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }),
      value: portfolioValue,
      costBasis: runningCostBasis,
      twrPct: twrPct,
      mwrPct: mwrPct,
      pnl: portfolioValue - runningCostBasis
    });
  }

  return series;
}
