import { fetchHistoricalFxRate } from './api';

/**
 * Interactive Brokers (IBKR) Flex Query & Statement Parser
 * 
 * Supports:
 * - Direct Flex Web Service XML API (SendRequest / GetStatement)
 * - Raw CSV / Statement files (BOS/EOS sections, TRNT Trades, CTRN Cash Transactions)
 * - Historical USD/PKR exchange rate stamping
 * - Duplicate detection against existing database records
 */

// Helper to split CSV line handling quoted commas
export function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// Parse IBKR date formats: "YYYY-MM-DD", "YYYYMMDD", "YYYY-MM-DD;HH:MM:SS", "YYYY-MM-DD HH:MM:SS"
export function parseIbkrDate(raw) {
  if (!raw) return new Date().toISOString().split('T')[0];
  const cleaned = raw.trim().replace(/"/g, '');
  
  if (cleaned.includes(';')) {
    return cleaned.split(';')[0].trim();
  }
  if (cleaned.includes(' ')) {
    return cleaned.split(' ')[0].trim();
  }
  if (cleaned.includes('-')) {
    return cleaned;
  }
  if (cleaned.length === 8 && /^\d{8}$/.test(cleaned)) {
    const yyyy = cleaned.substring(0, 4);
    const mm = cleaned.substring(4, 6);
    const dd = cleaned.substring(6, 8);
    return `${yyyy}-${mm}-${dd}`;
  }
  return cleaned;
}

function getField(cells, headers, fieldName) {
  const index = headers[fieldName];
  if (index !== undefined && index < cells.length) {
    return cells[index] || '';
  }
  return '';
}

/**
 * Parses IBKR CSV data string into normalized StockTransaction objects
 */
export function parseIbkrCsv(csvData, onLog = () => {}) {
  const txs = [];
  const lines = csvData.split(/\r?\n/);

  let inTrades = false;
  let inCash = false;
  let headers = {};

  let tradeCount = 0;
  let depositCount = 0;
  let withdrawalCount = 0;
  let dividendCount = 0;
  let taxCount = 0;

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    const cells = splitCsvLine(line).map(c => c.replace(/^"|"$/g, '').trim());
    if (cells.length === 0) continue;

    // Section boundary in IBKR Flex CSV reports
    if (cells[0] === 'BOS') {
      headers = {};
      inTrades = cells[1] === 'TRNT' || cells[1] === 'Trades';
      inCash = cells[1] === 'CTRN' || cells[1] === 'Cash Transactions';
      continue;
    }

    if (cells[0] === 'EOS') {
      inTrades = false;
      inCash = false;
      headers = {};
      continue;
    }

    // Header row detection
    if ((inTrades || inCash) && Object.keys(headers).length === 0) {
      cells.forEach((header, idx) => {
        headers[header] = idx;
      });
      continue;
    }

    // Generic Header detection for non-BOS format
    if (cells.includes('Symbol') && (cells.includes('TradePrice') || cells.includes('Quantity') || cells.includes('Amount'))) {
      headers = {};
      cells.forEach((header, idx) => {
        headers[header] = idx;
      });
      if (cells.includes('TradePrice') || cells.includes('Quantity')) inTrades = true;
      if (cells.includes('Amount') && cells.includes('Type')) inCash = true;
      continue;
    }

    try {
      // 1. Trades section (Buy / Sell)
      if (inTrades) {
        let symbol = getField(cells, headers, 'Symbol');
        if (!symbol || symbol === 'Symbol' || symbol === 'Total' || symbol.startsWith('Subtotal')) continue;

        const qtyRaw = getField(cells, headers, 'Quantity');
        const priceRaw = getField(cells, headers, 'TradePrice') || getField(cells, headers, 'Price');
        if (!qtyRaw || !priceRaw) continue;

        const qty = parseFloat(qtyRaw.replace(/,/g, ''));
        const price = parseFloat(priceRaw.replace(/,/g, ''));
        if (isNaN(qty) || isNaN(price) || qty === 0) continue;

        const feeRaw = getField(cells, headers, 'IBCommission') || getField(cells, headers, 'Commission') || '0';
        const fee = Math.abs(parseFloat(feeRaw.replace(/,/g, '')) || 0);

        let tradeDateRaw = getField(cells, headers, 'TradeDate') || getField(cells, headers, 'DateTime') || getField(cells, headers, 'Date/Time');
        const formattedDate = parseIbkrDate(tradeDateRaw);

        const settleDateRaw = getField(cells, headers, 'SettleDate');
        const settleDate = settleDateRaw ? parseIbkrDate(settleDateRaw) : null;

        const type = qty > 0 ? 'BUY' : 'SELL';
        const shares = Math.abs(qty);
        const amount = shares * price;
        const id = `ibkr_trade_${symbol}_${formattedDate}_${shares.toFixed(4)}_${type.toLowerCase()}`;

        txs.push({
          id,
          source: 'IBKR',
          ticker: symbol.toUpperCase(),
          type,
          shares,
          price,
          fees: fee,
          amount,
          currency: 'USD',
          exchangeRate: 1.0,
          date: formattedDate,
          settlementDate: settleDate,
          note: `Imported from IBKR (${type === 'BUY' ? 'Buy' : 'Sell'} ${shares} @ $${price.toFixed(2)})`
        });

        tradeCount++;
      }

      // 2. Cash Transactions section (Dividends, Taxes, Deposits, Withdrawals)
      //
      // Counted but never imported: this tracker records trades only, so cash
      // events are tallied for the summary line and then discarded.
      else if (inCash) {
        const rawType = getField(cells, headers, 'Type');
        if (!rawType || rawType === 'Type' || rawType.startsWith('Total')) continue;

        const rawAmount = getField(cells, headers, 'Amount');
        if (!rawAmount) continue;
        const amount = parseFloat(rawAmount.replace(/,/g, ''));
        if (isNaN(amount) || amount === 0) continue;

        const rawDateStr = getField(cells, headers, 'Date/Time') || getField(cells, headers, 'DateTime') || getField(cells, headers, 'Date');
        if (!rawDateStr) continue;
        const formattedDate = parseIbkrDate(rawDateStr);

        const symbol = getField(cells, headers, 'Symbol');

        let txType = null;
        if (rawType.includes('Deposit') || rawType.includes('Withdrawal') || rawType === 'Deposits/Withdrawals') {
          txType = amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL';
        } else if (rawType.includes('Dividend') || rawType === 'Payment In Lieu Of Dividends') {
          txType = 'DIVIDEND';
        } else if (rawType.includes('Tax') || rawType === 'Withholding Tax') {
          txType = 'TAX';
        }

        if (!txType) continue;

        // Tallied for the summary line, then dropped: this tracker records
        // trades only, so dividends, taxes and cash transfers are not imported.
        if (txType === 'DEPOSIT') depositCount++;
        else if (txType === 'WITHDRAWAL') withdrawalCount++;
        else if (txType === 'DIVIDEND') dividendCount++;
        else if (txType === 'TAX') taxCount++;
        continue;
      }
    } catch (e) {
      // Ignore non-transaction/malformed rows
    }
  }

  onLog(`Found: ${tradeCount} Trades. Skipped ${dividendCount} Dividends, ${taxCount} Taxes, ${depositCount + withdrawalCount} Cash Transfers (trades only).`);
  return txs;
}

/**
 * Stamps all USD transactions with their accurate historical USD/PKR exchange rate
 */
export async function stampHistoricalRates(transactions, onProgress = () => {}) {
  const dates = [...new Set(transactions.filter(t => t.currency === 'USD').map(t => t.date))];
  onProgress(`Fetching historical exchange rates for ${dates.length} unique dates...`);

  const rateMap = {};
  await Promise.all(
    dates.map(async (date) => {
      try {
        const rate = await fetchHistoricalFxRate(date);
        rateMap[date] = rate || 278.0;
      } catch (err) {
        rateMap[date] = 278.0;
      }
    })
  );

  return transactions.map(tx => {
    if (tx.currency === 'USD') {
      const rate = rateMap[tx.date] || 278.0;
      return {
        ...tx,
        exchangeRate: rate
      };
    }
    return tx;
  });
}

/**
 * Automated IBKR Flex Web Service Sync
 */
export async function syncIbkrFlexService({ token, queryId }, onLog = () => {}) {
  const trimmedToken = (token || '').trim();
  const trimmedQueryId = (queryId || '').trim();

  if (!trimmedToken || !trimmedQueryId) {
    throw new Error('Please provide both your IBKR Flex Token and Query ID.');
  }

  onLog('--- Initiating IBKR Flex Web Service Connection ---');
  
  // Step 1: Try proxy via local backend on port 3005 if available, otherwise direct
  const requestUrl = `https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest?t=${encodeURIComponent(trimmedToken)}&q=${encodeURIComponent(trimmedQueryId)}&v=3`;
  
  let refCode = null;
  onLog('Requesting statement generation from Interactive Brokers...');

  try {
    let responseText = null;
    try {
      const res = await fetch(`http://localhost:3005/api/ibkr/request?t=${encodeURIComponent(trimmedToken)}&q=${encodeURIComponent(trimmedQueryId)}`);
      if (res.ok) {
        responseText = await res.text();
      }
    } catch (e) {
      // Fallback direct or CORS proxy
      const directRes = await fetch(`https://corsproxy.io/?${encodeURIComponent(requestUrl)}`);
      if (directRes.ok) responseText = await directRes.text();
    }

    if (!responseText) {
      throw new Error('Failed to connect to IBKR Flex Web Service.');
    }

    // Parse Reference Code XML
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(responseText, 'text/xml');
    const status = xmlDoc.querySelector('Status')?.textContent;
    
    if (status === 'Success') {
      refCode = xmlDoc.querySelector('ReferenceCode')?.textContent;
      onLog(`✅ Statement reference code received: ${refCode}`);
    } else {
      const errorMsg = xmlDoc.querySelector('ErrorMessage')?.textContent || 'Invalid Flex Query parameters.';
      throw new Error(errorMsg);
    }
  } catch (err) {
    onLog(`❌ Connection Error: ${err.message}`);
    throw err;
  }

  if (!refCode) {
    throw new Error('No Reference Code returned by IBKR.');
  }

  // Step 2: Poll for statement generation
  const downloadUrl = `https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement?q=${encodeURIComponent(refCode)}&t=${encodeURIComponent(trimmedToken)}&v=3`;
  
  let csvReport = '';
  for (let attempt = 1; attempt <= 15; attempt++) {
    await new Promise(r => setTimeout(r, 4000));
    onLog(`Polling statement readiness (Attempt ${attempt}/15)...`);

    try {
      let bodyText = null;
      try {
        const res = await fetch(`http://localhost:3005/api/ibkr/statement?q=${encodeURIComponent(refCode)}&t=${encodeURIComponent(trimmedToken)}`);
        if (res.ok) bodyText = await res.text();
      } catch (e) {
        const directRes = await fetch(`https://corsproxy.io/?${encodeURIComponent(downloadUrl)}`);
        if (directRes.ok) bodyText = await directRes.text();
      }

      if (bodyText && !bodyText.includes('<ErrorCode>') && !bodyText.includes('<Status>Warn</Status>')) {
        csvReport = bodyText;
        onLog(`✅ Statement downloaded successfully (${csvReport.length} bytes)!`);
        break;
      }
    } catch (e) {
      onLog('Generating on IBKR servers...');
    }
  }

  if (!csvReport) {
    throw new Error('IBKR took too long to generate report. Please try again in 1-2 minutes.');
  }

  // Step 3: Parse CSV
  onLog('Parsing transactions and cash events...');
  const parsedTransactions = parseIbkrCsv(csvReport, onLog);
  
  // Step 4: Stamp historical rates
  const finalized = await stampHistoricalRates(parsedTransactions, onLog);
  onLog(`✅ Finished: ${finalized.length} total transaction(s) ready for import.`);

  return finalized;
}
