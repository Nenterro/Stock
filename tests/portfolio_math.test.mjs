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
