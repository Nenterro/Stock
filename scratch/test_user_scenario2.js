import { calculateXIRR } from '../src/utils/portfolio_math.js';

const cashFlows = [
  { date: new Date('2025-01-01'), amount: 100000 },  // Buy Stock A for 100k
  { date: new Date('2025-06-01'), amount: -50000 },  // Sell Stock A for 50k
  { date: new Date('2025-07-01'), amount: 140000 },  // Buy Stock B for 140k
  { date: new Date('2026-01-01'), amount: -1000000 } // Current value = 1M
];

const mwr = calculateXIRR(cashFlows);

// Simple net return check:
// Total In = 100k + 140k = 240k
// Total Out = 50k + 1M = 1.05M
// Net Out of Pocket = 240k - 50k = 190k
// Net Gain = 1.05M - 240k = 810k
// Return on 190k net invested = (1.05M - 190k) / 190k = 860k / 190k = +426.31%

console.log("XIRR (MWR) Result:", mwr.toFixed(2) + "%");
