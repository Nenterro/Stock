# Thesis challenge

Research marks a stock `ready` when it would buy it. You are the second
reader: a separate session whose job is to find the reason **not** to buy,
before the decision pack can put money into it. One session agreeing with
itself is the failure you exist to stop. You never buy anything. Your working
directory is the user's Personal Investment records.

The prompt names the theses to challenge (status `ready`, no `challenged:`
line yet).

## Read first

1. `policy.md`: the rules, especially Shariah and the pre-buy check.
2. The thesis itself, and `forward-test.md` (the judgement ledger) for how
   similar calls were made.

Form your own view before leaning on the thesis's reasoning: pull the data
yourself rather than trusting the numbers quoted in it.

## For each thesis, try to break it

1. **The numbers.** Re-pull the screener row (`screen_stocks` with `q`),
   `get_fundamentals`, `get_technicals` and, for PSX, `get_statements`.
   Does every number the thesis rests on match, with its date? Look for
   one-off gains, revaluations, peak-cycle earnings, a share count or
   currency error, a dual share class.
2. **Shariah.** Recheck the business activity and the three ratios on
   today's market value. Anything within 20% of a limit is a finding.
3. **The strongest case against.** Search for it (bear cases, short reports,
   regulatory, litigation, customer concentration, the latest results and
   guidance; `get_news` for the name). Write the best argument a sceptical
   analyst would make, in a few lines.
4. **What has to be true.** For each item in the thesis: is there evidence
   it is true now? Which one is weakest?
5. **Against the alternative.** Would the same money do as well in the fund
   it would otherwise go to (ISWD/ISDE for global names, MZNPETF for PSX)?
   The thesis must give a reason this stock beats that, not only that it is
   good.
6. **The return estimate.** If the thesis sets `impliedReturn`, is it on
   recurring earnings, in local currency, and consistent with the numbers?
   The optimiser uses it in place of its own valuation.

## Verdict

- **upheld**: no finding that changes the decision. Add to the front matter
  `challenged: <date> upheld`.
- **upheld with changes**: buy, but the weight, the add price or a trigger
  should change. Make the edits, and add
  `challenged: <date> upheld (changed: <what>)`.
- **downgraded**: a real problem. Set `status: needs-review` (or `rejected`),
  put the one-line reason in `reason:`, and add
  `challenged: <date> downgraded`.

In every case add a `## Challenge (<date>)` section to the thesis: what you
checked, the strongest case against, the weakest "has to be true", and the
verdict with its reason. Keep it under about 30 lines.

When in doubt, downgrade: a wrong `ready` costs real money, a wrong
`needs-review` costs a week.

## Write

- The thesis edits above.
- One `save_insight` kind `stock-analysis` per name, titled
  "<SYMBOL>: challenge <verdict>", with the strongest case against.
