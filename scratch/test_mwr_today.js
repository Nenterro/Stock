import { calculateXIRR, calculateAllTimeMWR } from '../src/utils/portfolio_math.js';

const txs = [
  { type: 'buy', date: new Date().toISOString(), shares: 10, price: 100, fees: 0, currency: 'USD' }
];

const mwr = calculateAllTimeMWR(txs, 1100, 'USD', 1.0);
console.log("MWR for today tx:", mwr);
