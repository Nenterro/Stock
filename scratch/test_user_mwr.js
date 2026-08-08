import { calculateXIRR, calculateAllTimeMWR } from '../src/utils/portfolio_math.js';

const cashFlows = [
  { date: new Date('2026-08-01'), amount: 200.0 },
  { date: new Date('2026-08-06'), amount: -200.0 },
  { date: new Date('2026-08-06'), amount: -2488.0 }
];

console.log("XIRR result:", calculateXIRR(cashFlows));
