import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePositions,
  computeLookThrough,
  concentration,
  planContribution,
  riskMetrics,
  compareToBenchmark,
  incomeSummary,
  feeDrag,
  companyKey
} from '../src/utils/portfolio_analytics.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

const txs = [
  { ticker: 'OGDC', type: 'buy', shares: 100, price: 200, date: '2026-01-05', currency: 'PKR', fxRateOnDate: 280 },
  { ticker: 'OGDC', type: 'buy', shares: 100, price: 300, date: '2026-02-05', currency: 'PKR', fxRateOnDate: 280 },
  { ticker: 'OGDC', type: 'sell', shares: 50, price: 400, date: '2026-03-05', currency: 'PKR', fxRateOnDate: 280 },
  { ticker: 'OGDC', type: 'dividend', amount: 1000, date: '2026-04-05', currency: 'PKR', fxRateOnDate: 280 },
  { ticker: 'SPUS', type: 'buy', shares: 10, price: 50, date: '2026-01-10', currency: 'USD', fxRateOnDate: 280 },
  { ticker: 'AAPL', type: 'buy', shares: 2, price: 250, date: '2026-01-10', currency: 'USD', fxRateOnDate: 280 }
];
const prices = {
  OGDC: { price: 350, currency: 'PKR' },
  SPUS: { price: 60, currency: 'USD' },
  AAPL: { price: 300, currency: 'USD' }
};

test('average-cost positions in PKR', () => {
  const p = computePositions(txs, prices, { displayCurrency: 'PKR', fxRate: 280 });
  const ogdc = p.holdings.find((h) => h.ticker === 'OGDC');
  assert.equal(ogdc.shares, 150);
  close(ogdc.avgCost, 250); // (100*200 + 100*300) / 200, unchanged by the sale
  close(ogdc.costBasis, 37500);
  close(ogdc.realized, 50 * 400 - 50 * 250);
  close(ogdc.dividends, 1000);
  close(ogdc.marketValue, 150 * 350);
  const aapl = p.holdings.find((h) => h.ticker === 'AAPL');
  close(aapl.marketValue, 2 * 300 * 280);
  close(p.holdings.reduce((a, h) => a + h.weight, 0), 1);
});

test('positions convert to USD at the trade-date rate for cost', () => {
  const p = computePositions(txs, prices, { displayCurrency: 'USD', fxRate: 300 });
  const ogdc = p.holdings.find((h) => h.ticker === 'OGDC');
  close(ogdc.costBasis, 37500 / 280);
  close(ogdc.marketValue, (150 * 350) / 300);
});

test('look-through finds overlap and keeps an unknown tail', () => {
  const holdings = [
    { ticker: 'AAPL', marketValue: 600, name: 'Apple' },
    { ticker: 'SPUS', marketValue: 400, name: 'SPUS' }
  ];
  const fundHoldings = {
    SPUS: {
      name: 'SPUS',
      holdings: [
        { ticker: 'AAPL', name: 'Apple', weight: 0.25 },
        { ticker: 'GOOGL', name: 'Alphabet', weight: 0.25 }
      ],
      sectors: [{ sector: 'Technology', weight: 1 }],
      countries: [{ country: 'United States', weight: 0.5 }],
      assetMix: { stock: 1, bond: 0, cash: 0, other: 0 }
    }
  };
  const fundamentals = { AAPL: { name: 'Apple', profile: { sector: 'Technology', country: 'United States' } } };
  const lt = computeLookThrough(holdings, fundHoldings, fundamentals);

  const apple = lt.companies.find((c) => c.key === 'AAPL');
  close(apple.value, 700);
  close(apple.direct, 600);
  close(apple.indirect, 100);
  assert.ok(apple.overlap);
  assert.equal(lt.overlaps.length, 1);

  const tail = lt.companies.find((c) => c.undisclosed);
  close(tail.value, 200);
  close(lt.disclosedShare, 0.8);
  assert.ok(!lt.topCompanies.some((c) => c.undisclosed));

  const us = lt.countries.find((c) => c.key === 'United States');
  close(us.value, 600 + 200);
  close(lt.countries.find((c) => c.key === 'Unknown').value, 200);
  close(lt.sectors.find((s) => s.key === 'Technology').value, 1000);
});

test('share classes collapse to one company', () => {
  assert.equal(companyKey('GOOGL'), companyKey('GOOG'));
  assert.equal(companyKey('OGDC.KA'), 'OGDC');
});

test('concentration and effective N', () => {
  const c = concentration([0.25, 0.25, 0.25, 0.25]);
  close(c.hhi, 0.25);
  close(c.effectiveN, 4);
  close(c.top1, 0.25);
  const skew = concentration([0.7, 0.1, 0.1, 0.1]);
  assert.ok(skew.effectiveN < 2);
});

test('contribution plan fills the biggest shortfall first and never sells', () => {
  const holdings = [
    { ticker: 'A', marketValue: 800, price: 10 },
    { ticker: 'B', marketValue: 200, price: 10 }
  ];
  const plan = planContribution(holdings, { A: 0.5, B: 0.5 }, 200, { wholeShares: true });
  assert.equal(plan.buys.length, 1);
  assert.equal(plan.buys[0].ticker, 'B');
  close(plan.buys[0].amount, 200);
  const b = plan.after.find((r) => r.ticker === 'B');
  close(b.weight, 400 / 1200);
});

test('contribution plan handles new tickers and leftovers', () => {
  const holdings = [{ ticker: 'A', marketValue: 1000, price: 10 }];
  const plan = planContribution(holdings, { A: 0.5, C: 0.5 }, 105, { wholeShares: true, prices: { C: 20 } });
  const c = plan.buys.find((x) => x.ticker === 'C');
  assert.equal(c.shares, 5);
  close(plan.leftover, 5);
});

test('risk metrics on a steady series', () => {
  const series = [];
  let f = 1;
  const start = Date.UTC(2025, 0, 1);
  for (let i = 0; i < 400; i++) {
    const d = new Date(start + i * 86400000);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) f *= i % 2 ? 1.01 : 0.995;
    series.push({ date: d.toISOString().slice(0, 10), twrFactor: f, value: f * 100 });
  }
  const r = riskMetrics(series, { riskFreeRate: 0.1 });
  assert.ok(r.volatility > 0);
  assert.ok(r.cagr > 0);
  assert.ok(r.maxDrawdown <= 0 && r.maxDrawdown > -0.01);

  // Benchmark identical to the portfolio: beta 1, correlation 1, no alpha.
  const bench = series.map((p) => ({ date: p.date, price: p.twrFactor * 50 }));
  const cmp = compareToBenchmark(r, bench, { riskFreeRate: 0.1 });
  close(cmp.beta, 1, 1e-9);
  close(cmp.correlation, 1, 1e-9);
  close(cmp.trackingError, 0, 1e-9);
});

test('income summary and fee drag', () => {
  const p = computePositions(txs, prices, { displayCurrency: 'PKR', fxRate: 280 });
  const inc = incomeSummary(txs, p, { today: '2026-10-01' });
  close(inc.trailing12m.gross, 1000);
  assert.equal(inc.byTicker[0].ticker, 'OGDC');
  const fees = feeDrag([{ ticker: 'SPUS', marketValue: 1000 }, { ticker: 'AAPL', marketValue: 1000 }], { SPUS: 0.0045 });
  close(fees.annualCost, 4.5);
  close(fees.portfolioDrag, 0.00225);
});
