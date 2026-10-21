# Extracting financial statements from a PSX filing

You are reading one PSX company's financial-results filing (usually scanned
pages) and recording its key figures. The backend checks everything you
submit: the balance sheet must balance, and profit must match the figure PSX
publishes. A wrong number is rejected, so read carefully rather than quickly.

## Steps

1. Call `statements_next`. It returns one filing: company, sector, the pages
   (image files and, if the PDF has a text layer, the text), PSX's own profit
   figures for this company, and the company's previous captured periods.
   If it returns `empty`, stop: there is nothing to do.
2. Find the primary statements. In results announcements they are usually on
   pages 2-10; in full reports they come after the directors' report. Look at
   page images with the Read tool, a few at a time. You do not need every page.
   - Statement of financial position (balance sheet)
   - Statement of profit or loss (income statement)
   - Statement of cash flows (often absent from short announcements; fine)
3. Read the **unconsolidated** (standalone) statements when the filing has both
   unconsolidated and consolidated. PSX's profit figures are unconsolidated
   for most companies. If only consolidated statements are present, use them
   and set `basis: "consolidated"`.
4. Read the **current period column**, not the comparative.
5. Call `statements_submit` with the figures below. If it reports problems,
   look again at the pages it concerns, correct the figure, and submit again
   (up to two corrections). Never adjust a figure just to pass a check: if a
   figure is right but a check fails, explain why in `notes` and submit as read.
6. If the document has no balance sheet or no income statement (some
   announcements are only a dividend notice), call `statements_skip` with the
   reason; the backend moves on to the full report for that period.

## What to submit

`unit`: the unit stated on the statements: `"thousands"` (Rupees '000, by far
the most common), `"millions"`, or `"rupees"`. Report figures exactly as
printed in that unit; the backend converts.

`periodEnd`: the date the statements are made up to (YYYY-MM-DD).
`periodMonths`: months covered by the profit figure: 3, 6, 9 or 12. A
"half year" is 6; "nine months" is 9; an annual report is 12. If the income
statement shows both a quarter and a cumulative period, use the cumulative
period here and give the quarter as `periodProfitAfterTax`.

`statementType`: `"industrial"` for normal companies, `"bank"` for banks,
`"insurance"` for insurers.

`balanceSheet` (current period):
- `totalAssets`
- `totalEquity`: equity attributable to the company's owners (exclude
  non-controlling interest; give that separately as `nonControllingInterest`)
- `totalLiabilities`: if the statement doesn't print a total, give
  `currentLiabilities` and `nonCurrentLiabilities` instead
- `currentAssets`, `currentLiabilities` (industrial)
- `cashAndEquivalents`: cash and bank balances
- `shortTermInvestments`
- `tradeReceivables`: trade debts / trade receivables (for energy companies
  this is where circular debt sits; include the full balance)
- `inventories`
- `totalBorrowings`: all interest-bearing debt: long-term financing, current
  portion of long-term financing, short-term borrowings, running finance,
  lease liabilities. Islamic financing (musharaka, sukuk, ijarah) counts.
  Use 0 if the company has none, and leave it out only if you can't tell.
- banks: `deposits`, `advances` (financing), `investments`

`incomeStatement`:
- `revenue`: net sales / revenue (banks: net mark-up income plus non-mark-up
  income, if a total is printed; otherwise leave out)
- `grossProfit`, `operatingProfit`, `financeCost` (where printed)
- `profitBeforeTax`
- `profitAfterTax`: profit for the period (cumulative period)
- `profitAttributableToOwners`: if the statement splits profit between owners
  and non-controlling interest
- `periodProfitAfterTax`: the quarter's profit, when a quarter column exists
- `eps`: basic EPS for the period

`cashFlow` (if present): `operatingCashFlow` (net cash from operating
activities), `capex` (purchase of property, plant and equipment, plus
development and exploration expenditure for oil and gas companies, as a
positive number).

`priorYearEndEquity`: total equity at the previous financial year end, from
the balance sheet's comparative column (needed for return on equity).

`pagesUsed`: the page numbers you read the figures from.
`notes`: anything unusual: restatements, a change of year end, figures you
were unsure of and why.

## Accuracy

- Brackets mean negative: (12,345) is -12345.
- Check the column header (current vs comparative, unconsolidated vs
  consolidated) before every figure.
- Total assets must equal total equity plus total liabilities on the page
  itself; if your numbers don't, you have misread one.
- Do not estimate or derive a figure the statements don't print; leave it out.
