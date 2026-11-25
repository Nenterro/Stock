# Monthly Pakistan signals

The policy sizes Pakistan (10-40% of new money) from a handful of signals:
lean in when the PSX P/E is low, the rupee is stable, reserves are rising and
the IMF programme is on track; hold back when reserves fall, the current
account widens, the rupee is under pressure, or after a rally to a high P/E.
Until now the decision pack judged these from the news. You score them, once
a month, with numbers, so the sizing has a record that can be checked later.
You never buy anything. Your working directory is the user's Personal
Investment records.

## Read first

1. `policy.md`: the Pakistan sizing signals and the one-way currency rule.
2. `research/pakistan-signals.md`, if it exists: last months' scores, so you
   score the change, not only the level.
3. `get_risk_register` and `get_geo_brief` (Pakistan items).

## Score each signal

For each: the latest value with its date and source, the value 3 and 12
months ago where you can find it, and a score of **+1** (lean in), **0**
(neutral) or **-1** (hold back), with one line why.

1. **Valuation.** PSX market P/E or earnings yield (`get_expected_returns`,
   the PSX and PSX Shariah rows; `screen_stocks` medians if needed) against
   its own 5-10 year range. Low is +1; after a big rally to the top of the
   range, -1.
2. **Rupee.** USD/PKR change over 3 and 12 months (`get_quotes` /
   `get_price_history` where available, else SBP or news), and the real
   effective exchange rate if published. Stable or slowly falling: +1 or 0.
   Sharp moves, an open-market premium or a widening interbank gap: -1.
3. **Reserves.** SBP liquid reserves and months of import cover, and their
   trend (web search: SBP weekly reserves). Rising and above ~3 months: +1.
   Falling for two months or under ~2 months: -1.
4. **Current account.** Latest monthly balance and the fiscal year to date
   (SBP). Surplus or small deficit: +1 or 0; a widening deficit: -1.
5. **IMF programme.** Reviews passed on time, the next tranche, any missed
   targets or waivers. On track: +1; a delayed review: -1.
6. **Interest rates.** SBP policy rate against inflation (real rate), and the
   direction. Cuts with a positive real rate: +1; hikes or a negative real
   rate: -1.
7. **Oil and remittances**, from the risk register: oil above ~$100 widens
   the import bill (-1); remittances growing year on year (+1).

## Conclude

- The total, and how it changed from last month.
- A suggested Pakistan share of **new money** inside the policy's 10-40%,
  and of the PKR transfer in the next batch: roughly 10-15% when the total is
  clearly negative, 25-30% when neutral, 35-40% when clearly positive.
  This is an input to the decision pack, not a rule: say which signals you
  trust least (late or estimated data).
- What would change the call before next month (for example, a reserves
  print or an IMF review date).

## Write

- `research/pakistan-signals.md`: create it if missing with a table
  `| Month | Valuation | Rupee | Reserves | Current account | IMF | Rates | Oil/remittances | Total | Suggested Pakistan share | Notes |`,
  and add this month's row (never edit past rows). Below the table, replace
  the "Latest" section with this month's values, dates and sources.
- One `save_insight` kind `market`, title "Pakistan signals: <YYYY-MM>":
  the table row, each signal in a line, the suggested share and what would
  change it.
