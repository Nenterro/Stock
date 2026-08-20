'use strict';

const { RequestLane, getJson, getText } = require('../http');

// dps.psx.com.pk is the exchange's own data service: no auth, no throttling
// observed, and authoritative for Pakistani listings.
const lane = new RequestLane({ name: 'psx', minGapMs: 40, concurrency: 6 });

const BASE = 'https://dps.psx.com.pk';

/**
 * The complete PSX listing: ~1000 symbols with sector, ETF and debt flags.
 * This replaces the 176-row hardcoded array the old backend searched against.
 */
async function listSymbols() {
  const data = await getJson(lane, `${BASE}/symbols`, { timeout: 20000, retries: 2 });
  if (!Array.isArray(data) || data.length === 0) return null;

  return data
    .filter((row) => row && row.symbol)
    .map((row) => {
      const symbol = String(row.symbol).toUpperCase();
      let type = 'PSX Stock';
      if (row.isETF) type = 'ETF';
      else if (row.isDebt) type = 'Bond';

      return {
        symbol,
        name: String(row.name || symbol).trim(),
        exchange: 'PSX',
        type,
        currency: 'PKR',
        sector: row.sectorName || null,
        isDebt: Boolean(row.isDebt),
        isETF: Boolean(row.isETF),
        isGEM: Boolean(row.isGEM),
        // Yahoo knows PSX tickers under the .KA suffix.
        yahooSymbol: `${symbol}.KA`,
        source: 'psx'
      };
    });
}

function parseMoney(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const value = parseFloat(cleaned);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Live quote scraped from the exchange's own company page.
 *
 * Yahoo's PSX feed is unreliable - during the audit it reported OGDC at 131.87
 * against a true 319.79 - so PSX is always preferred for Pakistani equities.
 */
async function quote(rawSymbol) {
  const symbol = String(rawSymbol || '')
    .toUpperCase()
    .replace(/\.(KA|PSX)$/i, '')
    .trim();
  if (!symbol) return null;

  const html = await getText(lane, `${BASE}/company/${encodeURIComponent(symbol)}`, {
    timeout: 12000,
    retries: 1
  });
  if (!html) return null;

  const price = parseMoney(html.match(/quote__close[^>]*>\s*Rs\.?\s*([0-9,]+(?:\.[0-9]+)?)/i)?.[1]);
  if (!price) return null;

  // The change block carries a direction class plus absolute and percent values.
  const changeBlock = html.match(/quote__change[\s\S]{0,400}?<\/div>\s*<\/div>/i)?.[0] || '';
  const isNegative = /change__text--neg|--neg/i.test(changeBlock);
  const numbers = [...changeBlock.matchAll(/(-?[0-9,]+(?:\.[0-9]+)?)/g)].map((m) =>
    parseFloat(m[1].replace(/,/g, ''))
  );

  let change = 0;
  let changePercent = 0;
  if (numbers.length >= 2) {
    change = Math.abs(numbers[0]);
    changePercent = Math.abs(numbers[1]);
    if (isNegative) {
      change = -change;
      changePercent = -changePercent;
    }
  }

  const name =
    html.match(/<title>\s*([^<|]+?)\s*(?:\||<)/i)?.[1]?.replace(/\s*-\s*PSX.*$/i, '').trim() || symbol;

  return {
    symbol,
    price,
    previousClose: change ? price - change : price,
    change,
    changePercent,
    currency: 'PKR',
    name,
    exchange: 'PSX',
    source: 'PSX'
  };
}

/**
 * End-of-day history straight from the exchange.
 * Payload rows are [unixSeconds, close, volume, ...].
 */
async function history(rawSymbol) {
  const symbol = String(rawSymbol || '')
    .toUpperCase()
    .replace(/\.(KA|PSX)$/i, '')
    .trim();
  if (!symbol) return null;

  const data = await getJson(lane, `${BASE}/timeseries/eod/${encodeURIComponent(symbol)}`, {
    timeout: 20000,
    retries: 1
  });

  const rows = data?.data;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const seen = new Set();
  const history_ = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const [ts, close] = row;
    if (typeof ts !== 'number' || typeof close !== 'number' || close <= 0) continue;
    const date = new Date(ts * 1000).toISOString().split('T')[0];
    if (seen.has(date)) continue;
    seen.add(date);
    history_.push({ date, price: close, adjClose: close });
  }

  if (history_.length === 0) return null;
  history_.sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    symbol,
    currency: 'PKR',
    exchange: 'PSX',
    history: history_,
    source: 'PSX'
  };
}

module.exports = { listSymbols, quote, history, lane };
