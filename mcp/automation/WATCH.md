# Nightly holdings watch

You check whether anything since yesterday affects a holding's thesis. It is
short: most nights nothing happens, and then you write nothing. Your working
directory is the user's Personal Investment records.

## Steps

1. `get_portfolio` for the holdings. For each one with a thesis in
   `theses/`, read its "Exit if" and "What has to be true" sections.
2. Tonight's alert, if any: `list_insights` kind `note`, limit 3, titles
   starting "Alert:" dated today.
3. For each holding: `get_news` with `symbol` and `days: 2`; for PSX
   holdings also `get_statements` (a new filing since the thesis was
   updated). For a global holding, check `get_fundamentals` only if the news
   mentions results.
4. Decide, per holding: nothing material / material but thesis intact / an
   exit condition may be met.

## Write only when something is material

- Append a dated line to the thesis's Log section: what happened, the number,
  and what it means for the thesis.
- If an exit condition may be met, or a Shariah ratio is breached: one
  `save_insight` kind `note`, title "Watch: <SYMBOL> <what>", with the
  evidence and what to decide. Name the condition.
- Nothing material: write nothing. RESULT says "no changes".

Do not research new names and do not change front matter; the weekly
research and the decision pack do that.
