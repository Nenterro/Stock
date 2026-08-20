'use strict';

const gmail = require('./gmail');
const { parseConfirmationPdf, classifyDocument } = require('./parse');
const universe = require('../universe');

/**
 * Scan the mailbox for KTrade confirmations and turn them into importable
 * transactions.
 *
 * Nothing here writes to a portfolio: the result is a preview the user
 * confirms. Anything that fails reconciliation or resolves to an unknown
 * ticker is surfaced rather than quietly dropped, because a silently missing
 * trade is worse than a visible one that needs attention.
 */
async function scan({ since = null, max = 25 } = {}) {
  if (!gmail.isConfigured()) {
    const err = new Error('Gmail is not configured on this server');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const ids = await gmail.searchMessages({ since, max });

  const transactions = [];
  const confirmations = [];
  const warnings = [];
  const skipped = [];
  const messages = [];

  for (const id of ids) {
    let msg;
    try {
      msg = await gmail.getMessage(id);
    } catch (err) {
      warnings.push({ messageId: id, issue: `could not read message: ${err.message}` });
      continue;
    }

    const summary = { id, subject: msg.subject, date: msg.date, attachments: [] };

    for (const att of msg.attachments) {
      try {
        const buf = await gmail.getAttachment(id, att.attachmentId);
        if (!buf) {
          warnings.push({ messageId: id, file: att.filename, issue: 'attachment body was empty' });
          continue;
        }

        // Account ledgers are periodic position statements, not trades. The
        // trades they summarise already arrive as their own confirmations, so
        // skipping them is correct - record it as a skip, not a failure.
        const kind = classifyDocument(buf);
        if (kind === 'ledger') {
          skipped.push({ messageId: id, file: att.filename, reason: 'account ledger' });
          summary.attachments.push({ filename: att.filename, skipped: 'account ledger' });
          continue;
        }

        const parsed = parseConfirmationPdf(buf);
        if (parsed.confirmations.length === 0) {
          warnings.push({
            messageId: id,
            file: att.filename,
            issue: 'no trade confirmation found in this PDF'
          });
          continue;
        }

        for (const conf of parsed.confirmations) {
          if (conf.reconciliation.ok === false) {
            warnings.push({
              messageId: id,
              file: att.filename,
              confirmation: conf.confirmation,
              issue:
                `figures do not reconcile: computed ${conf.reconciliation.computedTotal} ` +
                `vs stated ${conf.reconciliation.statedTotal}`
            });
          }
          if (!conf.tradeDate) {
            warnings.push({
              messageId: id,
              file: att.filename,
              confirmation: conf.confirmation,
              issue: 'no trade date could be read'
            });
          }
        }

        confirmations.push(...parsed.confirmations);
        transactions.push(...parsed.transactions.map((t) => ({ ...t, messageId: id, file: att.filename })));
        summary.attachments.push({ filename: att.filename, confirmations: parsed.confirmations.length });
      } catch (err) {
        warnings.push({ messageId: id, file: att.filename, issue: `parse failed: ${err.message}` });
      }
    }

    messages.push(summary);
  }

  // Flag tickers the pricing engine will not be able to value.
  for (const tx of transactions) {
    if (!universe.get(tx.ticker)) {
      warnings.push({ ticker: tx.ticker, issue: `"${tx.ticker}" is not in the asset universe` });
    }
  }

  // The same confirmation can arrive twice (resend, or a daily digest).
  const seen = new Set();
  const unique = transactions.filter((t) => (seen.has(t.id) ? false : seen.add(t.id)));

  return {
    scanned: ids.length,
    skipped,
    messages,
    confirmations,
    transactions: unique,
    warnings
  };
}

async function status() {
  if (!gmail.isConfigured()) {
    return { configured: false, connected: false, mailbox: null, sender: gmail.config().sender };
  }
  try {
    const p = await gmail.profile();
    return {
      configured: true,
      connected: true,
      mailbox: p.emailAddress,
      sender: gmail.config().sender
    };
  } catch (err) {
    return {
      configured: true,
      connected: false,
      error: err.message,
      sender: gmail.config().sender
    };
  }
}

module.exports = { scan, status, parseConfirmationPdf };
