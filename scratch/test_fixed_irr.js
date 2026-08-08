function solveIrr(cashFlows) {
  if (!cashFlows || cashFlows.length < 2) return 0.0;

  const hasPositive = cashFlows.some(cf => cf.amount > 0);
  const hasNegative = cashFlows.some(cf => cf.amount < 0);
  if (!hasPositive || !hasNegative) return 0.0;

  const sortedFlows = [...cashFlows].sort((a, b) => a.date - b.date);
  const startDate = sortedFlows[0].date;
  const endDate = sortedFlows[sortedFlows.length - 1].date;
  const totalDays = Math.max(1, (endDate - startDate) / (1000 * 60 * 60 * 24));
  const totalYears = totalDays / 365.0;

  // NPV Function
  const npv = (rate) => {
    let sum = 0.0;
    for (const flow of sortedFlows) {
      const days = Math.max(0, (flow.date - startDate) / (1000 * 60 * 60 * 24));
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
      const days = Math.max(0, (flow.date - startDate) / (1000 * 60 * 60 * 24));
      const years = days / 365.0;
      const base = 1.0 + rate;
      if (base <= 0) return 0;
      sum -= years * flow.amount / Math.pow(base, years + 1.0);
    }
    return sum;
  };

  for (const seed of [0.1, 0.5, -0.1, 2.0, 5.0, 10.0]) {
    let rate = seed;
    for (let i = 0; i < 100; i++) {
      const y = npv(rate);
      const dy = dNpv(rate);
      if (Math.abs(dy) < 1e-14) break;
      const step = y / dy;
      rate -= step;
      rate = Math.max(-0.9999, Math.min(rate, 1000.0));
      if (Math.abs(step) < 1e-9) break;
    }
    if (!Number.isNaN(rate) && Number.isFinite(rate) && rate > -0.9999) {
      // If total duration is less than 1 year, annualizing can produce extreme values.
      // If annualized rate is > 500%, or duration < 1 year, we can return unannualized rate:
      // (1 + rate)^totalYears - 1
      if (totalYears < 1.0) {
        const unannualized = (Math.pow(1.0 + rate, totalYears) - 1.0) * 100.0;
        return unannualized;
      }
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

console.log("Fixed solveIrr result:", solveIrr(cashFlows));
