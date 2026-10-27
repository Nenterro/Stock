# Stock Tracker

Portfolio tracking for PSX equities, mutual funds and international holdings.
React + Vite frontend; a Node service on the home server does quote fetching,
FX, the asset universe and KTrade contract-note imports.

## Where things live, and how they ship

Two halves, two completely separate deployment paths. Confusing them is how a
fix gets written, tested, committed — and never actually goes live.

### Frontend — this repo

Everything here is frontend: `src/`, `public/`, `index.html`, the Vite and
Vercel config.

- Worked on locally, on the dev machine.
- Committed and pushed to **`main`** on GitHub.
- **Vercel builds `main` and nothing else.** Pushing to `main` is the deploy.

Work on a branch if you like, but nothing is live until it reaches `main`. A
commit sitting on a feature branch is not deployed, however finished it looks,
and neither is one sitting unpushed on a local `main`.

### Backend — the home server only

The Node API does not live here and is not in version control. It lives at
`~/Docker/stock-api` on the home server, is a service in
`~/Docker/docker-compose.yml`, and is edited in place over SSH.

A backend change is not live until the container is rebuilt. Pushing to GitHub
does nothing for it — there is nothing here to push.

**Do not add backend code to this repo.** `/backend/` is in `.gitignore` for
that reason. It was tracked here until September 2026, which meant one service
with two copies and nothing keeping them in step.

## Working on the backend

The SSH address, paths and commands are in **`CLAUDE.local.md`**, gitignored
because this repo is public. It loads automatically alongside this file. If it
is missing — fresh clone, different machine — ask rather than guessing.

The Dockerfile `COPY`s the source in, so a change needs a rebuild, not a
restart:

```bash
cd ~/Docker && docker compose up -d --build stock-api
```

`~/Docker/stock-api/data` is a mounted volume holding the asset universe and
price caches. It survives rebuilds — and it is worth knowing it exists before
blaming the code for stale prices.

Gmail credentials for the KTrade importer are in `~/Docker/stock-api/.env`,
never in source control.

## Research features and the MCP server

Claude is the analyst here, through Claude Code rather than an API key: the
`stock-tracker` MCP server in `mcp/` (registered in `.mcp.json`) gives any
Claude Code session in this repo tools to read the portfolio and market data
and to write analyses back into the app.

- `mcp/` runs on the dev machine, not the server. It is the one exception to
  "no backend code here": it is a local tool, and it imports the app's own
  `src/utils/portfolio_math.js` and `portfolio_analytics.js` so Claude and the
  app compute identical numbers. Keep those two files free of browser and
  React imports.
- Credentials live in `mcp/.env` (gitignored; template in `mcp/.env.example`):
  the E2EE PIN and the backend write token. The account signs in with
  Google, so there is no password: `node mcp/scripts/login.js` does the
  OAuth flow once and saves the session to `mcp/.auth.json` (gitignored),
  which the server refreshes on every start. If it has gone unused past the
  token lifetime, run the script again. The server
  decrypts and re-encrypts exactly like `src/utils/crypto.js` - change one,
  change both.
- What Claude writes lands in two PocketBase collections synced like the rest:
  `stock_insights` (analyses, shown on Insights and per-symbol pages) and
  `stock_research` (`{ kind, symbol, data }` records: `watch`, `note`,
  `targets` (symbol `*`), `settings` (symbol `*`)). Transaction writes are off
  unless `ALLOW_TRANSACTION_WRITES=true`, and always preview first.
- Smoke test: `node mcp/scripts/check.js [tool] ['{json args}']`.

The backend side of the research features (all in `~/Docker/stock-api/lib/`):
`fundamentals.js`, `holdings.js` (fund look-through: complete daily
holdings files from iShares for ISDE/ISDU/ISWD via `providers/ishares.js`,
top 10 from justETF/Yahoo for other funds), `technicals.js`,
`screener.js` (nightly snapshot in `data/screener.json`), `overrides.js`
(manual fund/fundamentals data, `data/overrides.json`), `taxonomy.js` (one
sector vocabulary across PSX, Yahoo and justETF). Write routes need
`Authorization: Bearer $STOCK_API_WRITE_TOKEN`.

### Models, and when they run

Backend jobs (`lib/jobs.js`, Pakistan time; status at `/api/jobs`):

- **daily 00:00** - today's quotes for the global universe members
  (`globalUniverse.refreshQuotes`; membership changes only monthly), then the
  screener build (PSX + global rows, technicals on adjusted
  closes), then the market-wide models in `lib/models/`: expected returns per
  market and fund (`expectedReturns.js`, written to `data/expected_returns.json`),
  per-stock valuation (`valuation.js`: two-stage earnings model solved for
  implied return / implied growth / fair value, plus peer multiples) and factor
  scores (`scores.js`: percentiles vs market and sector, composite with
  coverage), then statements discovery and the archive top-up (see below),
  then the data-quality report (`dataQuality.js`).
- **monthly, 1st, 00:00** - global universe (`globalUniverse.js`, ~5,100 stocks
  on IBKR markets), global fundamentals (`fundamentalsGlobal.js`, one Yahoo
  call per stock), global risk statistics and the report archive index, then
  the daily steps.

Global units: Yahoo quotes London prices in pence but market caps in pounds,
so market caps are never rescaled (until October 2026 they were, which
understated 740 UK rows 100x and gave them FCF yields of 500%+). Debt, cash
and FCF reported in another currency than the listing (TSM: TWD vs USD) are
converted at today's rate instead of being dropped, so the AAOIFI ratios
(`debtToMarketCap`, `cashToMarketCap`, on today's market cap) exist for
foreign filers too; `statementsConvertedFrom` names the reporting currency.
The third AAOIFI test, `interestIncomeToRevenue` (with `interestIncomeAsOf`),
comes from Yahoo's fundamentals-timeseries endpoint (`yahoo.timeseries`):
reported interest income over revenue for the same period, trailing 12
months where Yahoo has the pair, else the latest annual, nothing older than
24 months. Fetched with the monthly global fundamentals; all three ratios
are `screen_stocks` filters.
FCF yield is left out for Financial Services (insurers' and banks' cash flow
is customers' money) and above 50% (data errors); it feeds the value score.
UK listings with no Yahoo profile (no sector, no industry) and "<name> Ord"
asset managers are investment trusts: `kind: 'fund'`, not scored as stocks.

PSX preference shares (names with "(Pref)" or "(PRS)") have `kind:
'preference'`: in the screener, left out of the models and the data-quality
coverage.

Portfolio models run on demand, in `src/utils/models/` (shared by the Planner
page and the MCP tool `build_model_portfolio`): `risk.js` (monthly USD
returns, short histories filled from KSE-100 TR / S&P 500, Ledoit-Wolf),
`optimize.js` (Black-Litterman, constrained mean-variance via projected
gradient with Dykstra projections, min-variance, max-Sharpe, risk parity),
`simulate.js` (block-bootstrap projection of the contribution plan, stress
tests), `construct.js` (policy sleeves, views, the end-to-end run),
`pipeline.js` (data in, everything out). Tests: `npm test` here, and
`node --test test/` in `~/Docker/stock-api`.

Valuation design choices worth knowing before changing `valuation.js`:
required return per market is calibrated to the median implied return of
that market's stocks (so upside is relative to the market; the CMA stays the
absolute view); US listings of foreign companies are calibrated separately
against their home market's USD return; unknown ROE (all of PSX) defaults to
1.25x the market's CMA required return; PSX growth uses profit after tax, not
EPS, because published PSX EPS isn't restated for splits.

PSX corporate actions come from `lib/psxEvents.js`:
- Sarmaaya's payouts have dated rows only from about 2023; its older rows are
  empty placeholders (date 0000-00-00).
- Dividends and bonus issues before that come from Yahoo (`SYMBOL.KA`).
  Yahoo restates old dividends per today's share, so each one is multiplied
  back by the splits Yahoo records after it.
- Delisted companies aren't on Yahoo. For the backtest their dividends come
  from the dividends paid in their archived cash flow statements.
- Until October 2026 the adjusted series had no dividends before 2023 at
  all, which understated PSX total returns by the dividend yield (4–10% a
  year).

- Rights issues and face-value changes are in neither feed. They come from the
  company's PSX announcement titles (`announcementEvents`, cached a day).

PSX price history is adjusted on the way in (`lib/adjust.js`): weekend rows
dropped, splits/bonuses/dividends back-adjusted into `adjClose` (event feed
where it has the event, PSX's 10% circuit breaker to detect the rest). Raw
`price` is kept for valuing holdings; every return, risk and model figure uses
`adjClose`. KSE100TR / KMI30TR are total-return estimates of the price indices.
- An event explains a circuit-breaking move when what's left after taking it
  out is an ordinary trading move. Before October 2026 a dividend had to match
  the drop within 4 points; a dividend plus a 5–9% trading day was taken out
  as "unexplained" and then applied again, overstating past returns by the
  dividend.
- Rights issues with terms in the title ("98.76% at ... Rs.10") use the
  theoretical ex-rights price; without terms the observed move is taken out
  and labelled `rights`/`announcement`. Face-value changes try ratios 2, 2.5,
  4, 5 and 10.
- Only moves left unexplained (`source: 'detected'`) reach the data-quality
  report.

### PSX financial statements

PSX publishes balance sheets and cash flows only as results PDFs, nearly all
scanned, so they are captured with Claude reading the pages
(`lib/statements.js` in the backend):

- the daily job's `statements discovery` step queues results filings for tier 1
  (holdings, watchlist, planner targets, pushed hourly by the main MCP server:
  every filing PSX lists) and tier 2 (Shariah PSX stocks trading >= PKR 10m a
  day: latest annual + latest interim). The backend renders pages with poppler:
  for long reports, the statement pages found in the text layer (headings may
  break over two lines), else the ten pages from a balance sheet found on its
  own, else the first 40.
- `mcp/scripts/extract-statements.sh` (cron on the home server, 01:30 PKT)
  runs one headless `claude -p` session per filing with only
  `mcp/statements-server.js` and `Read`, following `mcp/statements/EXTRACT.md`.
- every submission is validated: the balance sheet must balance within 1%, and
  profit must match PSX's own annual or quarterly table (single or summed
  quarters) within 1.5%. Failures are held as needs-review, never stored.
- accepted figures (PKR thousands) feed ROE, ROA, debt/equity, current ratio,
  receivables/revenue, cash and debt to market cap, and FCF yield into
  fundamentals and the screener. ROE uses the latest annual filing; with only
  an interim captured it is annualised and `roeBasis` says so.

Status: MCP `get_statements` (no symbol) or `/api/statements`; retry a held
filing with `retry_statement`.

The live metrics (`statements.allPeriods` → `metricsFor`) use both stores:
- the live filings;
- the annual reports read for the backtest archive. A live record wins for
  the same period end.

The backtest queue covers only companies that were once among the most
traded, so the daily `archive top-up` step (`archiveExtract.topUpLatest`)
also queues the latest annual report of every trading PSX stock at priority
1000, ahead of the backlog. Companies whose latest annual the live capture
already has (`statements.coveredSymbols`) are skipped, so no report is read
twice. This is where ROE comes from for PSX stocks outside the live tiers.

Live data comes before the backtest. `extract-archive.sh` yields while the
statements run is going, and while live filings are pending it passes
`minPriority: 1000`, so only the latest annuals are read and the backlog
waits. The statements cron runs with `STATEMENTS_MAX=80`.

The archive serves an empty body for reports it lists but hasn't stored
(most FY2026 annuals in October 2026). Its numeric ids are PSX document ids,
so `downloadReport` falls back to `dps.psx.com.pk/download/document/<id>.pdf`
(slow: ~90 KB/s, 3-6 minutes a report). The headless MCP client
(`mcp/lib/backend.js`) gives `next` calls 14 minutes and never resends a
timed-out request to the fallback URL: that used to run `next` twice and
claim a second report.

`get_data_quality` reports coverage for `psxShariahLiquid` (Shariah, >= PKR
10m a day: what PSX picks are made from) separately from all of PSX.

Statements more than 21 months old are ignored
(`MAX_STATEMENT_AGE_MONTHS`): an old balance sheet is worse than none,
because it looks complete. Since October 2026 this covers most liquid PSX
stocks: grade-A Shariah names went from 0 to 33 when it was connected.

### Backtest data (point-in-time)

Built in October 2026 for an honest historical backtest. Lives in the backend,
separate from the live data:

- `lib/archive.js` indexes the report archive at financials.psx.com.pk: 684
  companies, delisted ones included, with about 22k annual and interim
  reports from 2013.
  - `availableAt` is when a report's figures could first be known: the
    real posting date from 2018 on, else the filing deadline (annual
    +4 months, half-year +2, quarter +1).
  - Archive "years" are sometimes off by one, so the extracted period end
    is the truth.
- `lib/backtest/psxPrices.js` builds monthly adjusted closes and traded
  value for every archive company from Sarmaaya, which keeps delisted
  histories. `liquidAt(month)` is the point-in-time liquidity universe
  (top 150 by 3-month traded value), so there is no survivorship bias.
  Union 2013–2026: 332 companies, 35 of them no longer trading; some of
  those are renames (ICI→LCI, GSKCH→HALEON, SHEL→WAFI) that need merging.
- `lib/archiveExtract.js` reads annual reports into `archive_statements`.
  - Text reports: the backend finds the statements as a cluster of
    headings (balance sheet, then P&L or "comprehensive income", then cash
    flow, unconsolidated first) and passes their text.
  - Scanned reports (about 25%): contact sheets, then chosen pages
    rendered in full.
  - Checks: both years' balance sheets must balance; the cross-year check
    compares each report's comparative column with the neighbouring
    report; EPS × shares vs profit only warns.
  - Per-share figures are never unit-scaled.
- Extraction runs through `mcp/archive-server.js` + `mcp/archive/EXTRACT.md`
  + `mcp/scripts/extract-archive.sh` (cron on the home server, stops early on
  a usage limit). Status: `/api/archive/status`. `/api/archive/prioritise`
  moves reports to the front of the queue.
- When the archive site is down it can answer 404 for everything (24 Oct
  2026: 1,134 reports written off in 14 minutes). Three not-founds in a row
  now stop the run and go back in the queue. 404s that came in a burst (10+
  in an hour) are requeued by `retryTransientFailures`, which the daily top-up
  step runs.

Backtest pieces built on the data above:
- `lib/backtest/globalPrices.js`: monthly USD total returns rebuilt from
  dividend events, plus FX, oil and PSX price indices.
- `lib/backtest/shariah.js`: KMI-style screen.
- `lib/backtest/asOf.js`: the time machine. Point-in-time rows run through
  the production `scores`, `valuation` and `gradeRow` code.
- `lib/backtest/diagnostics.js`: factor information coefficients and
  quintile spreads.
- `lib/backtest/blind.js`: anonymised tasks that test Claude's judgement
  without hindsight, with leakage checks.
- `mcp/scripts/backtest.js`: the walk-forward engine, using the production
  `constructPortfolio`. 2023 onwards is held out unless `--holdout`.
- `mcp/scripts/gdelt-daily.py` + `geo-indicators.js`: GDELT news indicators.

Routes are under `/api/backtest/*` and need the write token.

### News and geopolitics

`lib/news.js` in the backend collects 20 RSS feeds every hour and keeps 90
days of articles, de-duplicated across sources. Pakistani sources include
Business Recorder, Dawn, Tribune and The News. Global ones include Bloomberg
and FT (headlines and RSS summaries only, since they're paywalled; article
pages are never fetched), Nikkei, SCMP, CNBC, BBC, Arab News, Middle East
Eye, OilPrice and the Fed.

`mcp/scripts/news-digest.sh` runs nightly at 02:30 PKT from cron on the home
server. It starts one headless `claude -p` session with
`mcp/news-server.js`, following `mcp/news/DIGEST.md`. That session tags the
articles that matter (importance 1-3, themes, markets, sectors, symbols),
writes the daily brief and updates the risk register (severity 1-5,
direction, history, evidence). Untagged articles in the batch count as
importance 0.

Access:
- MCP tools: `get_news`, `get_geo_brief`, `get_risk_register`.
- App: Insights, under "News & risks", and "In the news" on each research
  page.

News never changes the models automatically. It informs stress-scenario
choice, explicit Black-Litterman views and reviews.

Conventions every layer relies on: ratios and returns are fractions (0.12 =
12%), money is in full currency units (PSX publishes thousands; scaled on the
way in), missing data is `null` never `0`, and every fundamentals or holdings
payload carries `sources` and an as-of date.

Data sources worth knowing before debugging: since October 2026
dps.psx.com.pk answers 403/404 on `/timeseries` and `/symbols`, so PSX price
history and index history come from Sarmaaya's REST API; PSX company and ETF
pages still scrape fine and supply fundamentals and index constituents.

## This repo

```bash
npm run dev
npx vite build
npm test          # analytics unit tests (node:test)
```

- The repo is **public**. No secrets, tokens, internal addresses or
  server-side config in committed files.
- The frontend reads the backend over HTTPS through the home server's reverse
  proxy — see `CLAUDE.local.md` for the hostname and routing.
- There is a fair amount of scratch still tracked at the repo root
  (`modal_*.txt`, `restored_*.jsx`, `scratch/`, loose `test_*.js` and `*.py`).
  Some of it is not even from this project. Worth clearing out; left alone so
  far only because none of it is a deployment hazard.
