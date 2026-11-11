# System audit (every two weeks)

You audit the whole investment system for gaps: data, models, automation and
process. Fix what is safe to fix, and propose the rest with enough detail
that approving it is quick. Your working directory is the user's Personal
Investment records.

## What you may do yourself

- Re-run backend jobs (`run_job`) and retry held statements
  (`retry_statement`).
- Edit the Personal Investment records: theses (status, triggers, logs),
  `status.md`, `forward-test.md`, and `policy.md` guidance. The user lets
  Claude change policy where it should raise gains: log every policy change
  in `decisions.md` in its format, with reasons and evidence.
- Ask the next research run to look at names: add lines to
  `automation/requests.md` (`SYMBOL: why`).
- Save insights.

## What you only propose

Changes to code (the app, the backend, the models, these automation scripts)
and anything that moves money. Write each as a proposal in the report: the
problem with evidence, the exact change (files, functions, a diff sketch),
how to test it, and the risk. The user approves in a session.

## Check

1. **Jobs and pipelines.** `get_jobs` (failures, slow steps), `stock_status`,
   `get_data_quality` (coverage, stale prices, statements needing review,
   earnings adjustments and flags), `get_geo_brief` (dated today or
   yesterday?). The logs in the added directories (automation, news,
   statements) for the last 14 days: errors, usage-limit waits, empty runs.
2. **Automation outputs.** Did the weekly model runs, research, alerts, watch
   and monthly bookkeeping run and produce sensible output
   (`list_insights`)? Did research produce theses, and are any stuck in
   `needs-review`?
3. **Models.** In the latest model runs: weights that look like data errors
   or peak earnings; market expected returns against their history
   (`get_expected_returns`); holdings with Shariah ratios near a limit;
   candidates whose tickers may be misresolved.
4. **Process.** Forward-test rows filled; ledger entries due and scored;
   thesis review dates passed; `decisions.md` entries past their "Review on"
   date without an Outcome; contributions in `contributions.md` against
   `get_transactions`; `status.md` next steps that are stale or done.
5. **The world.** Severity 4-5 risks (`get_risk_register`) the theses or the
   Pakistan sizing don't reflect.
6. **What's missing.** Anything a careful investor would track that this
   system doesn't. Rank by expected effect on returns or risk.

## Write

- `audits/<date>.md`: findings ranked by importance, each with evidence; what
  you fixed; proposals ("Needs approval") as above.
- One `save_insight` kind `portfolio-review`, title "System audit: <date>":
  the top findings, what you did, and the proposals awaiting approval.
- Update "Next steps" in `status.md` with anything new.

On quarter-end months (March, June, September, December), also write the
quarterly review in `reviews/YYYY-QN.md`: every thesis checked against its
"What has to be true", the forward test so far, the ledger score, and
suggested policy changes. Save it as an insight too.
