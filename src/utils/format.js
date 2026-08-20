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

/**
 * Display form of an asset symbol.
 *
 * Pakistani mutual funds have no exchange ticker, so their canonical symbol is
 * an acronym plus a tag taken from the fund's own Sarmaaya UUID
 * ("AISF.9B969E"). The tag is what makes the symbol unique and stable - 201 of
 * ~480 funds share an acronym, and AISF alone is claimed by eight - but it is
 * meaningless to a reader, and the fund name shown alongside already tells
 * them which fund it is. So the tag is stripped for display only; the full
 * symbol remains what gets stored and priced.
 *
 * Real exchange suffixes (.NS, .KA, .TO, .SR) are at most two characters and
 * are never stripped.
 */
export const displayTicker = (symbol) => {
  const s = String(symbol || '');
  return s.replace(/\.[0-9A-F]{6}$/i, '');
};
