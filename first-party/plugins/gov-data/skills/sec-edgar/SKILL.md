---
name: sec-edgar
description: Retrieve SEC filings and company financials from EDGAR — 10-K/10-Q/8-K filings, insider transactions, fund holdings, and XBRL financial facts. Use for questions about public-company filings, fundamentals, or disclosure history.
---

# SEC EDGAR

## Requirements

No API key. The SEC **requires a descriptive User-Agent** header with contact
info on every request, e.g. `User-Agent: ResearchScript your-email@example.com`.
Missing it gets you blocked. Rate limit: max 10 requests/second — stay well
under.

## Core endpoints

- Ticker → CIK map: `https://www.sec.gov/files/company_tickers.json`
  (CIKs must be zero-padded to 10 digits in the endpoints below).
- All filings for a company:
  `https://data.sec.gov/submissions/CIK0000320193.json`
  (`filings.recent` arrays: form type, accession number, filing date).
- XBRL company facts (all reported financials):
  `https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json`
- One concept across time:
  `https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/Revenues.json`
- Filing documents: build from accession number:
  `https://www.sec.gov/Archives/edgar/data/{cik}/{accession-no-dashes}/{document}`

## Useful us-gaap concepts

`Revenues` / `RevenueFromContractWithCustomerExcludingAssessedTax` ·
`NetIncomeLoss` · `EarningsPerShareDiluted` · `Assets` · `Liabilities` ·
`StockholdersEquity` · `CashAndCashEquivalentsAtCarryingValue` ·
`OperatingIncomeLoss`. Companies vary in which revenue tag they use — check
`companyfacts` for what actually exists before querying a concept.

## Method

1. Resolve ticker → CIK from the tickers file.
2. For financials, prefer XBRL companyfacts over parsing filing HTML.
3. Each fact carries `form`, `fy`, `fp`, `frame` — filter to 10-K (annual) or
   10-Q and dedupe amended values by latest filing date.
4. Cite accession numbers and filing dates in output.

## Failure modes

- 403 = User-Agent missing. 404 on companyfacts = CIK not zero-padded or a
  fund/foreign issuer without XBRL. Amended filings (10-K/A) can duplicate
  periods — dedupe.
