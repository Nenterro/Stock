function solveIrr(cashFlows) {
  if (!cashFlows || cashFlows.length < 2) return 0.0;

  const hasPositive = cashFlows.some(cf => cf.amount > 0);
  const hasNegative = cashFlows.some(cf => cf.amount < 0);
  if (!hasPositive || !hasNegative) return 0.0;

  const sortedFlows = [...cashFlows].sort((a, b) => a.date - b.date);
  const startDate = sortedFlows[0].date;
  const endDate = sortedFlows[sortedFlows.length - 1].date;
  const totalDays = Math.max(0.001, (endDate - startDate) / (1000 * 60 * 60 * 24));
  const totalYears = totalDays / 365.0;

  // NPV Function
  const npv = (rate) => {
    let sum = 0.0;
    for (const flow of sortedFlows) {
      const days = (flow.date - startDate) / (1000 * 60 * 60 * 24);
      const years = days / 365.0;
      const base = 1.0 + rate;
      if (base <= 0) return Number.POSITIVE_INFINITY;
      sum += flow.amount / Math.pow(base, years);
    }
    return sum;
  };

  const dNpv = (rate) => {
    let sum = 0.0;
    for (const flow of sortedFlows) {
      const days = (flow.date - startDate) / (1000 * 60 * 60 * 24);
      const years = days / 365.0;
      const base = 1.0 + rate;
      if (base <= 0) return 0;
      sum -= years * flow.amount / Math.pow(base, years + 1.0);
    }
    return sum;
  };

  for (const seed of [0.1, 0.5, -0.1, 2.0, 50.0, 100.0]) {
    let rate = seed;
    for (let i = 0; i < 200; i++) {
      const y = npv(rate);
      const dy = dNpv(rate);
      if (Math.abs(dy) < 1e-14) break;
      const step = y / dy;
      rate -= step;
      if (rate <= -0.9999) rate = -0.9999;
      if (Math.abs(step) < 1e-9) break;
    }
    console.log(`Seed ${seed} -> converged rate:`, rate, "NPV at rate:", npv(rate));
    if (!Number.isNaN(rate) && Number.isFinite(rate) && rate > -0.9999) {
      return rate * 100.0;
    }
  }
  return 0.0;
}

const cashFlows = [
  { date: new Date('2026-08-01'), amount: 200.0 },
  { date: new Date('2026-08-06'), amount: -200.0 },
  { date: new Date('2026-08-06'), amount: -2488.0 }
];

console.log("IRR result:", solveIrr(cashFlows));
