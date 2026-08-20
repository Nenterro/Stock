'use strict';

const http = require('http');
const { URL } = require('url');

const universe = require('./lib/universe');
const searchEngine = require('./lib/search');
const quotes = require('./lib/quotes');
const fx = require('./lib/fx');
const yahoo = require('./lib/providers/yahoo');
const { getText, RequestLane } = require('./lib/http');
const ktrade = require('./lib/ktrade');

const PORT = process.env.PORT || 3005;
const START = Date.now();

const ibkrLane = new RequestLane({ name: 'ibkr', minGapMs: 250, concurrency: 2 });

function send(res, status, payload, contentType = 'application/json') {
  const body = contentType === 'application/json' ? JSON.stringify(payload) : payload;
  res.writeHead(status, {
    'Content-Type': `${contentType}${contentType.startsWith('text') || contentType.includes('xml') ? '; charset=utf-8' : ''}`,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

const routes = new Map();
const route = (path, handler) => routes.set(path, handler);

// --- Search -----------------------------------------------------------------

route('/api/search', async (q, res) => {
  const query = (q.get('q') || q.get('query') || '').trim();
  const limit = Math.min(Math.max(parseInt(q.get('limit') || '25', 10) || 25, 1), 100);
  const includeRemote = q.get('remote') !== '0';

  if (!query) return send(res, 200, []);

  const results = await searchEngine.search(query, { limit, includeRemote });
  return send(res, 200, results);
});

// A curated starting set for the asset picker. Funds are listed by name and
// resolved against the live universe, so the picker can never offer a symbol
// the pricing engine does not recognise.
const POPULAR = [
  { symbol: 'OGDC' },
  { symbol: 'MEBL' },
  { symbol: 'SYS' },
  { symbol: 'LUCK' },
  { name: 'Meezan Islamic Fund' },
  { name: 'Meezan Sovereign Fund' },
  { name: 'UBL Liquidity Plus Fund' },
  { symbol: 'AAPL' },
  { symbol: 'VOO' },
  { symbol: 'SPUS' }
];

route('/api/popular', async (q, res) => {
  const out = [];
  for (const want of POPULAR) {
    const asset = want.symbol
      ? universe.get(want.symbol)
      : searchEngine.localSearch(want.name, 1)[0];
    if (!asset) continue;
    out.push({
      symbol: asset.symbol,
      name: asset.name,
      exchange: asset.exchange || '',
      type: asset.type || 'Stock',
      currency: asset.currency || null
    });
  }
  return send(res, 200, out);
});

// --- Quotes -----------------------------------------------------------------

route('/api/quote', async (q, res) => {
  const symbol = (q.get('symbol') || q.get('s') || '').trim();
  if (!symbol || symbol.toUpperCase() === 'CASH') {
    return send(res, 400, { error: 'Valid symbol required' });
  }

  const quote = await quotes.getQuote(symbol);
  if (quote) return send(res, 200, quote);
  return send(res, 404, { error: `Price not found for ${symbol}` });
});

route('/api/quotes', async (q, res) => {
  const symbols = (q.get('symbols') || q.get('s') || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s.toUpperCase() !== 'CASH');

  if (symbols.length === 0) return send(res, 400, { error: 'symbols parameter required' });

  const results = await quotes.getQuotes(symbols);
  return send(res, 200, { results, count: Object.keys(results).length });
});

// --- History ----------------------------------------------------------------

route('/api/history', async (q, res) => {
  const symbol = (q.get('symbol') || q.get('s') || '').trim();
  const range = (q.get('range') || '5y').trim();
  if (!symbol || symbol.toUpperCase() === 'CASH') {
    return send(res, 400, { error: 'Valid symbol required' });
  }

  const entry = await quotes.getHistory(symbol, range);
  if (entry?.history?.length > 0) return send(res, 200, entry);
  return send(res, 404, { error: `History not found for ${symbol}` });
});

route('/api/history/batch', async (q, res) => {
  const symbols = (q.get('symbols') || q.get('s') || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s.toUpperCase() !== 'CASH');
  const range = (q.get('range') || '5y').trim();

  if (symbols.length === 0) return send(res, 400, { error: 'symbols parameter required' });

  const results = await quotes.getHistoryBatch(symbols, range);
  return send(res, 200, { range, results });
});

// --- FX ---------------------------------------------------------------------

route('/api/rates', async (q, res) => {
  const data = await fx.getRates();
  return send(res, 200, { ...data, timestamp: Date.now() });
});

route('/api/historical-fx', async (q, res) => {
  const date = (q.get('date') || q.get('d') || '').trim();
  const rate = await fx.getHistoricalRate(date);
  return send(res, 200, {
    date: date || new Date().toISOString().split('T')[0],
    base: 'USD',
    target: 'PKR',
    rate
  });
});

route('/api/fx-series', async (q, res) => {
  const series = await fx.getFxSeries();
  return send(res, 200, { base: 'USD', target: 'PKR', series, count: Object.keys(series).length });
});

// --- Diagnostics ------------------------------------------------------------

route('/api/health', async (q, res) =>
  send(res, 200, {
    ok: true,
    uptimeSeconds: Math.round((Date.now() - START) / 1000),
    universe: universe.stats(),
    caches: quotes.stats(),
    yahoo: yahoo.stats()
  })
);

route('/api/universe', async (q, res) => {
  const type = (q.get('type') || '').trim();
  const limit = Math.min(parseInt(q.get('limit') || '0', 10) || 0, 5000);
  let assets = universe.assets;
  if (type) assets = assets.filter((a) => (a.type || '').toLowerCase() === type.toLowerCase());
  return send(res, 200, {
    ...universe.stats(),
    assets: limit ? assets.slice(0, limit) : undefined
  });
});

route('/api/universe/refresh', async (q, res) => {
  const size = await universe.refresh({ force: true });
  return send(res, 200, { ok: true, size, stats: universe.stats() });
});

// --- KTrade (KASB) trade confirmations --------------------------------------

route('/api/ktrade/status', async (q, res) => send(res, 200, await ktrade.status()));

route('/api/ktrade/scan', async (q, res) => {
  const since = (q.get('since') || '').trim() || null;
  const max = Math.min(Math.max(parseInt(q.get('max') || '25', 10) || 25, 1), 100);

  try {
    const result = await ktrade.scan({ since, max });
    return send(res, 200, result);
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED') {
      return send(res, 503, {
        error: 'Gmail is not configured on this server',
        hint: 'Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN, then restart.'
      });
    }
    return send(res, 502, { error: err.message });
  }
});

// Direct upload, so confirmations can be imported without Gmail access at all.
route('/api/ktrade/parse', async (q, res, req) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST a PDF body' });

  const chunks = [];
  let bytes = 0;
  const MAX = 12 * 1024 * 1024;

  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX) return send(res, 413, { error: 'PDF too large' });
      chunks.push(chunk);
    }
  } catch (err) {
    return send(res, 400, { error: `could not read upload: ${err.message}` });
  }

  if (bytes === 0) return send(res, 400, { error: 'empty upload' });

  try {
    const parsed = ktrade.parseConfirmationPdf(Buffer.concat(chunks));
    if (parsed.confirmations.length === 0) {
      return send(res, 422, { error: 'No KTrade confirmation found in that PDF' });
    }
    return send(res, 200, parsed);
  } catch (err) {
    return send(res, 422, { error: `parse failed: ${err.message}` });
  }
});

// --- IBKR passthrough (unchanged behaviour, now rate-limited) ---------------

route('/api/ibkr/request', async (q, res) => {
  const t = (q.get('t') || q.get('token') || '').trim();
  const queryId = (q.get('q') || q.get('queryId') || '').trim();
  if (!t || !queryId) return send(res, 400, { error: 'Token and Query ID are required' });

  const xml = await getText(
    ibkrLane,
    `https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest?t=${encodeURIComponent(t)}&q=${encodeURIComponent(queryId)}&v=3`,
    { timeout: 20000 }
  );
  return send(
    res,
    200,
    xml || '<FlexStatementResponse><Status>Error</Status><ErrorMessage>Failed to reach IBKR</ErrorMessage></FlexStatementResponse>',
    'application/xml'
  );
});

route('/api/ibkr/statement', async (q, res) => {
  const refCode = (q.get('q') || q.get('refCode') || '').trim();
  const t = (q.get('t') || q.get('token') || '').trim();
  if (!refCode || !t) return send(res, 400, { error: 'Reference Code and Token are required' });

  const statement = await getText(
    ibkrLane,
    `https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement?q=${encodeURIComponent(refCode)}&t=${encodeURIComponent(t)}&v=3`,
    { timeout: 30000 }
  );
  return send(res, 200, statement || '', 'text/plain');
});

// --- Server -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  let parsed;
  try {
    parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return send(res, 400, { error: 'Bad request' });
  }

  const handler = routes.get(parsed.pathname.replace(/\/+$/, '') || '/');
  if (!handler) return send(res, 404, { error: 'Endpoint not found' });

  const started = Date.now();
  try {
    await handler(parsed.searchParams, res, req);
  } catch (err) {
    console.error(`[server] ${parsed.pathname} failed:`, err);
    if (!res.headersSent) send(res, 500, { error: 'Internal error' });
  } finally {
    const ms = Date.now() - started;
    if (ms > 2000) console.log(`[slow] ${parsed.pathname}${parsed.search} took ${ms}ms`);
  }
});

server.listen(PORT, async () => {
  console.log(`Stock Tracker API listening on ${PORT}`);

  universe.bootstrap();
  universe.startAutoRefresh();

  // Warm the universe and the Yahoo session without blocking startup.
  universe.refresh().catch((err) => console.warn(`[boot] universe refresh: ${err.message}`));
  yahoo.getCrumb().catch(() => {});
});

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
