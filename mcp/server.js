#!/usr/bin/env node
/**
 * Stock Tracker MCP server.
 *
 * Gives Claude (Claude Code, or any MCP client) read access to the portfolio
 * and market data, and write access to the parts of the app meant for it:
 * saved analyses (Insights), the watchlist, target allocation, notes, and
 * fund/fundamentals overrides. Transaction writes are off unless
 * ALLOW_TRANSACTION_WRITES=true, and even then preview before committing.
 *
 * Conventions in every response: ratios/returns/weights are fractions
 * (0.12 = 12%), money is in the requested display currency unless a field
 * says `native`, and missing data is null rather than 0.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { config, ENV_FILE } from './lib/config.js';
import { api } from './lib/api.js';
import * as store from './lib/store.js';
import * as pf from './lib/portfolio.js';
import { planContribution } from '../src/utils/portfolio_analytics.js';
import { buildInputs, runModels } from '../src/utils/models/pipeline.js';
import { DEFAULT_SLEEVES } from '../src/utils/models/construct.js';

const server = new McpServer({ name: 'stock-tracker', version: '1.0.0' });

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Round numbers so responses stay readable and cheap; keep nulls. */
function compact(value) {
  return JSON.parse(
    JSON.stringify(value, (k, v) => {
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) return null;
        if (Number.isInteger(v)) return v;
        const a = Math.abs(v);
        return a >= 1000 ? Math.round(v * 100) / 100 : Number(v.toPrecision(5));
      }
      if (v instanceof Set) return [...v];
      return v;
    })
  );
}

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(compact(data), null, 1) }] });
const fail = (message) => ({ content: [{ type: 'text', text: `Error: ${message}` }], isError: true });

function tool(name, def, handler) {
  server.registerTool(name, def, async (args) => {
    try {
      return await handler(args || {});
    } catch (err) {
      return fail(err.message || String(err));
    }
  });
}

const currency = z.enum(['USD', 'PKR']).default('USD').describe('Display currency for money values');
const portfolioArg = z.string().optional().describe('Restrict to one portfolio by name (as shown in the app); omit for all');
const symbolArg = z.string().describe('Ticker as used in the app, e.g. OGDC (PSX), AAPL, ISDE, MZNPETF, KSE100');

const today = () => new Date().toISOString().slice(0, 10);

/* -------------------------------------------------------------------------- */
/* Status                                                                     */
/* -------------------------------------------------------------------------- */

tool(
  'stock_status',
  {
    title: 'Connection status',
    description: 'Check what the Stock Tracker tools can reach: PocketBase login, E2EE state, backend health, screener freshness and whether writes are enabled. Call this first if anything else fails.',
    inputSchema: {}
  },
  async () => {
    const out = { config: { envFile: ENV_FILE, transactionWrites: config.allowTransactionWrites, backendWriteToken: Boolean(config.stockApiToken) } };
    try {
      out.pocketbase = { ok: true, ...(await store.whoami()) };
    } catch (err) {
      out.pocketbase = { ok: false, error: err.message };
    }
    try {
      const h = await api.health();
      out.backend = { ok: true, universe: h?.universe?.total, screener: h?.screener, writesEnabled: h?.writesEnabled };
    } catch (err) {
      out.backend = { ok: false, error: err.message };
    }
    return ok(out);
  }
);

/* -------------------------------------------------------------------------- */
/* Portfolio                                                                  */
/* -------------------------------------------------------------------------- */

tool(
  'get_portfolio',
  {
    title: 'Current holdings',
    description:
      'Current positions on average-cost basis (same method as the Portfolio page): shares, average cost, cost basis, live price, market value, weight, unrealised/realised P&L, dividends. Cost is converted at each trade date\'s FX rate; value at today\'s rate.',
    inputSchema: { currency, portfolio: portfolioArg, includeClosed: z.boolean().default(false).describe('Also list fully sold positions') }
  },
  async ({ currency: ccy, portfolio, includeClosed }) => {
    const p = await pf.positions({ currency: ccy, portfolio });
    const { livePrices, ...rest } = p;
    if (!includeClosed) delete rest.closed;
    return ok(rest);
  }
);

tool(
  'get_xray',
  {
    title: 'Portfolio X-ray',
    description:
      'Full portfolio analysis: positions, look-through exposure (funds unpacked to companies, sectors, countries, asset classes; overlaps between direct holdings and funds; an explicit Unknown share for undisclosed fund holdings), concentration (top-N, HHI, effective N), currency exposure, risk (volatility, drawdown, Sharpe, Sortino; since inception and 1y), comparison with KSE-100, KMI-30 and S&P 500 (returns in the display currency, beta, correlation, alpha, tracking error), holding correlations, dividend income, fund fee drag, Shariah share and data-quality warnings. Use `sections` to limit the output.',
    inputSchema: {
      currency,
      portfolio: portfolioArg,
      sections: z
        .array(z.enum(['positions', 'lookThrough', 'concentration', 'currencyExposure', 'risk', 'benchmarks', 'correlations', 'income', 'fees', 'shariah', 'warnings']))
        .optional()
        .describe('Only return these sections (default: all)')
    }
  },
  async ({ currency: ccy, portfolio, sections }) => {
    const x = await pf.xray({ currency: ccy, portfolio });
    // The full company list includes every fund constituent; the top 25 plus
    // the overlaps carry the signal, and keep the response a sane size.
    const lt = x.lookThrough;
    const trimmed = {
      ...x,
      positions: { totals: x.positions.totals, holdings: x.positions.holdings },
      lookThrough: {
        total: lt.total,
        disclosedShare: lt.disclosedShare,
        topCompanies: lt.topCompanies,
        overlaps: lt.overlaps,
        undisclosed: lt.companies.filter((c) => c.undisclosed),
        sectors: lt.sectors,
        countries: lt.countries,
        assetClasses: lt.assetClasses,
        funds: lt.funds
      }
    };
    if (!sections?.length) return ok(trimmed);
    const out = { asOf: x.asOf, displayCurrency: x.displayCurrency, fxRate: x.fxRate };
    for (const s of sections) out[s] = trimmed[s];
    return ok(out);
  }
);

tool(
  'get_performance',
  {
    title: 'Performance over time',
    description: 'Portfolio value, cost basis, P&L and cumulative TWR/MWR over time (month-end points by default), with a summary including annualised MWR (XIRR).',
    inputSchema: {
      currency,
      portfolio: portfolioArg,
      interval: z.enum(['daily', 'weekly', 'monthly']).default('monthly')
    }
  },
  async (args) => ok(await pf.performance(args))
);

tool(
  'get_transactions',
  {
    title: 'Transactions',
    description: 'The raw transaction log (BUY, SELL, DIVIDEND, TAX), newest first, with optional filters.',
    inputSchema: {
      ticker: z.string().optional(),
      type: z.enum(['BUY', 'SELL', 'DIVIDEND', 'TAX']).optional(),
      from: z.string().optional().describe('YYYY-MM-DD inclusive'),
      to: z.string().optional().describe('YYYY-MM-DD inclusive'),
      portfolio: portfolioArg,
      limit: z.number().int().min(1).max(1000).default(200)
    }
  },
  async ({ ticker, type, from, to, portfolio, limit }) => {
    let txs = await pf.transactions({ portfolio });
    if (ticker) txs = txs.filter((t) => String(t.ticker || '').toUpperCase() === ticker.toUpperCase());
    if (type) txs = txs.filter((t) => String(t.type || '').toUpperCase() === type);
    if (from) txs = txs.filter((t) => String(t.date).slice(0, 10) >= from);
    if (to) txs = txs.filter((t) => String(t.date).slice(0, 10) <= to);
    txs.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const rows = txs.slice(0, limit).map(({ _created, _updated, pendingSync, updatedAt, ...t }) => t);
    return ok({ total: txs.length, returned: rows.length, transactions: rows });
  }
);

/* -------------------------------------------------------------------------- */
/* Market data and research                                                   */
/* -------------------------------------------------------------------------- */

tool(
  'get_fundamentals',
  {
    title: 'Fundamentals',
    description:
      'Normalised fundamentals for a stock or ETF: profile (sector, industry, country, Shariah flag, description), valuation (P/E, forward P/E, P/B, P/S, PEG, EV/EBITDA, dividend yield, 52w range), per-share, profitability, growth, balance-sheet health, ownership, analyst views, events, multi-year annual and quarterly results, and recent exchange announcements with PDF links (PSX). `gaps` lists what the source cannot provide; `sources` says where each block came from. PSX data comes from the exchange and Sarmaaya; everything else from Yahoo, with justETF for UCITS ETFs.',
    inputSchema: { symbol: symbolArg }
  },
  async ({ symbol }) => {
    const f = await api.fundamentals(symbol);
    return f ? ok(f) : fail(`No fundamentals found for ${symbol}`);
  }
);

tool(
  'get_technicals',
  {
    title: 'Technical indicators',
    description:
      'Technicals from daily closes: trend, SMA 20/50/200 and the 200-day slope, RSI(14), MACD, Bollinger %B, 52-week range position, returns (1w to 5y, annualised 3y/5y), volatility, drawdowns, beta and correlation vs the market benchmark (KSE-100 for PSX, S&P 500 otherwise, or `benchmark`), volume trend, and named signals.',
    inputSchema: { symbol: symbolArg, benchmark: z.string().optional().describe('Override benchmark, e.g. KMI30 or ^GSPC') }
  },
  async ({ symbol, benchmark }) => {
    const t = await api.technicals(symbol, benchmark);
    return t ? ok(t) : fail(`No price history for ${symbol}`);
  }
);

tool(
  'get_fund_holdings',
  {
    title: 'Fund composition',
    description:
      'What an ETF/fund owns: holdings with weights (full list for PSX ETFs via their index; top 10 for most others), sector and country split (with whether they cover the whole fund or were rebuilt from top holdings), asset mix, expense ratio, coverage, sources and notes. Returns an error for a non-fund. Manual overrides (set_fund_composition) take precedence and are marked.',
    inputSchema: { symbol: symbolArg }
  },
  async ({ symbol }) => {
    const h = await api.holdings(symbol);
    return h ? ok(h) : fail(`${symbol} is not a fund, or no source publishes its composition. Use set_fund_composition if you have a factsheet.`);
  }
);

tool(
  'get_price_history',
  {
    title: 'Price history',
    description: 'Daily closes for a symbol or index (KSE100, KMI30, ^GSPC...), optionally downsampled to weekly/monthly. Currency is the listing currency (non-USD/PKR listings are converted to USD).',
    inputSchema: {
      symbol: symbolArg,
      range: z.enum(['1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']).default('1y'),
      interval: z.enum(['daily', 'weekly', 'monthly']).default('weekly')
    }
  },
  async ({ symbol, range, interval }) => {
    const h = await api.history(symbol, range);
    if (!h?.history?.length) return fail(`No history for ${symbol}`);
    let pts = h.history;
    if (interval !== 'daily') {
      pts = pts.filter((p, i) => {
        const next = pts[i + 1]?.date;
        if (!next) return true;
        return interval === 'monthly' ? p.date.slice(0, 7) !== next.slice(0, 7) : new Date(`${next}T00:00:00Z`).getUTCDay() < new Date(`${p.date}T00:00:00Z`).getUTCDay();
      });
    }
    return ok({ symbol: h.symbol, currency: h.currency, source: h.source, points: pts.map((p) => ({ date: p.date, close: p.price, volume: p.volume })) });
  }
);

tool(
  'get_quotes',
  {
    title: 'Live quotes',
    description: 'Latest price, change and currency for up to 50 symbols.',
    inputSchema: { symbols: z.array(z.string()).min(1).max(50) }
  },
  async ({ symbols }) => ok(await api.quotes(symbols))
);

tool(
  'search_assets',
  {
    title: 'Search assets',
    description: 'Find tickers by symbol or name across the PSX listing, Pakistani funds and global markets.',
    inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).default(10) }
  },
  async ({ query, limit }) => ok(await api.search(query, limit))
);

tool(
  'screen_stocks',
  {
    title: 'Stock screener',
    description:
      'Filter the nightly screener snapshot (with model outputs: score / scoreSector = composite factor percentile 0-1 vs market / sector, scoreCoverage, dataGrade (A complete, B usable with gaps, C too little data and unscored; pass dataGrade="A,B" to exclude C) and `missing` (the key inputs a row lacks), upside vs fair value, impliedReturn and impliedGrowth from the valuation model, plus the nested `scores` and `valuation` blocks): every PSX equity, every stock above $2B on the 17 markets IBKR offers retail clients (US incl. ADRs, Canada, UK, Europe, Japan, Hong Kong, Australia, Singapore; about 5,000 names), and the curated ETFs. scope: "psx" or "global". Filters: min_<field>/max_<field> for price, marketCap (listing currency), marketCapUsd, peTTM, forwardPE, priceToBook, peg, dividendYield, grossMargin, netMargin, revenueGrowth, epsGrowth, freeFloat, avgValueTraded20d, rsi14, fromHigh52, return1m, return3m, return1y, volatility1y, maxDrawdown1y; equality on region (pk, us, gb, de, jp, hk...), country, market, kind (stock|etf), sector (common 11), trend (uptrend|downtrend|sideways, PSX only), smaCross (bullish|bearish), currency; shariah and aboveSma200 (true/false); q (name/symbol substring); sort (field, prefix - for descending). Ratios are fractions; avgValueTraded20d is PKR for PSX rows and USD otherwise. Shariah flags exist for PSX rows only: screen international names yourself (business activity plus debt and cash vs market cap) before recommending them. PSX rows have no dividend yield.',
    inputSchema: {
      filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}).describe('e.g. {"market":"PSX","shariah":true,"max_peTTM":10,"min_epsGrowth":0.1}'),
      sort: z.string().optional().describe('e.g. "peTTM" or "-return1y"'),
      limit: z.number().int().min(1).max(500).default(50)
    }
  },
  async ({ filters, sort, limit }) => {
    const params = Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, String(v)]));
    const r = await api.screener({ ...params, sort, limit });
    if (!r?.builtAt) return ok({ ...r, note: 'The screener snapshot has not been built yet; it builds nightly (a full build takes several minutes).' });
    return ok(r);
  }
);

tool(
  'plan_contribution',
  {
    title: 'Plan new money',
    description:
      'Split a new contribution across holdings to move toward target weights without selling. Uses the saved targets (set_targets) unless `targets` is given. Targets may include tickers not yet held. Read-only: it returns a plan, nothing is bought or recorded.',
    inputSchema: {
      amount: z.number().positive().describe('Amount of new money in `currency`'),
      currency,
      targets: z.record(z.string(), z.number()).optional().describe('Ticker -> weight; normalised if it does not sum to 1'),
      wholeShares: z.boolean().default(true),
      minTrade: z.number().optional().describe('Skip buys smaller than this amount'),
      portfolio: portfolioArg
    }
  },
  async ({ amount, currency: ccy, targets, wholeShares, minTrade, portfolio }) => {
    const p = await pf.positions({ currency: ccy, portfolio });
    let t = targets;
    if (!t) {
      const rows = await pf.research();
      t = rows.find((r) => r.kind === 'targets')?.data?.targets;
      if (!t) return fail('No saved targets. Pass `targets` or save them with set_targets first.');
    }
    // Prices for tickers not yet held, converted to the display currency.
    const missing = Object.keys(t).map((s) => s.toUpperCase()).filter((s) => !p.holdings.some((h) => h.ticker === s));
    const prices = {};
    if (missing.length) {
      const q = await api.quotes(missing);
      for (const s of missing) {
        const quote = q[s];
        if (!quote?.price) continue;
        const native = String(quote.currency || 'USD').toUpperCase();
        prices[s] = native === ccy ? quote.price : native === 'PKR' ? quote.price / p.fxRate : quote.price * p.fxRate;
      }
    }
    return ok(planContribution(p.holdings, t, amount, { prices, wholeShares, minTrade }));
  }
);

/* -------------------------------------------------------------------------- */
/* Models                                                                     */
/* -------------------------------------------------------------------------- */

tool(
  'get_expected_returns',
  {
    title: 'Expected returns by market',
    description:
      'Capital market assumptions recomputed nightly: per market (PSX, PSX Shariah, US, Europe, Japan, Hong Kong, Canada, Australia) and per core fund, the low/base/high expected annual return in local currency and USD, with the earnings and dividend yields, inflation and currency assumptions behind them and measured USD volatility. Real return is approximated by the earnings yield; see `assumptions` for the method and sources.',
    inputSchema: {}
  },
  async () => ok(await api.expectedReturns())
);

tool(
  'build_model_portfolio',
  {
    title: 'Model portfolio, projection and stress tests',
    description:
      'Run the portfolio construction pipeline: monthly USD returns (5y, short histories completed with KSE-100 TR or S&P 500), Ledoit-Wolf shrunk covariance, Black-Litterman returns from a policy reference portfolio plus per-asset views (fund CMAs; stock implied returns shrunk toward their market), and constrained mean-variance within the policy sleeves (global funds 35-45%, global stocks 25-35%, Pakistan 10-40%). Returns the recommended weights with minimum-variance, max-Sharpe, risk-parity and reference alternatives (expected return, volatility, Sharpe, risk contributions), a Monte Carlo projection of the contribution plan (block bootstrap, 10y percentiles, chance of being below the money put in) and historical/hypothetical stress tests for the current and recommended portfolios. Candidates default to current holdings + planner targets + watchlist; core funds ISWD/ISDU/ISDE are added if no global fund is among them. Takes 10-60 seconds.',
    inputSchema: {
      extraSymbols: z.array(z.string()).default([]).describe('More candidates to consider, e.g. ideas from screen_stocks'),
      useResearch: z.boolean().default(true).describe('Include planner targets and watchlist as candidates'),
      monthly: z.number().default(2500).describe('Monthly contribution in USD for the projection'),
      contributionGrowth: z.number().default(0.05).describe('Annual growth of the contribution'),
      years: z.number().int().min(1).max(40).default(10),
      maxStockWeight: z.number().min(0.01).max(1).default(0.1).describe('Cap per single stock'),
      rf: z.number().default(0.04).describe('USD risk-free rate'),
      sleeves: z
        .record(z.string(), z.object({ target: z.number(), min: z.number(), max: z.number() }))
        .optional()
        .describe('Override sleeve bounds, keys globalCore / globalStocks / pakistan'),
      comparePakistan: z.array(z.number()).optional().describe('Also project with these Pakistan sleeve targets, e.g. [0.1, 0.3, 0.4]')
    }
  },
  async ({ extraSymbols, useResearch, monthly, contributionGrowth, years, maxStockWeight, rf, sleeves, comparePakistan }) => {
    const pos = await pf.positions({ currency: 'USD' });
    let extra = [...extraSymbols];
    if (useResearch) {
      const rows = await pf.research();
      extra.push(...rows.filter((r) => r.kind === 'watch').map((r) => r.symbol));
      extra.push(...Object.keys(rows.find((r) => r.kind === 'targets')?.data?.targets || {}));
    }
    const fxSeries = await api.fxSeries();
    const inputs = await buildInputs({
      holdings: pos.holdings,
      extraSymbols: extra,
      fetchers: {
        histories: (syms, range = '10y') => api.historyBatch(syms, range),
        expectedReturns: () => api.expectedReturns(),
        screenerRow: (s) => api.screenerRow(s)
      }
    });
    const base = { ...inputs, holdings: pos.holdings, fxSeries, rf, maxStockWeight, monthly, contributionGrowth, years };
    const result = runModels({ ...base, sleeves: sleeves ? { ...DEFAULT_SLEEVES, ...sleeves } : undefined });

    let pakistanComparison;
    if (comparePakistan?.length) {
      pakistanComparison = comparePakistan.map((pk) => {
        const rest = 1 - pk;
        const s = {
          globalCore: { ...DEFAULT_SLEEVES.globalCore, target: rest * 0.57, min: rest * 0.5, max: rest * 0.64 },
          globalStocks: { ...DEFAULT_SLEEVES.globalStocks, target: rest * 0.43, min: rest * 0.36, max: rest * 0.5 },
          pakistan: { ...DEFAULT_SLEEVES.pakistan, target: pk, min: Math.max(0, pk - 0.02), max: Math.min(1, pk + 0.02) }
        };
        try {
          const r = runModels({ ...base, sleeves: s });
          const rec = r.portfolios.recommended;
          const y = r.projections.recommended.byYear.at(-1);
          const worst = r.stress.recommended.reduce((a, x) => (x.portfolioReturn != null && x.portfolioReturn < a.r ? { r: x.portfolioReturn, name: x.name } : a), { r: 0, name: null });
          return { pakistan: pk, expectedReturn: rec.expectedReturn, volatility: rec.volatility, sharpe: rec.sharpe, projection: y, worstStress: worst };
        } catch (err) {
          return { pakistan: pk, error: err.message };
        }
      });
    }

    const trim = (pfo) => ({ ...pfo, weights: Object.fromEntries(Object.entries(pfo.weights).filter(([, w]) => w > 0.0005)) });
    return ok({
      ...result,
      portfolios: Object.fromEntries(Object.entries(result.portfolios).map(([k, v]) => [k, trim(v)])),
      stress: {
        notional: result.stress.notional,
        current: result.stress.current?.map(({ holdings, ...s }) => s),
        recommended: result.stress.recommended.map(({ holdings, ...s }) => s)
      },
      pakistanComparison,
      notes: [
        ...(result.notes || []),
        'Expected returns are model estimates (earnings-yield based), not forecasts; use the ranges in get_expected_returns.',
        'Weights are a starting point for judgement: check Shariah status and theses before acting on single stocks.'
      ]
    });
  }
);

tool(
  'get_statements',
  {
    title: 'Captured financial statements',
    description:
      'PSX financial statements captured from the companies\' results filings (balance sheet, income statement, cash flow where published), per period, in PKR thousands, with the source PDF, pages and validation checks. Without a symbol: the capture queue (tracked companies, pending, accepted, needs-review with reasons, failed).',
    inputSchema: { symbol: z.string().optional() }
  },
  async ({ symbol }) => {
    const r = symbol ? await api.statements(symbol) : await api.statementsStatus();
    return r ? ok(r) : fail(`No statements captured for ${symbol}`);
  }
);

tool(
  'retry_statement',
  {
    title: 'Retry a filing',
    description: 'Put a filing that failed validation or extraction back in the queue (id like OGDC_2026-06-30), e.g. after checking the reason in get_statements.',
    inputSchema: { id: z.string() }
  },
  async ({ id }) => ok(await api.retryStatement(id))
);

tool(
  'get_data_quality',
  {
    title: 'Data quality report',
    description: 'Nightly report on the data behind the models: field coverage for PSX and global rows, stale prices, PSX series with unexplained jumps in the last 60 days, and the age of the global universe, global fundamentals and model outputs.',
    inputSchema: {}
  },
  async () => ok(await api.dataQuality())
);

tool(
  'get_jobs',
  {
    title: 'Scheduled jobs',
    description: 'Status of the backend jobs: daily at 00:00 Pakistan time (prices, screener, models, data quality) and monthly on the 1st (global universe and fundamentals, then the daily steps). Shows next run, current progress and the last run per step.',
    inputSchema: {}
  },
  async () => ok(await api.jobs())
);

tool(
  'get_news',
  {
    title: 'News',
    description:
      'Recent news from Pakistani and global sources (Business Recorder, Dawn, Tribune, The News, Bloomberg and FT headlines, Nikkei Asia, SCMP, CNBC, BBC, Arab News, Middle East Eye, OilPrice, the Fed), tagged nightly by Claude with importance (0-3), themes, markets, sectors and symbols. Filter by symbol, theme (e.g. pakistan-macro, pakistan-politics, geopolitics-regional, geopolitics-global, monetary-policy, commodities, trade, markets, corporate), market (PK, US, EU, UK, CN, JP, IN, GULF, EM, GLOBAL), sector or free text. Sorted by importance, then time. Articles collected since the last digest are untagged and only match text searches.',
    inputSchema: {
      symbol: z.string().optional(),
      theme: z.string().optional(),
      market: z.string().optional(),
      sector: z.string().optional(),
      q: z.string().optional().describe('words that must all appear in the title or summary'),
      days: z.number().optional().describe('look-back, default 7'),
      minImportance: z.number().int().min(0).max(3).optional(),
      limit: z.number().int().optional()
    }
  },
  async (a) => ok(await api.news(a))
);

tool(
  'get_geo_brief',
  {
    title: 'Daily news brief',
    description:
      'The nightly geopolitical and market brief written from the day\'s news: headline, summary, sections by theme with the articles behind each point, and what it means for the tracked holdings. Without a date: the latest. Lists the other dates available.',
    inputSchema: { date: z.string().optional().describe('YYYY-MM-DD (Pakistan date of the digest)') }
  },
  async ({ date }) => {
    const b = await api.newsBrief(date);
    return b ? ok(b) : fail('No brief yet: the nightly digest has not run.');
  }
);

tool(
  'get_risk_register',
  {
    title: 'Risk register',
    description:
      'Running register of geopolitical and macro risks maintained by the nightly news digest: each with severity (1-5), direction (rising/stable/easing), the markets, sectors and symbols exposed, what to watch, its history of changes and recent evidence articles. Use it to choose stress scenarios and as an input to reviews and theses; it never changes the models by itself.',
    inputSchema: {
      market: z.string().optional(),
      symbol: z.string().optional(),
      includeResolved: z.boolean().optional()
    }
  },
  async (a) => ok(await api.newsRisks(a))
);

tool(
  'run_job',
  {
    title: 'Run a job now',
    description: 'Queue the daily or monthly job immediately (needs the backend write token). The monthly job takes an hour or more.',
    inputSchema: { job: z.enum(['daily', 'monthly']) }
  },
  async ({ job }) => ok(await api.runJob(job))
);

/* -------------------------------------------------------------------------- */
/* Research workspace: watchlist, targets, notes, settings                    */
/* -------------------------------------------------------------------------- */

const R = store.COLLECTIONS.research;

async function upsertResearch(kind, symbol, data) {
  const rows = await pf.research();
  const existing = rows.find((r) => r.kind === kind && String(r.symbol || '').toUpperCase() === String(symbol).toUpperCase());
  const item = { kind, symbol: String(symbol).toUpperCase(), data: { ...(existing?.data || {}), ...data, updatedAt: new Date().toISOString() } };
  const saved = existing ? await store.update(R, existing.id, item) : await store.create(R, item);
  pf.invalidate('research');
  return saved;
}

tool(
  'get_research',
  {
    title: 'Watchlist, targets, notes',
    description: 'The research workspace saved in the app: watchlist entries (with thesis/target price), target allocation, per-symbol notes, and analysis settings (risk-free rates, monthly contribution).',
    inputSchema: {}
  },
  async () => {
    const rows = await pf.research();
    const pick = (kind) => rows.filter((r) => r.kind === kind).map((r) => ({ id: r.id, symbol: r.symbol, ...r.data }));
    return ok({
      watchlist: pick('watch'),
      targets: rows.find((r) => r.kind === 'targets')?.data || null,
      notes: pick('note'),
      settings: rows.find((r) => r.kind === 'settings')?.data || null
    });
  }
);

tool(
  'set_watchlist',
  {
    title: 'Edit watchlist',
    description: 'Add or update watchlist entries (shown on the Watchlist page) and/or remove them.',
    inputSchema: {
      add: z
        .array(
          z.object({
            symbol: z.string(),
            thesis: z.string().optional().describe('Why it is worth watching'),
            targetPrice: z.number().optional().describe('Price at which it becomes interesting, listing currency'),
            tags: z.array(z.string()).optional()
          })
        )
        .default([]),
      remove: z.array(z.string()).default([])
    }
  },
  async ({ add, remove }) => {
    const saved = [];
    for (const w of add) {
      const { symbol, ...data } = w;
      const r = await upsertResearch('watch', symbol, { ...data, addedBy: 'Claude' });
      saved.push(r.symbol);
    }
    const rows = await pf.research();
    const removed = [];
    for (const s of remove) {
      const r = rows.find((x) => x.kind === 'watch' && x.symbol === s.toUpperCase());
      if (r) {
        await store.remove(R, r.id);
        removed.push(r.symbol);
      }
    }
    pf.invalidate('research');
    return ok({ saved, removed });
  }
);

tool(
  'set_targets',
  {
    title: 'Set target allocation',
    description: 'Save the target allocation by ticker (used by plan_contribution and shown on the Planner page). Weights are fractions and are normalised to sum to 1.',
    inputSchema: {
      targets: z.record(z.string(), z.number().min(0)),
      rationale: z.string().optional().describe('Why this allocation; shown with the targets')
    }
  },
  async ({ targets, rationale }) => {
    const sum = Object.values(targets).reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return fail('Targets must have a positive total weight.');
    const norm = Object.fromEntries(Object.entries(targets).map(([k, v]) => [k.toUpperCase(), v / sum]));
    const saved = await upsertResearch('targets', '*', { targets: norm, rationale: rationale || null, setBy: 'Claude' });
    return ok({ saved: saved.data });
  }
);

tool(
  'set_note',
  {
    title: 'Note on a symbol',
    description: 'Save (or clear, with empty text) the note shown for a symbol: thesis, what to watch for, exit criteria.',
    inputSchema: { symbol: symbolArg, text: z.string() }
  },
  async ({ symbol, text }) => {
    if (!text.trim()) {
      const rows = await pf.research();
      const r = rows.find((x) => x.kind === 'note' && x.symbol === symbol.toUpperCase());
      if (r) await store.remove(R, r.id);
      pf.invalidate('research');
      return ok({ cleared: symbol.toUpperCase() });
    }
    const saved = await upsertResearch('note', symbol, { text, author: 'Claude' });
    return ok({ saved: saved.symbol });
  }
);

tool(
  'set_research_settings',
  {
    title: 'Analysis settings',
    description: 'Settings used by the X-ray and planner: annual risk-free rate per currency (fraction, e.g. PKR T-bill yield), the usual monthly contribution, and default display currency. Only the fields given are changed.',
    inputSchema: {
      riskFreeRate: z.object({ PKR: z.number().optional(), USD: z.number().optional() }).optional(),
      monthlyContribution: z.object({ amount: z.number(), currency: z.enum(['USD', 'PKR']) }).optional(),
      displayCurrency: z.enum(['USD', 'PKR']).optional(),
      source: z.string().optional().describe('Where the risk-free rates came from, with date')
    }
  },
  async (args) => {
    const rows = await pf.research();
    const cur = rows.find((r) => r.kind === 'settings')?.data || {};
    const next = { ...cur };
    if (args.riskFreeRate) next.riskFreeRate = { ...(cur.riskFreeRate || {}), ...args.riskFreeRate };
    if (args.monthlyContribution) next.monthlyContribution = args.monthlyContribution;
    if (args.displayCurrency) next.displayCurrency = args.displayCurrency;
    if (args.source) next.riskFreeSource = args.source;
    const saved = await upsertResearch('settings', '*', next);
    return ok({ saved: saved.data });
  }
);

/* -------------------------------------------------------------------------- */
/* Insights: Claude's analyses, shown in the app                              */
/* -------------------------------------------------------------------------- */

const I = store.COLLECTIONS.insights;
const INSIGHT_KINDS = ['portfolio-review', 'stock-analysis', 'rebalance-plan', 'contribution-plan', 'screen', 'market', 'note'];

tool(
  'save_insight',
  {
    title: 'Save an analysis to the app',
    description:
      'Save a written analysis so it appears on the app\'s Insights page (and on each linked symbol\'s research page). Body is Markdown (tables supported). Lead with the conclusion, show the numbers behind it, and state data gaps and the as-of date. Pass `id` to revise an existing insight instead of creating a new one.',
    inputSchema: {
      id: z.string().optional(),
      kind: z.enum(INSIGHT_KINDS),
      title: z.string().max(140),
      summary: z.string().max(400).describe('One or two sentences shown in lists'),
      body: z.string().describe('Markdown'),
      symbols: z.array(z.string()).default([]),
      verdict: z.enum(['buy', 'add', 'hold', 'trim', 'sell', 'avoid', 'watch', 'n/a']).optional().describe('For stock-analysis'),
      confidence: z.enum(['low', 'medium', 'high']).optional(),
      dataAsOf: z.string().optional().describe('YYYY-MM-DD of the data used')
    }
  },
  async ({ id, kind, title, summary, body, symbols, verdict, confidence, dataAsOf }) => {
    const item = {
      kind,
      title,
      body,
      symbols: symbols.map((s) => s.toUpperCase()),
      author: 'Claude',
      meta: { summary, verdict: verdict || null, confidence: confidence || null, dataAsOf: dataAsOf || today(), savedAt: new Date().toISOString() }
    };
    const saved = id ? await store.update(I, id, item) : await store.create(I, item);
    return ok({ id: saved.id, title: saved.title, revised: Boolean(id) });
  }
);

tool(
  'list_insights',
  {
    title: 'Saved analyses',
    description: 'List saved insights (newest first) with their summaries; use get_insight for the full body. Read past analyses before writing a new one so recommendations stay consistent or explicitly revise earlier ones.',
    inputSchema: { kind: z.enum(INSIGHT_KINDS).optional(), symbol: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) }
  },
  async ({ kind, symbol, limit }) => {
    let rows = await store.list(I);
    if (kind) rows = rows.filter((r) => r.kind === kind);
    if (symbol) rows = rows.filter((r) => (r.symbols || []).includes(symbol.toUpperCase()));
    return ok(rows.slice(0, limit).map((r) => ({ id: r.id, kind: r.kind, title: r.title, symbols: r.symbols, ...(r.meta || {}), created: r._created })));
  }
);

tool(
  'get_insight',
  { title: 'Read an analysis', description: 'Full text of a saved insight.', inputSchema: { id: z.string() } },
  async ({ id }) => ok(await store.get(I, id))
);

tool(
  'delete_insight',
  { title: 'Delete an analysis', description: 'Remove a saved insight from the app.', inputSchema: { id: z.string() } },
  async ({ id }) => ok({ deleted: await store.remove(I, id) })
);

/* -------------------------------------------------------------------------- */
/* Overrides on the backend: filling data gaps                                */
/* -------------------------------------------------------------------------- */

tool(
  'set_fund_composition',
  {
    title: 'Record a fund\'s holdings',
    description:
      'Store a fund\'s composition read from a factsheet, annual report or issuer file, for funds the automatic sources cover poorly. Replaces automatic data for that symbol everywhere (app X-ray included) until cleared. Weights are fractions of the fund. Always give `source` and `asOf`.',
    inputSchema: {
      symbol: symbolArg,
      name: z.string().optional(),
      holdings: z.array(z.object({ ticker: z.string().optional(), name: z.string(), weight: z.number(), sector: z.string().optional(), country: z.string().optional(), isin: z.string().optional() })),
      sectors: z.array(z.object({ sector: z.string(), weight: z.number() })).optional(),
      countries: z.array(z.object({ country: z.string(), weight: z.number() })).optional(),
      assetMix: z.object({ stock: z.number(), bond: z.number(), cash: z.number(), other: z.number() }).optional(),
      expenseRatio: z.number().optional(),
      holdingsCount: z.number().int().optional().describe('Total holdings in the fund, if the source states it'),
      source: z.string().describe('e.g. "AWT fund manager report, Sept 2026"'),
      sourceUrl: z.string().optional(),
      asOf: z.string().describe('YYYY-MM-DD the composition is as of'),
      note: z.string().optional()
    }
  },
  async ({ symbol, source, sourceUrl, asOf, note, ...data }) => {
    const r = await api.setOverride({ kind: 'holdings', symbol, data, source, sourceUrl, asOf, note });
    pf.invalidate('market');
    return ok(r);
  }
);

tool(
  'set_fundamentals_override',
  {
    title: 'Patch fundamentals',
    description:
      'Fill or correct fundamentals the providers miss (e.g. PSX dividend yield, book value, debt/equity from an annual report). Patches individual fields by block, e.g. {"valuation":{"dividendYield":0.08},"health":{"debtToEquity":0.4}}. Use the same units as get_fundamentals (fractions, full currency units).',
    inputSchema: {
      symbol: symbolArg,
      data: z.record(z.string(), z.any()),
      source: z.string(),
      sourceUrl: z.string().optional(),
      asOf: z.string().optional(),
      note: z.string().optional()
    }
  },
  async ({ symbol, data, source, sourceUrl, asOf, note }) => {
    const r = await api.setOverride({ kind: 'fundamentals', symbol, data, source, sourceUrl, asOf, note });
    pf.invalidate('market');
    return ok(r);
  }
);

tool(
  'clear_override',
  {
    title: 'Remove an override',
    description: 'Delete a fund-composition or fundamentals override so automatic data is used again.',
    inputSchema: { kind: z.enum(['holdings', 'fundamentals']), symbol: symbolArg }
  },
  async ({ kind, symbol }) => {
    const r = await api.setOverride({ action: 'delete', kind, symbol });
    pf.invalidate('market');
    return ok(r);
  }
);

/* -------------------------------------------------------------------------- */
/* Transactions (opt-in)                                                      */
/* -------------------------------------------------------------------------- */

tool(
  'add_transaction',
  {
    title: 'Record a transaction',
    description:
      'Record a BUY, SELL, DIVIDEND or TAX exactly as the app\'s Add Transaction form would. Disabled unless ALLOW_TRANSACTION_WRITES=true in mcp/.env. Always call first with confirm=false to get a preview, show it to the user, and only call again with confirm=true once they have approved it.',
    inputSchema: {
      type: z.enum(['BUY', 'SELL', 'DIVIDEND', 'TAX']),
      ticker: symbolArg,
      date: z.string().describe('YYYY-MM-DD'),
      shares: z.number().positive().optional().describe('BUY/SELL'),
      price: z.number().positive().optional().describe('BUY/SELL, per share in the listing currency'),
      fees: z.number().min(0).default(0),
      amount: z.number().optional().describe('DIVIDEND/TAX: positive amount in the listing currency'),
      currency: z.enum(['USD', 'PKR']),
      portfolio: z.string().default('Main'),
      notes: z.string().default(''),
      confirm: z.boolean().default(false)
    }
  },
  async (a) => {
    if (!config.allowTransactionWrites) {
      return fail('Transaction writes are disabled. Set ALLOW_TRANSACTION_WRITES=true in mcp/.env and restart the MCP server to enable them.');
    }
    const trade = a.type === 'BUY' || a.type === 'SELL';
    if (trade && !(a.shares > 0 && a.price > 0)) return fail('BUY/SELL need shares and price.');
    if (!trade && !(Math.abs(a.amount || 0) > 0)) return fail('DIVIDEND/TAX need an amount.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date)) return fail('date must be YYYY-MM-DD');

    const search = await api.search(a.ticker, 5);
    const asset = (search || []).find((r) => r.symbol.toUpperCase() === a.ticker.toUpperCase());
    if (!asset) return fail(`${a.ticker} is not a symbol the backend recognises; search_assets first.`);

    if (a.type === 'SELL') {
      const p = await pf.positions({ currency: 'USD' });
      const held = p.holdings.find((h) => h.ticker === asset.symbol)?.shares || 0;
      if (held < a.shares) return fail(`Cannot sell ${a.shares} ${asset.symbol}: only ${held} held.`);
    }

    const fxRes = await api.historicalFx(a.date).catch(() => null);
    const tx = {
      type: a.type,
      ticker: asset.symbol,
      assetName: asset.name,
      date: a.date,
      currency: a.currency,
      portfolio: a.portfolio,
      fxRateOnDate: fxRes?.rate || 278,
      notes: a.notes,
      ...(trade ? { shares: a.shares, price: a.price, fees: a.fees } : { amount: a.type === 'TAX' ? -Math.abs(a.amount) : Math.abs(a.amount) })
    };

    if (!a.confirm) return ok({ preview: tx, next: 'Show this to the user; call again with confirm=true once they approve.' });
    const saved = await store.create(store.COLLECTIONS.transactions, tx);
    pf.invalidate('tx');
    return ok({ saved: { id: saved.id, ...tx } });
  }
);

/* -------------------------------------------------------------------------- */
/* Prompts: repeatable analyses                                               */
/* -------------------------------------------------------------------------- */

server.registerPrompt(
  'portfolio-review',
  { title: 'Portfolio review', description: 'Full review of the current portfolio, saved to Insights.' },
  () => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            'Review my portfolio using the stock-tracker tools.',
            '1. list_insights (portfolio-review) to see what was said last time.',
            '2. get_xray in PKR and USD, get_research, and get_fundamentals + get_technicals for each holding (and get_fund_holdings for funds).',
            '3. Assess: true exposure after look-through and overlaps, concentration, currency and country risk, Shariah share, fee drag, performance vs KSE-100/KMI-30/S&P 500 in both currencies, valuation and momentum of each holding.',
            '4. Recommend specific, prioritised changes (what to add, trim, or stop buying, and why), and where the next monthly contribution should go.',
            '5. save_insight (kind portfolio-review) with the review, noting data gaps and the as-of date.'
          ].join('\n')
        }
      }
    ]
  })
);

server.registerPrompt(
  'stock-deep-dive',
  { title: 'Stock deep-dive', description: 'Fundamental + technical analysis of one symbol, saved to Insights.', argsSchema: { symbol: z.string() } },
  ({ symbol }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Do a deep-dive on ${symbol} with the stock-tracker tools: get_fundamentals, get_technicals, get_price_history (5y, monthly), any earlier insights on it, and whether and how much I already hold (get_xray lookThrough, including via funds). Read recent PSX announcements if listed. Cover the business, quality and growth, valuation vs history and peers (screen_stocks in its sector), balance-sheet risk, technical setup, and position sizing given my portfolio. Give a verdict with confidence and the price levels that would change it, then save_insight (kind stock-analysis).`
        }
      }
    ]
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
