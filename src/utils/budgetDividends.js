/**
 * PSX dividends from the budget app.
 *
 * KTrade's contract notes carry no dividends, but the user logs every payout
 * that lands in the bank in the budget app: an income entry in a "Dividends"
 * category, payee = the company as they think of it ("FFC", "Meezan"), amount
 * = what actually arrived, i.e. net of withholding tax. This turns those into
 * the tracker's own records: a gross DIVIDEND plus the withholding as TAX,
 * the same shape the IBKR import produces.
 */
import { toDayString } from './transactions.js';

export const DEFAULT_CATEGORY = 'Dividends';
// PSX withholding on dividends for Active Taxpayer List filers.
export const DEFAULT_WITHHOLDING = 0.15;
// Payouts land a few weeks after the entitlement date, so a stock sold in the
// meantime still pays. Look back this far for a holding.
const HELD_WINDOW_DAYS = 75;

const DAY_MS = 86400000;
const round2 = (n) => Math.round(n * 100) / 100;
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Income entries in the budget's dividend category, oldest first. */
export function dividendEntries(budgetTxs = [], category = DEFAULT_CATEGORY) {
  const want = String(category || '').trim().toLowerCase();
  return budgetTxs
    .filter((t) => String(t.category || '').trim().toLowerCase() === want)
    // Income only: expenses are stored negative and transfers are type 2.
    .filter((t) => Number(t.amount) > 0 && t.type !== 2 && t.type !== 'transfer')
    .map((t) => ({
      budgetId: t.id,
      date: toDayString(t.date),
      payee: String(t.payee || '').trim(),
      net: Number(t.amount),
      currency: String(t.currency || 'PKR').toUpperCase(),
      note: t.note || ''
    }))
    .filter((e) => e.date && e.payee)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Shares of `ticker` held at the start of `day` (trades dated before it). */
function sharesBefore(trades, day) {
  let n = 0;
  for (const t of trades) {
    if (toDayString(t.date) >= day) continue;
    const type = String(t.type || '').toUpperCase();
    const s = Number(t.shares) || 0;
    if (type === 'BUY') n += s;
    else if (type === 'SELL') n -= s;
  }
  return n;
}

/** Was any of `ticker` held during the window ending on the payment date? */
function heldAround(trades, payDay) {
  const from = new Date(Date.parse(`${payDay}T00:00:00Z`) - HELD_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  if (sharesBefore(trades, from) > 1e-6) return true;
  return trades.some((t) => String(t.type || '').toUpperCase() === 'BUY' && toDayString(t.date) >= from && toDayString(t.date) <= payDay);
}

/**
 * The stock a budget payee most likely is: a saved mapping first, then an
 * exact ticker, then a company name starting with the payee - narrowed to
 * what was actually held around the payment date ("Meezan" is both MEBL and
 * MZNPETF; only one of them was held). Null when it stays ambiguous.
 */
export function matchPayee(payee, payDay, stockTxs = [], { currency = 'PKR', mappings = {} } = {}) {
  const key = norm(payee);
  if (!key) return null;
  if (mappings[key]) return mappings[key];

  const byTicker = new Map();
  for (const t of stockTxs) {
    const type = String(t.type || '').toUpperCase();
    if (type !== 'BUY' && type !== 'SELL') continue;
    if (String(t.currency || '').toUpperCase() !== currency) continue;
    const ticker = String(t.ticker || '').toUpperCase();
    if (!ticker) continue;
    if (!byTicker.has(ticker)) byTicker.set(ticker, { ticker, name: norm(t.assetName), trades: [] });
    byTicker.get(ticker).trades.push(t);
  }

  const all = [...byTicker.values()];
  const exact = all.filter((c) => c.ticker === key);
  const named = all.filter((c) => c.name === key || c.name.startsWith(`${key} `) || ` ${c.name} `.includes(` ${key} `));
  for (const pool of [exact, named]) {
    const held = pool.filter((c) => heldAround(c.trades, payDay));
    if (held.length === 1) return held[0].ticker;
    if (!held.length && pool.length === 1) return pool[0].ticker;
  }
  return null;
}

/**
 * Is this payout already in the tracker? A dividend for the same stock within
 * a month counts: one logged by hand on the entitlement date and the bank's
 * payment date weeks later are the same payout, and PSX companies pay at most
 * quarterly.
 */
export function alreadyRecorded(entry, ticker, stockTxs = []) {
  if (!ticker) return false;
  const at = Date.parse(`${entry.date}T00:00:00Z`);
  return stockTxs.some((t) =>
    String(t.type || '').toUpperCase() === 'DIVIDEND' &&
    String(t.ticker || '').toUpperCase() === ticker &&
    Math.abs(Date.parse(`${toDayString(t.date)}T00:00:00Z`) - at) <= 31 * DAY_MS
  );
}

/** Gross dividend and withholding from the net amount that arrived. */
export function grossUp(net, withholding = DEFAULT_WITHHOLDING) {
  const rate = Math.min(Math.max(Number(withholding) || 0, 0), 0.9);
  const gross = round2(net / (1 - rate));
  return { gross, tax: round2(gross - net) };
}

/** The tracker records for one budget entry: DIVIDEND (gross) and, if any, TAX. */
export function toTrackerTransactions(entry, ticker, { withholding = DEFAULT_WITHHOLDING, assetName, portfolio, fxRateOnDate } = {}) {
  const { gross, tax } = grossUp(entry.net, withholding);
  const base = {
    ticker,
    assetName: assetName || ticker,
    date: entry.date,
    currency: entry.currency,
    portfolio,
    fxRateOnDate,
    shares: 0,
    price: 0,
    fees: 0,
    source: 'Budget'
  };
  const out = [{ ...base, type: 'DIVIDEND', amount: gross, notes: `From budget app: ${entry.payee} ${entry.net} received` }];
  if (tax > 0) out.push({ ...base, type: 'TAX', amount: -tax, notes: `Withholding ${Math.round(withholding * 100)}% on ${entry.payee} dividend` });
  return out;
}
