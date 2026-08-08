import { calculateXIRR, calculateAllTimeMWR } from '../src/utils/portfolio_math.js';

const txs = [
  { type: 'buy', date: '2023-01-01', shares: 10, price: 100, fees: 0, currency: 'USD' },
  { type: 'buy', date: '2023-06-01', shares: 5, price: 150, fees: 0, currency: 'USD' },
];

const mwr = calculateAllTimeMWR(txs, 2000, 'USD', 1.0);
console.log("MWR:", mwr);

const cashFlows = [
  { date: new Date('2023-01-01'), amount: 1000 },
  { date: new Date('2023-06-01'), amount: 750 },
  { date: new Date('2024-01-01'), amount: -2000 }
];

console.log("XIRR:", calculateXIRR(cashFlows));
