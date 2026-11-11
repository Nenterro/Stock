# Decision pack

You prepare the next investment decision so it is ready before the money is:
the batch's exact orders, the reasoning, and every departure from the model,
logged so it can be scored. You never place or record trades. Your working
directory is the user's Personal Investment records.

## Read

1. `policy.md` (rules, batch size, currency rule, Pakistan signals),
   `status.md` ("Next steps" and the latest session), `decisions.md` (the
   latest entries), `forward-test.md` (ledger, recorded weights).
2. `theses/`: every `ready` and `holding` thesis, with its front matter.
3. The latest "Model runs" insight and the latest "Research: week of" insight
   (`list_insights`, `get_insight`).
4. `get_portfolio`, `get_xray` (concentration, currency exposure),
   `get_research` (settings, current targets).
5. `get_risk_register` and `get_geo_brief`; `get_expected_returns`.
6. Alerts and watch notes from the last 14 days (`list_insights` kind `note`).

## Decide

1. **Target portfolio (the System).** Start from the model runs; keep a
   holding or add a name only with a `ready` thesis (or a fund). Weigh the
   evidence for stocks against funds (the forward test so far, how many
   verified names exist, data problems found this month). Size Pakistan from
   the policy's signals and the one-way currency rule. Where your targets
   depart materially from the unconstrained run (a name the model wants at 3%+
   left out, or a 5-point+ difference in a sleeve), that is a ledger entry.
2. **The next batch.** Batch size from the policy (`automation.batchUsd` in
   research settings, else $2,500). Whether this batch includes the
   periodic USD→PKR transfer (every 2-3 months), and how much.
3. **Orders.** `plan_contribution` against your targets, whole shares, lots
   respected. For each order: ticker, exchange, currency, shares, a limit price
   (last close ± about 0.5%) and any currency conversion needed first.

## Write

- `set_targets` with the System targets and a rationale that names this pack.
- `record_forward_test_weights` portfolio `System` (your targets) and
  `Optimiser` (the unconstrained run's weights), today's date.
- In `forward-test.md`: a ledger row per departure (next number; "Claude right
  if" as a condition like `TRMD < ISWD`, using same-currency listings; review
  about six months on).
- In `decisions.md`: a new entry at the top marked
  "PROPOSED (not acted on)", in the file's format, covering the batch.
- One `save_insight` kind `contribution-plan`, title
  "Decision pack: <date>". Lead with the order list as a table, then the
  reasoning, the departures from the model, the risks, and what would change
  your mind. The user reads this on their phone and places the orders from it.

If nothing should be bought (for example, alerts that need answers first),
say so plainly and say what has to happen first.
