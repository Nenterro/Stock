import { calculateXIRR, calculateAllTimeMWR, calculateAllTimeTWR, generatePortfolioTimeSeries } from '../src/utils/portfolio_math.js';

const txs = [
  { type: 'buy', date: '2023-01-01', asset: 'AAPL', shares: 10, price: 100, fees: 0, currency: 'USD', fxRateOnDate: 1 },
  { type: 'buy', date: '2023-06-01', asset: 'AAPL', shares: 5, price: 150, fees: 0, currency: 'USD', fxRateOnDate: 1 },
  { type: 'sell', date: '2023-12-01', asset: 'AAPL', shares: 5, price: 200, fees: 0, currency: 'USD', fxRateOnDate: 1 }
];

const currentPortfolioValue = 10 * 250; // AAPL is 250 now. Holding 10 shares.

console.log('MWR:', calculateAllTimeMWR(txs, currentPortfolioValue, 'USD', 1));
console.log('TWR (AllTime):', calculateAllTimeTWR(txs, currentPortfolioValue, 'USD', 1));

const livePrices = { AAPL: { price: 250, currency: 'USD' } };
const series = generatePortfolioTimeSeries(txs, livePrices, 'USD', 1);
console.log('TWR (Graph):', series[series.length - 1].twrPct);
