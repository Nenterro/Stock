import { transactionCurrency } from './transactions.js';

/**
 * The CSV contract shared by import, export and the downloadable template.
 *
 * Export writes exactly these columns and the importer reads them, so a file
 * exported from the app can be re-imported without editing - which also makes
 * the export a usable backup.
 */
export const CSV_COLUMNS = [
  'Date',
  'Ticker',
  'Type',
  'Shares',
  'Price',
  'Currency',
  'Fees',
  'Amount',
  'Note'
];

/** Dates are written DD/MM/YYYY, which is what the importer parses. */
function toCsvDate(value) {
  if (!value) return '';
  const s = String(value);
  const iso = /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
  if (iso) {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(dt.getUTCDate())}/${pad(dt.getUTCMonth() + 1)}/${dt.getUTCFullYear()}`;
}

/** Quote a field only when it needs it, and escape embedded quotes. */
function escapeCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns = CSV_COLUMNS) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCell(row[c])).join(','));
  }
  return lines.join('\r\n');
}

/** Map a stored transaction onto the CSV contract. */
export function transactionToCsvRow(tx) {
  const shares = Number(tx.shares) || 0;
  const price = Number(tx.price) || 0;
  const fees = Number(tx.fees) || 0;
  const amount = Number.isFinite(Number(tx.amount)) && Number(tx.amount) !== 0
    ? Number(tx.amount)
    : shares * price;

  return {
    Date: toCsvDate(tx.date),
    Ticker: tx.ticker || '',
    Type: String(tx.type || '').toLowerCase(),
    Shares: shares || '',
    Price: price || '',
    Currency: transactionCurrency(tx),
    Fees: fees || 0,
    Amount: Number(amount.toFixed(4)),
    Note: tx.note || ''
  };
}

export function transactionsToCsv(transactions = []) {
  const rows = [...transactions]
    // Oldest first reads naturally in a spreadsheet.
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
    .map(transactionToCsvRow);
  return toCsv(rows);
}

/**
 * A filled-in example rather than a bare header row, so the expected date
 * format, casing and optional columns are all obvious at a glance.
 */
export function sampleCsv() {
  const rows = [
    {
      Date: '15/03/2026', Ticker: 'OGDC', Type: 'buy', Shares: 100, Price: 273.5,
      Currency: 'PKR', Fees: 86.34, Amount: 27350,
      Note: 'Example row - delete before importing'
    },
    {
      Date: '02/04/2026', Ticker: 'AAPL', Type: 'buy', Shares: 10, Price: 189.25,
      Currency: 'USD', Fees: 1.0, Amount: 1892.5, Note: ''
    },
    {
      Date: '20/05/2026', Ticker: 'AAPL', Type: 'sell', Shares: 4, Price: 205.1,
      Currency: 'USD', Fees: 1.0, Amount: 820.4, Note: ''
    }
  ];
  return toCsv(rows);
}

/** Trigger a browser download of `content` as `filename`. */
export function downloadCsv(filename, content) {
  // A BOM keeps Excel from mangling non-ASCII names.
  const blob = new Blob([`﻿${content}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick so the click has definitely been handled.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}
