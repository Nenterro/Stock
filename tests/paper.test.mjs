import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeCost, newPortfolio, fillPending, markToMarket, recordNav, metrics, lotSize, marketOf } from '../mcp/paper/engine.mjs';
import { sma, rsi, pivots, bullishPatterns, bearishPatterns } from '../mcp/paper/indicators.mjs';
import { STRATEGIES } from '../mcp/paper/strategies.mjs';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

/** A market of synthetic daily bars. */
function mkMarket(seriesBySym, { rates = { USD: 1, JPY: 150, GBP: 0.8 }, info = {} } = {}) {
  return {
    rates,
    bars: (s) => seriesBySym[s] || [],
    info: (s) => info[s] || { currency: 'USD', country: 'United States' },
    liquidity: () => 50e6
  };
}
const days = (n, start = '2026-01-01') => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${start}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));

test('costs: US minimum commission, UK stamp duty on shares but not ETFs, PSX broker rate', () => {
  close(tradeCost({ symbol: 'AAPL', currency: 'USD', value: 500, shares: 2, side: 'buy', liquidity: 1e9 }).commission, 0.35);
  assert.ok(tradeCost({ symbol: 'SHEL.L', currency: 'GBP', value: 1000, shares: 30, side: 'buy', liquidity: 1e9 }).stamp > 4.9);
  assert.equal(tradeCost({ symbol: 'ISWD', currency: 'USD', value: 1000, shares: 15, side: 'buy', liquidity: 1e7 }).stamp, 0);
  close(tradeCost({ symbol: 'MEBL', currency: 'PKR', value: 1000, shares: 10, side: 'sell', liquidity: 5e6 }).commission, 1.7);
  assert.equal(lotSize('7203.T'), 100);
  assert.equal(marketOf('0016.HK', 'HKD'), 'hk');
});

test('orders fill at the next close, in whole shares, net of costs', () => {
  const d = days(3);
  const m = mkMarket({ X: d.map((date, i) => ({ date, price: [100, 110, 120][i], adjClose: [100, 110, 120][i] })) });
  const p = newPortfolio({ id: 't', startedAt: d[0], cash: 1000 });
  p.pending = { createdOn: d[0], targets: { X: 1 }, reason: 'test' };
  const log = [];
  fillPending(p, d[1], m, log);
  assert.equal(log.length, 1);
  assert.equal(log[0].price, 110); // the next close, not the decision-day close
  assert.equal(p.positions.X.shares, 9);
  assert.ok(p.cash > 0 && p.cash < 1000 - 990 + 1e-9);
  recordNav(p, d[2], m);
  close(p.nav.at(-1).value, p.cash + 9 * 120);
});

test('a rebalance opens small new positions, but skips small top-ups', () => {
  const d = days(2);
  const syms = Array.from({ length: 100 }, (_, i) => `S${i}`);
  const m = mkMarket(Object.fromEntries(syms.map((s) => [s, d.map((date) => ({ date, price: 10, adjClose: 10 }))])));
  const p = newPortfolio({ id: 't', startedAt: d[0], cash: 30000 });
  p.pending = { createdOn: d[0], targets: Object.fromEntries(syms.map((s) => [s, 0.01])) };
  fillPending(p, d[1], m, []);
  assert.equal(Object.keys(p.positions).length, 100);
});

test('lots: a Tokyo order buys in 100-share lots or not at all', () => {
  const d = days(2);
  const m = mkMarket({ '7203.T': d.map((date) => ({ date, price: 3000, adjClose: 3000 })) }, { info: { '7203.T': { currency: 'JPY', country: 'Japan' } } });
  const p = newPortfolio({ id: 't', startedAt: d[0], cash: 1500 });
  p.pending = { createdOn: d[0], buys: [{ symbol: '7203.T', usd: 1500 }] };
  fillPending(p, d[1], m, []);
  assert.equal(p.positions['7203.T'], undefined); // one lot is $2,000
  p.cash = 2500;
  p.pending = { createdOn: d[0], buys: [{ symbol: '7203.T', usd: 2500 }] };
  fillPending(p, d[1], m, []);
  assert.equal(p.positions['7203.T'].shares, 100);
});

test('dividends arrive as cash after withholding; splits adjust the share count', () => {
  const d = days(3);
  // Day 2: a $1 dividend (adjusted close rises 1% more than the price).
  const bars = [
    { date: d[0], price: 100, adjClose: 100 },
    { date: d[1], price: 99, adjClose: 100 }
  ];
  const m = mkMarket({ X: bars });
  const p = newPortfolio({ id: 't', startedAt: d[0], cash: 0 });
  p.positions.X = { shares: 10, costUsd: 1000, currency: 'USD', country: 'United States', lastDate: d[0], lastPrice: 100 };
  markToMarket(p, d[1], m);
  // $10 gross, 30% US withholding for a Pakistan resident.
  close(p.cash, 10 * 100 * (100 / 100 / (99 / 100) - 1) * 0.7, 1e-6);
  // A 2-for-1 split: today's series re-based, yesterday's stored price is double.
  const m2 = mkMarket({ X: [{ date: d[1], price: 49.5, adjClose: 50 }, { date: d[2], price: 50, adjClose: 50.5 }] });
  markToMarket(p, d[2], m2);
  close(p.positions.X.shares, 20);
});

test('metrics: return and drawdown from the NAV, contributions are not returns', () => {
  const p = newPortfolio({ id: 't', startedAt: '2026-01-01', cash: 100 });
  p.nav = [
    { date: '2026-01-01', value: 100 },
    { date: '2026-01-02', value: 110 },
    { date: '2026-01-03', value: 99 },
    { date: '2026-01-04', value: 199 }
  ];
  p.flows.push({ date: '2026-01-04', usd: 100 });
  const m = metrics(p);
  close(m.return, 0.99 - 1 + 0, 1e-9);
  close(m.maxDrawdown, 99 / 110 - 1, 1e-9);
});

test('indicators: SMA and RSI', () => {
  close(sma([1, 2, 3, 4], 2), 3.5);
  assert.equal(rsi([1, 2, 3, 4, 5], 2), 100);
  assert.ok(rsi([5, 4, 3, 2, 1, 1.1], 2) < 50);
});

/** Closes along straight segments between turning points. */
function path(points) {
  const xs = [];
  for (let k = 0; k < points.length - 1; k++) {
    const [i0, v0] = points[k];
    const [i1, v1] = points[k + 1];
    for (let i = i0; i < i1; i++) xs.push(v0 + ((v1 - v0) * (i - i0)) / (i1 - i0));
  }
  xs.push(points.at(-1)[1]);
  return xs;
}
const toBars = (xs, vol = () => 1000) => days(xs.length).map((date, i) => ({ date, price: xs[i], adjClose: xs[i], volume: vol(i, xs.length) }));

test('patterns: a double bottom breaks out on volume, and only on volume', () => {
  // Down to 80, up to 92, back to 80.5, then up through 92 on the last bar.
  const xs = path([[0, 100], [40, 80], [65, 92], [90, 80.5], [118, 91.5], [119, 93]]);
  const withVol = toBars(xs, (i, n) => (i === n - 1 ? 3000 : 1000));
  const found = bullishPatterns(withVol).map((f) => f.pattern);
  assert.ok(found.includes('double bottom'), found.join(','));
  const noVol = toBars(xs, () => 1000);
  assert.equal(bullishPatterns(noVol).length, 0);
  assert.ok(pivots(xs, 5).length >= 3);
});

test('patterns: a double top breakdown is bearish', () => {
  const xs = path([[0, 80], [40, 100], [65, 88], [90, 99.5], [118, 88.5], [119, 87]]);
  assert.ok(bearishPatterns(toBars(xs)).some((f) => f.pattern === 'double top'));
});

test('strategies: unique ids, frozen rules written, every one decides without data', () => {
  const ids = STRATEGIES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of STRATEGIES) {
    assert.ok(s.rules.length > 40, s.id);
    const p = newPortfolio({ id: s.id, startedAt: '2026-11-25' });
    const ctx = { date: '2026-11-25', weekday: 3, newMonth: true, newQuarter: false, stocks: [], rows: new Map(), bars: () => [], lastBarDate: () => null, snapshot: null, targets: null, pakistanShare: null, value: 30000 };
    assert.doesNotThrow(() => s.decide(ctx, p), s.id);
  }
});
