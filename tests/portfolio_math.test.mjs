import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePortfolioTimeSeries } from '../src/utils/portfolio_math.js';

test('net invested: value minus it is the total P&L, every day', () => {
  const txs = [
    { type: 'BUY', ticker: 'ABC', currency: 'USD', date: '2026-01-05', shares: 10, price: 10, fees: 1 },
    { type: 'SELL', ticker: 'ABC', currency: 'USD', date: '2026-02-02', shares: 5, price: 14, fees: 1 },
    { type: 'DIVIDEND', ticker: 'ABC', currency: 'USD', date: '2026-02-20', amount: 3 },
    { type: 'TAX', ticker: 'ABC', currency: 'USD', date: '2026-02-20', amount: -0.45 },
    { type: 'BUY', ticker: 'ABC', currency: 'USD', date: '2026-03-02', shares: 4, price: 9, fees: 1 }
  ];
  const history = { ABC: { currency: 'USD', history: [
    { date: '2026-01-05', price: 10 }, { date: '2026-02-02', price: 14 }, { date: '2026-03-02', price: 9 }, { date: '2026-03-20', price: 8 }
  ] } };
  const series = generatePortfolioTimeSeries(txs, {}, history, 'USD', 278, null);
  assert.ok(series.length > 60);
  for (const p of series) assert.ok(Math.abs(p.value - p.netInvested - p.pnl) < 1e-9, `${p.date}`);

  // 101 in, 69 back from the sale, 3 dividend out, 0.45 tax in, 37 in again.
  const last = series.at(-1);
  assert.ok(Math.abs(last.netInvested - (101 - 69 - 3 + 0.45 + 37)) < 1e-9);
  // Holdings are below their own cost (9 shares worth 8, cost ~9.4), yet the
  // profit taken on the sale keeps the total - and MWR - positive.
  assert.ok(last.value < last.costBasis);
  assert.ok(last.pnl > 0 && last.value > last.netInvested && last.mwrPct > 0);
  assert.ok(Number.isFinite(last.mwrAnnualPct));
});

test('contributions add up to the portfolio gain; the PKR split adds up to the USD gain', async () => {
  const { contributionByHolding, currencySplit } = await import('../src/utils/portfolio_analytics.js');
  const txs = [
    { type: 'BUY', ticker: 'ABC', currency: 'USD', date: '2026-01-05', shares: 10, price: 10 },
    { type: 'SELL', ticker: 'ABC', currency: 'USD', date: '2026-02-02', shares: 10, price: 13 },
    { type: 'BUY', ticker: 'PSX1', currency: 'PKR', date: '2026-01-05', shares: 100, price: 280 },
    { type: 'DIVIDEND', ticker: 'PSX1', currency: 'PKR', date: '2026-02-10', amount: 1000 }
  ];
  const history = {
    ABC: { currency: 'USD', history: [{ date: '2026-01-05', price: 10 }, { date: '2026-02-02', price: 13 }] },
    PSX1: { currency: 'PKR', history: [{ date: '2026-01-05', price: 280 }, { date: '2026-03-01', price: 300 }] }
  };
  const fx = { '2026-01-05': 280, '2026-02-10': 279, '2026-03-01': 275 };
  const total = generatePortfolioTimeSeries(txs, {}, history, 'USD', 278, fx).at(-1).pnl;
  const c = contributionByHolding(txs, {}, history, { displayCurrency: 'USD', fxRate: 278, fxSeries: fx });
  assert.ok(Math.abs(c.total - total) < 1e-9);
  assert.equal(c.rows.find((r) => r.ticker === 'ABC').held, false);
  assert.ok(Math.abs(c.rows.find((r) => r.ticker === 'ABC').contribution - 30) < 1e-9);

  const split = currencySplit(txs, {}, history, { fxRate: 278, fxSeries: fx });
  assert.ok(Math.abs(split.priceEffect + split.currencyEffect - split.usdGain) < 1e-9);
  // The rupee strengthened (280 -> 275 per dollar), so it added to the USD gain.
  assert.ok(split.currencyEffect > 0 && split.rupeeChange > 0);
});
