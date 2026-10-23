import test from 'node:test';
import assert from 'node:assert/strict';
import { dividendEntries, matchPayee, grossUp, toTrackerTransactions } from '../src/utils/budgetDividends.js';

const trades = [
  { type: 'BUY', ticker: 'MZNPETF', assetName: 'MEEZAN PAKISTAN EXC', currency: 'PKR', date: '2026-03-05', shares: 1000 },
  { type: 'SELL', ticker: 'MZNPETF', assetName: 'MEEZAN PAKISTAN EXC', currency: 'PKR', date: '2026-03-24', shares: 1000 },
  { type: 'BUY', ticker: 'MEBL', assetName: 'MEEZAN BANK LTD', currency: 'PKR', date: '2026-06-09', shares: 102 },
  { type: 'BUY', ticker: 'FFC', assetName: 'FAUJI FERTILIZER COMPANY', currency: 'PKR', date: '2026-06-09', shares: 176 },
  { type: 'BUY', ticker: 'HBL', assetName: 'HABIB BANK LIMITED', currency: 'PKR', date: '2026-06-09', shares: 177 },
  { type: 'BUY', ticker: 'EOG', assetName: 'EOG Resources', currency: 'USD', date: '2026-10-23', shares: 1 }
];

test('dividendEntries keeps income in the dividend category only', () => {
  const rows = dividendEntries([
    { id: 'a', type: 1, amount: 2009, category: 'Dividends', payee: 'FFC', currency: 'PKR', date: '2026-09-08T00:00:00.000Z' },
    { id: 'b', type: 1, amount: 1081, category: 'dividends ', payee: 'Meezan', currency: 'PKR', date: '2026-08-31T00:00:00.000Z' },
    { id: 'c', type: 0, amount: -500, category: 'Dividends', payee: 'Fee', currency: 'PKR', date: '2026-08-01' },
    { id: 'd', type: 1, amount: 90000, category: 'Salary', payee: 'Work', currency: 'USD', date: '2026-08-01' }
  ]);
  assert.deepEqual(rows.map((r) => [r.budgetId, r.date, r.payee, r.net]), [
    ['b', '2026-08-31', 'Meezan', 1081],
    ['a', '2026-09-08', 'FFC', 2009]
  ]);
});

test('matchPayee: exact ticker, and a shared name resolved by what was held', () => {
  assert.equal(matchPayee('FFC', '2026-09-08', trades), 'FFC');
  // Both MEBL and MZNPETF start with MEEZAN; only MEBL was held in August.
  assert.equal(matchPayee('Meezan', '2026-08-31', trades), 'MEBL');
  // In April it's MZNPETF that was held (sold 24 Mar, inside the window).
  assert.equal(matchPayee('Meezan', '2026-04-15', trades), 'MZNPETF');
  assert.equal(matchPayee('Habib', '2026-08-31', trades), 'HBL');
  assert.equal(matchPayee('Unknown Co', '2026-08-31', trades), null);
  // USD holdings aren't candidates for a PKR payout.
  assert.equal(matchPayee('EOG', '2026-10-24', trades), null);
  assert.equal(matchPayee('meezan', '2026-08-31', trades, { mappings: { MEEZAN: 'MZNPETF' } }), 'MZNPETF');
});

test('grossUp reverses 15% withholding', () => {
  assert.deepEqual(grossUp(2009, 0.15), { gross: 2363.53, tax: 354.53 });
  assert.deepEqual(grossUp(1000, 0), { gross: 1000, tax: 0 });
});

test('toTrackerTransactions: gross dividend plus negative tax', () => {
  const [div, tax] = toTrackerTransactions({ date: '2026-08-31', payee: 'Meezan', net: 1081, currency: 'PKR' }, 'MEBL', { portfolio: 'Pakistan' });
  assert.equal(div.type, 'DIVIDEND');
  assert.equal(div.amount, 1271.76);
  assert.equal(tax.type, 'TAX');
  assert.equal(tax.amount, -190.76);
  assert.equal(div.portfolio, 'Pakistan');
  assert.equal(toTrackerTransactions({ date: '2026-08-31', payee: 'X', net: 50, currency: 'PKR' }, 'X', { withholding: 0 }).length, 1);
});
