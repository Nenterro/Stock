/**
 * Cross-source transaction identity.
 *
 * Each importer used to run its own duplicate rule, and each one leaned on
 * fields that are not comparable between brokers:
 *
 *   - `id` is source-scoped (`ibkr_trade_...` vs `ktrade_...`), so the same
 *     trade from two sources never matched on it.
 *   - `amount` is computed differently per source - KTrade reports gross
 *     (shares x rate) while other exports report the net settlement figure.
 *     For one real trade those differ by the brokerage, which is far more than
 *     the 1-unit tolerance the old check allowed, so it declared them distinct.
 *
 * A trade's identity is the facts the market recorded: which security, which
 * side, on which day, how many shares, at what price. Fingerprinting exactly
 * those makes the same fill import-once regardless of where it came from.
 */

/** Calendar day, tolerant of 'YYYY-MM-DD', ISO timestamps and Date objects. */
export function toDayString(value) {
  if (!value) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);

  const s = String(value).trim();
  // Already a plain calendar date - take it as written rather than pushing it
  // through Date(), which would shift it by the local timezone offset.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** Round to a fixed precision so 177 and 177.0000001 compare equal. */
function quantise(value, decimals) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(decimals);
}

/**
 * Stable identity for one trade, independent of which importer produced it.
 * Ticker is upper-cased and stripped of any exchange suffix so the same
 * security matches whether a source wrote `HBL` or `HBL.KA`.
 */
export function transactionFingerprint(tx) {
  if (!tx) return '';
  const ticker = String(tx.ticker || tx.asset || '')
    .trim()
    .toUpperCase()
    .replace(/\.(KA|PSX|L|NS|BO|TO|AX|HK|SR|AE)$/, '');
  const type = String(tx.type || '').trim().toUpperCase();
  const day = toDayString(tx.date);

  return [ticker, type, day, quantise(tx.shares, 4), quantise(tx.price, 4)].join('|');
}

/**
 * Index existing transactions by fingerprint, for O(1) duplicate checks
 * instead of rescanning the whole list per candidate.
 */
export function buildFingerprintIndex(transactions = []) {
  const index = new Set();
  for (const tx of transactions) {
    const fp = transactionFingerprint(tx);
    if (fp) index.add(fp);
  }
  return index;
}

/**
 * Is this transaction already recorded?
 *
 * `existing` may be a Set from buildFingerprintIndex or a raw array. Source
 * ids are still honoured as a fast path, but they are never required.
 */
export function isExactDuplicate(tx, existing) {
  const fp = transactionFingerprint(tx);
  if (!fp) return false;

  if (existing instanceof Set) return existing.has(fp);

  return (existing || []).some(
    (ex) => (ex.id && tx.id && ex.id === tx.id) || transactionFingerprint(ex) === fp
  );
}

/**
 * Split a candidate batch into what is new and what is already held.
 *
 * Duplicates *within* the batch are caught too: importing the same statement
 * twice in one pass, or a broker resending a confirmation, would otherwise
 * slip through because neither copy is in the portfolio yet.
 */
export function partitionNewTransactions(candidates = [], existingTransactions = []) {
  const index = buildFingerprintIndex(existingTransactions);
  const fresh = [];
  const duplicates = [];

  for (const tx of candidates) {
    const fp = transactionFingerprint(tx);
    if (!fp || index.has(fp)) {
      duplicates.push(tx);
    } else {
      index.add(fp);
      fresh.push(tx);
    }
  }

  return { fresh, duplicates };
}

/**
 * A transaction's currency, inferring one when an older record was saved
 * without it. PSX tickers and Pakistani fund symbols are PKR; everything else
 * defaults to USD, which is what the importers write.
 */
export function transactionCurrency(tx) {
  const explicit = String(tx?.currency || '').trim().toUpperCase();
  if (explicit) return explicit;

  const ticker = String(tx?.ticker || '').trim().toUpperCase();
  if (/\.(KA|PSX)$/.test(ticker)) return 'PKR';
  // Fund symbols are "<ACRONYM>.<6 hex>" and are always PKR-denominated.
  if (/^[A-Z0-9]{2,8}\.[0-9A-F]{6}$/.test(ticker)) return 'PKR';
  return 'USD';
}
