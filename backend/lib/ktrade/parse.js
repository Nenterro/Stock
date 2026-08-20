'use strict';

const { readPages } = require('./pdf');

/**
 * Parser for KTrade Securities (KASB) daily trade confirmations.
 *
 * One PDF holds one confirmation per page - a page is either a PURCHASE or a
 * SALE, and can list several securities. Values are read out of the rebuilt
 * table rows rather than by scanning free text, because the underlying PDF
 * places labels and values independently.
 */

const NUM = /^-?[\d,]+(?:\.\d+)?$/;

function toNumber(text) {
  if (typeof text !== 'string' || !NUM.test(text.trim())) return null;
  const n = parseFloat(text.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * KTrade prints dates as DD/MM/YYYY.
 *
 * Confirmed by the settlement date rather than assumed: these are T+1 trades,
 * and 01/07/2026 settling 02/07/2026 only works as 1 July -> 2 July. Read as
 * MM/DD it would be 7 January settling 2 February, a month backwards.
 */
function parseDate(text) {
  const m = String(text || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const day = Number(dd);
  const month = Number(mm);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${yyyy}-${mm}-${dd}`;
}

function rowText(row) {
  return row.cells.map((c) => c.text).join(' ');
}

/** Value drawn to the right of a label on the same row. */
function valueRightOf(rows, labelRe) {
  for (const row of rows) {
    const idx = row.cells.findIndex((c) => labelRe.test(c.text));
    if (idx === -1) continue;
    for (let i = idx + 1; i < row.cells.length; i += 1) {
      const t = row.cells[i].text.trim();
      if (t) return t;
    }
  }
  return null;
}

function labelledNumber(rows, labelRe) {
  const raw = valueRightOf(rows, labelRe);
  return raw === null ? null : toNumber(raw);
}

/**
 * A trade line: "HBL - HABIB BANK LIMITED" followed by the numeric columns
 * quantity, market rate, gross, commission/share, net rate, brokerage, amount.
 */
function parseTradeRow(row) {
  const cells = row.cells;
  if (cells.length < 6) return null;

  const nameCell = cells[0].text.trim();
  const nameMatch = nameCell.match(/^([A-Z0-9._-]{2,20})\s*-\s*(.+)$/);
  if (!nameMatch) return null;

  const numbers = cells.slice(1).map((c) => toNumber(c.text)).filter((n) => n !== null);
  if (numbers.length < 6) return null;

  const [quantity, marketRate, gross, commissionPerShare, netRate, brokerage, amount] = numbers;
  if (!(quantity > 0) || !(marketRate > 0)) return null;

  return {
    symbol: nameMatch[1].toUpperCase(),
    name: nameMatch[2].trim(),
    quantity,
    marketRate,
    gross,
    commissionPerShare,
    netRate,
    brokerage: brokerage ?? 0,
    amount: amount ?? null
  };
}

/** Parse a single confirmation page. */
function parsePage(rows) {
  const text = rows.map(rowText).join('\n');

  const kindMatch = text.match(/\b(SALE|PURCHASE)\s+CONFIRMATION\b/i);
  if (!kindMatch) return null;

  const side = kindMatch[1].toUpperCase() === 'SALE' ? 'SELL' : 'BUY';
  const confirmation =
    (text.match(/\b(?:SALE|PURCHASE)\s+CONFIRMATION\s+(\d{4,})/i) || [])[1] || null;

  const tradeDate = parseDate(valueRightOf(rows, /^Trade Date:?$/i));
  const settlementDate = parseDate(valueRightOf(rows, /^Settlement Date:?$/i));
  const clientCode = valueRightOf(rows, /^Client Code:?$/i);

  // Charges. A sale carries WHT, a purchase carries CVT; both carry SST.
  const sst = labelledNumber(rows, /^SST$/i) || 0;
  const wht = labelledNumber(rows, /^WHT$/i) || 0;
  const cvt = labelledNumber(rows, /^CVT$/i) || 0;
  const grandTotal = labelledNumber(rows, /^G\s*R\s*A\s*N\s*D\s*T\s*O\s*T\s*A\s*L$/i);

  const trades = [];
  for (const row of rows) {
    // The TOTAL row repeats the same figures; it is a summary, not a trade.
    if (/^TOTAL$/i.test(row.cells[0]?.text?.trim() || '')) continue;
    const trade = parseTradeRow(row);
    if (trade) trades.push(trade);
  }

  if (trades.length === 0) return null;

  // SST/WHT/CVT are charged per confirmation, so split them across the trades
  // in proportion to gross value rather than attributing them to the first row.
  const grossTotal = trades.reduce((sum, t) => sum + (t.gross || 0), 0);
  const taxes = sst + wht + cvt;

  // Independently recompute what the broker says the settlement amount is.
  // A buy adds costs to the gross, a sale nets them off. If this disagrees
  // with the printed GRAND TOTAL, the parse is wrong somewhere and the caller
  // must not silently book bad numbers into a portfolio.
  const brokerageTotal = trades.reduce((sum, t) => sum + (t.brokerage || 0), 0);
  const expected =
    side === 'BUY' ? grossTotal + brokerageTotal + taxes : grossTotal - brokerageTotal - taxes;
  const reconciles =
    grandTotal === null ? null : Math.abs(expected - grandTotal) < 0.05;

  return {
    side,
    confirmation,
    tradeDate,
    settlementDate,
    clientCode,
    charges: { sst, wht, cvt, grandTotal },
    reconciliation: {
      grossTotal: Number(grossTotal.toFixed(2)),
      brokerageTotal: Number(brokerageTotal.toFixed(2)),
      taxes: Number(taxes.toFixed(2)),
      computedTotal: Number(expected.toFixed(2)),
      statedTotal: grandTotal,
      ok: reconciles
    },
    trades: trades.map((t) => {
      const share = grossTotal > 0 ? (t.gross || 0) / grossTotal : 1 / trades.length;
      return { ...t, taxes: taxes * share };
    })
  };
}

/**
 * Convert confirmations into the app's transaction shape.
 *
 * `price` is the market rate with costs kept separately in `fees`, matching how
 * the IBKR importer records trades so cost basis stays comparable across
 * brokers.
 */
function toTransactions(confirmations) {
  const out = [];

  for (const conf of confirmations) {
    for (const t of conf.trades) {
      const fees = (t.brokerage || 0) + (t.taxes || 0);
      const id = `ktrade_${conf.confirmation || conf.tradeDate}_${t.symbol}_${conf.side.toLowerCase()}_${t.quantity}`;

      out.push({
        id,
        source: 'KTrade',
        ticker: t.symbol,
        assetName: t.name,
        type: conf.side,
        shares: t.quantity,
        price: t.marketRate,
        fees: Number(fees.toFixed(2)),
        amount: Number((t.quantity * t.marketRate).toFixed(2)),
        currency: 'PKR',
        exchangeRate: 1.0,
        date: conf.tradeDate,
        settlementDate: conf.settlementDate,
        confirmation: conf.confirmation,
        note: `Imported from KTrade (${conf.side === 'BUY' ? 'Buy' : 'Sell'} ${t.quantity} ${t.symbol} @ Rs ${t.marketRate})`
      });
    }
  }

  return out;
}

/**
 * What kind of KTrade document this is.
 *
 * The broker also mails "Client Account Ledgers" (filenames like EQTL...),
 * which are periodic position statements. They must NOT be parsed as trades -
 * the trades they summarise already arrive as individual confirmations, so
 * reading them would double-count. Recognising them explicitly keeps a correct
 * skip from being reported as a parse failure.
 */
function classifyDocument(buf) {
  const text = readPages(buf)
    .map((p) => p.rows.map(rowText).join(' '))
    .join(' ');

  if (/Client\s+Account\s+Ledgers?/i.test(text)) return 'ledger';
  if (/\b(SALE|PURCHASE)\s+CONFIRMATION\b/i.test(text)) return 'confirmation';
  return 'unknown';
}

/** Parse a confirmation PDF buffer into { confirmations, transactions }. */
function parseConfirmationPdf(buf) {
  const confirmations = readPages(buf)
    .map((page) => parsePage(page.rows))
    .filter(Boolean);

  return { confirmations, transactions: toTransactions(confirmations) };
}

module.exports = { parseConfirmationPdf, parsePage, parseDate, toTransactions, classifyDocument };
