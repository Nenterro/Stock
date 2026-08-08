export const formatCurrency = (val) => {
  if (val === null || val === undefined || isNaN(val)) return '0.00';
  return Number(val).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
};

export const getCurrencySymbol = (currency) => {
  if (!currency) return '$';
  const c = currency.toUpperCase();
  if (c === 'PKR') return 'Rs ';
  if (c === 'USD') return '$';
  if (c === 'EUR') return '€';
  if (c === 'GBP') return '£';
  return `${c} `;
};
