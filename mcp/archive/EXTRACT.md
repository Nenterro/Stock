# Extracting statements from an archived PSX annual report

You are reading one historical annual report of a PSX-listed company, for a
backtest. The figures will be used as they were known at the time, so read
them **as published in this report**. Never "correct" them with later
knowledge, and don't use anything you remember about the company: only this
document.

The backend checks what you submit. The balance sheet must balance, for both
the current and the comparative year. Your figures are also compared with the
company's neighbouring years (a report's comparative column should match the
previous report). Read carefully.

## Steps

1. `archive_next` gives one report. If it returns `empty`, stop and reply
   `RESULT EMPTY`.
2. **mode "text":** the likely statement pages are included as text,
   chosen by headings and figure density, along with a list of all
   candidate pages.
   - Check that you have the **unconsolidated** (standalone) statement of
     financial position, statement of profit or loss, and statement of cash
     flows.
   - If the pages given are the wrong ones (notes, the consolidated set, a
     ten-year summary) or the text is garbled, call `archive_pages` for the
     right page numbers (from `candidates`) and read the images.
   - A statement can continue onto the next page; the next page is usually
     included.
3. **mode "scanned":** look at the contact sheets with the Read tool.
   - Thumbnails are labelled `t-<page>`; find the primary statements. They
     come after the directors' report and the auditor's report, as a run of
     dense number tables, usually unconsolidated first.
   - Call `archive_pages` for those pages (up to 12) and read the images.
4. Call `archive_submit`. If it's rejected, re-read the pages concerned and
   resubmit; you have two corrections. Never adjust a figure only to pass a
   check. If a figure is right but a check fails, submit as read and explain
   in `notes`.
5. If this isn't an annual report with primary statements, use
   `archive_skip` with the reason.

## What to submit

The fields are as in the tool schema.
- `unit`: the unit printed on the statements (`thousands` for Rupees '000,
  `millions`, or `rupees`). Report figures exactly in that unit.
- `periodEnd`: the balance-sheet date, YYYY-MM-DD.
- `periodMonths`: usually 12. A changed year end can give an odd period
  (e.g. 18 months); say so in `notes`.
- `statementType`: `industrial`, `bank` or `insurance`.
- `basis`: `unconsolidated` unless only consolidated statements exist.

`balanceSheet` (current year):
- `totalAssets` and `totalEquity` (owners' equity; give non-controlling
  interest separately).
- `totalLiabilities`, or `currentLiabilities` + `nonCurrentLiabilities`.
- Where printed: `currentAssets`, `cashAndEquivalents`,
  `shortTermInvestments`, `tradeReceivables`, `inventories` (stock in trade,
  plus stores and spares only if the statement totals them together),
  `shareCapital`.
- `totalBorrowings`: all interest-bearing or financing debt, i.e. long-term
  financing incl. current portion, short-term borrowings, running finance,
  sukuk, lease liabilities. Use 0 if there is none.
- Banks: `deposits`, `advances` (or Islamic financing), `investments`.

Old formats: before about 2018 many reports show "share capital and
reserves" at the top and liabilities below, sometimes without a total
liabilities line. Then give current and non-current liabilities, or compute
nothing and give what is printed. Some older balance sheets put
"surplus on revaluation of fixed assets" outside equity. Include it in
`totalEquity` and say so in `notes`, so the balance check still works.

`incomeStatement`: `revenue` (net sales; banks: net markup income plus
non-markup income if totalled), `grossProfit`, `operatingProfit`,
`financeCost`, `otherIncome`, `profitBeforeTax`, `profitAfterTax`,
`profitAttributableToOwners`, `eps` (basic).

`cashFlow`: `operatingCashFlow`, `capex` (fixed capital expenditure, as a
positive number), `dividendsPaid` (positive).

`priorYear`: from the comparative column, previous year's `totalAssets`,
`totalEquity`, `totalLiabilities` (or leave it out if not printed),
`profitAfterTax`, `revenue`. If the comparatives are marked "restated", use
them as printed and note the restatement.

`sharesOutstanding`: the number of ordinary shares at year end, from the
share capital note or the face of the balance sheet ("X ordinary shares of
Rs 10 each"). Give the count itself, not thousands. `faceValue`: the par
value.

### Shariah screening inputs (industrial companies)

The backtest rebuilds each year's Shariah status from these. Getting them
right matters as much as the totals.

- `islamicFinancing`: the part of `totalBorrowings` that is Islamic
  (diminishing musharaka, sukuk, ijarah, murabaha, istisna, Islamic running
  finance).
  - The balance sheet rarely shows the split; the financing notes do.
  - `archive_next` lists likely note pages in `notePages`. Read them with
    `archive_text` (text reports) or `archive_pages` (scanned).
  - Notes usually say "from Islamic banks / under Shariah-compliant
    arrangements" or "conventional / at KIBOR + x%".
  - Give 0 if all financing is conventional. Leave it out only if the notes
    don't say.
- `interestIncome`: income from *conventional* interest-bearing assets:
  interest or markup on bank deposits, TDRs, T-bills, PIBs, savings
  accounts, loans to others.
  - Find it in the other income or finance income note, or as "interest
    received" in the cash flow when the note isn't available.
  - Exclude profit on Islamic deposits or sukuk, dividends and exchange
    gains.
  - Give 0 if there is none. Leave it out only if you can't tell.

- `conventionalInvestments`: assets held in *conventional* interest-bearing
  form: deposits and savings accounts with conventional banks, TDRs, T-bills,
  PIBs, conventional mutual funds, loans given at interest.
  - Islamic bank deposits, sukuk, Islamic funds and equity shares are not
    included.
  - Give 0 if there are none. Leave it out only if you can't tell.

Since about 2018, reports carry a **Shariah compliance disclosure** note
(Companies Act 2017, Fourth Schedule). It states Islamic vs conventional
financing, Shariah-compliant vs conventional bank deposits, and profit from
each. When it exists, use it first. It's often near the end of the notes, so
search the candidate pages for "Shariah".

For companies with no borrowings and no notable cash, these take one quick
look. Don't spend long on them for banks and insurers: their business
decides their status.

`pagesUsed`: the page numbers you read.

## Accuracy

- Brackets mean negative.
- Check the column header (current vs comparative) before every figure.
- For banks, the unconsolidated statements are usually printed first.

End with one line: `RESULT <id> <status>`.
