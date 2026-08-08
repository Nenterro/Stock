import { generatePortfolioTimeSeries } from '../src/utils/portfolio_math.js';

const txs = [
  { date: '2026-08-01', type: 'buy', ticker: 'AAPL', shares: 10, price: 20, currency: 'USD' },
  { date: '2026-08-06', type: 'sell', ticker: 'AAPL', shares: 2, price: 100, currency: 'USD' }
];

const livePrices = {
  AAPL: { price: 311.0, currency: 'USD' }
};

const series = generatePortfolioTimeSeries(txs, livePrices, 'USD', 278.0);
console.log("Daily Series Points:");
series.forEach(pt => {
  console.log(`${pt.date}: Value=$${pt.value.toFixed(2)}, CostBasis=$${pt.costBasis.toFixed(2)}, TWR=${pt.twrPct.toFixed(2)}%`);
});
