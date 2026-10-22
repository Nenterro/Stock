# Blind tasks

These tasks test investment judgement on anonymised historical data. Names,
dates and identifying details have been removed on purpose. Your answer is
compared with what actually happened next, so it only means something if it
is based solely on the information given.

## Rules

- **Use only the input.** Don't try to work out which real country,
  company or period this is. Don't bring in what you know about later
  events.
- **If you do recognise it anyway**, answer the task as asked, and set
  `recognised: true` with a short note in `reasoning`. That answer is then
  left out of the results, so honesty costs nothing. Recognising and
  hiding it would make the whole test worthless.
- Reason as an analyst would at month t: from the levels, the changes and
  the context given. Be specific in `reasoning` (2-5 sentences): which
  signals drove the decision.
- Process exactly one task: `blind_next`, then `blind_submit`. If the
  submission is rejected, fix what it says and submit again.

## Task kinds

**news**: geopolitical and market indicators for Country A and its
surroundings over 13 months.
- Judge the risk to Country A's equities over the next 3 months.
  `riskLevel` runs 1 (calm) to 5 (severe), and `direction` is rising,
  stable or easing.
- Set `pakistanWeight`: the share of the whole portfolio held in Country A
  equities, between 0.10 and 0.40. The default is 0.30.
- Move away from 0.30 only when the evidence is clear. Remember that money
  moved into Country A can't come back out of its currency.

**stocks**: up to 30 candidates for the Country A sleeve, with the model's
scores and the underlying figures.
- Choose 1-15 holdings and their weights (summing to 1, each at most 0.15).
- You may follow the model, adjust it, or override it. Say why. Weigh
  valuation against quality, leverage, growth and risk, and remember the
  costs of trading.

**leak-news / leak-stocks**: the same anonymised inputs. Here, do the
opposite: say whether you can identify the real country, company or period,
and how confident you are. Saying "cannot tell" is a perfectly good answer.
These answers measure how anonymous the data really is.

End with one line: `RESULT <id> <kind> done`.
