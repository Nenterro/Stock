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
`fundamentals.js`, `holdings.js` (fund look-through), `technicals.js`,
`screener.js` (nightly snapshot in `data/screener.json`), `overrides.js`
(manual fund/fundamentals data, `data/overrides.json`), `taxonomy.js` (one
sector vocabulary across PSX, Yahoo and justETF). Write routes need
`Authorization: Bearer $STOCK_API_WRITE_TOKEN`.

### Models, and when they run

Backend jobs (`lib/jobs.js`, Pakistan time; status at `/api/jobs`):

- **daily 00:00** - screener build (PSX + global rows, technicals on adjusted
  closes), then the market-wide models in `lib/models/`: expected returns per
  market and fund (`expectedReturns.js`, written to `data/expected_returns.json`),
  per-stock valuation (`valuation.js`: two-stage earnings model solved for
  implied return / implied growth / fair value, plus peer multiples) and factor
  scores (`scores.js`: percentiles vs market and sector, composite with
  coverage), then the data-quality report (`dataQuality.js`).
- **monthly, 1st, 00:00** - global universe (`globalUniverse.js`, ~5,100 stocks
  on IBKR markets) and global fundamentals (`fundamentalsGlobal.js`, one Yahoo
  call per stock), then the daily steps.

Portfolio models run on demand, in `src/utils/models/` (shared by the Planner
page and the MCP tool `build_model_portfolio`): `risk.js` (monthly USD
returns, short histories filled from KSE-100 TR / S&P 500, Ledoit-Wolf),
`optimize.js` (Black-Litterman, constrained mean-variance via projected
gradient with Dykstra projections, min-variance, max-Sharpe, risk parity),
`simulate.js` (block-bootstrap projection of the contribution plan, stress
tests), `construct.js` (policy sleeves, views, the end-to-end run),
`pipeline.js` (data in, everything out). Tests: `npm test` here, and
`node --test test/` in `~/Docker/stock-api`.

PSX price history is adjusted on the way in (`lib/adjust.js`): weekend rows
dropped, splits/bonuses/dividends back-adjusted into `adjClose` (event feed
where it has the event, PSX's 10% circuit breaker to detect the rest). Raw
`price` is kept for valuing holdings; every return, risk and model figure uses
`adjClose`. KSE100TR / KMI30TR are total-return estimates of the price indices.

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
