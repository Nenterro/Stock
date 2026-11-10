import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIbkrCsv } from '../src/utils/ibkr_service.js';
import { isExactDuplicate } from '../src/utils/transactions.js';

// 30 Oct 2026: ISWD bought on its GBP line, paid by GBP.USD conversions.
const csv = [
  'BOS,TRNT',
  'Symbol,Description,AssetClass,CurrencyPrimary,Quantity,TradePrice,IBCommission,IBCommissionCurrency,TradeDate',
  'ISDU,ISHARES MSCI USA ISLAMIC,STK,USD,-4,106.32,-1,USD,20261030',
  'GBP.USD,GBP.USD,CASH,USD,514.54,1.3419,0,USD,20261030',
  'GBP.USD,GBP.USD,CASH,USD,3,1.3418,0,USD,20261030',
  'ISWD,ISHARES MSCI WORLD ISLAMIC,STK,GBP,10,51.454,-3,GBP,20261030',
  'EOS,TRNT'
].join('\n');

test('IBKR currency conversions are not imported as holdings', () => {
  const txs = parseIbkrCsv(csv);
  assert.deepEqual(txs.map((t) => t.ticker).sort(), ['ISDU', 'ISWD']);
});

test('a GBP-priced trade is converted to USD at the day\'s conversion rate', () => {
  const iswd = parseIbkrCsv(csv).find((t) => t.ticker === 'ISWD');
  const rate = (514.54 * 1.3419 + 3 * 1.3418) / 517.54;
  assert.equal(iswd.currency, 'USD');
  assert.equal(iswd.nativeCurrency, 'GBP');
  assert.equal(iswd.nativePrice, 51.454);
  assert.ok(Math.abs(iswd.price - 51.454 * rate) < 1e-3);
  assert.ok(Math.abs(iswd.fees - 3 * rate) < 0.01);
});

test('USD trades are unchanged', () => {
  const isdu = parseIbkrCsv(csv).find((t) => t.ticker === 'ISDU');
  assert.equal(isdu.type, 'SELL');
  assert.equal(isdu.price, 106.32);
  assert.equal(isdu.nativePrice, undefined);
});

test('a converted trade still matches its stored record on re-import', () => {
  const iswd = parseIbkrCsv(csv).find((t) => t.ticker === 'ISWD');
  const stored = { ticker: 'ISWD', type: 'BUY', date: '2026-10-30', shares: 10, price: 69.0461, nativePrice: 51.454 };
  assert.ok(isExactDuplicate(iswd, [stored]));
});

test('a foreign trade with no rate is skipped, not imported in the wrong currency', () => {
  const logs = [];
  const txs = parseIbkrCsv(
    'BOS,TRNT\nSymbol,AssetClass,CurrencyPrimary,Quantity,TradePrice,TradeDate\nISWD,STK,GBP,1,51,20261030\nEOS,TRNT',
    (m) => logs.push(m)
  );
  assert.equal(txs.length, 0);
  assert.ok(logs.some((m) => m.includes('Skipped BUY 1 ISWD')));
});
