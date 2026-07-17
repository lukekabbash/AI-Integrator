---
name: stooq
description: Fetch keyless Stooq historical OHLCV for supported stocks, ETFs, indices, FX pairs, and other instruments. Use when the user names Stooq, needs a long price history without an API key, or wants a second-source historical cross-check.
---

# Stooq

Use Stooq for keyless historical data. Treat its downloadable CSV as a website
contract, not a documented production API, realtime feed, fundamentals source,
or service-level guarantee.

## URL shape

Daily history:

```text
https://stooq.com/q/d/l/?s=aapl.us&i=d&d1=20240101&d2=20241231
```

Common interval codes are `d` daily, `w` weekly, `m` monthly, `q` quarterly,
and `y` yearly. Prefer daily observations when downstream resampling must be
transparent.

Typical columns are:

```text
Date,Open,High,Low,Close,Volume
```

Require at least `Date` and `Close`; some instruments may omit fields.

## Symbol resolution

- Use the exact identifier shown by Stooq.
- US listings commonly use `.us`, for example `aapl.us`.
- Indices may use caret-prefixed identifiers such as `^spx`.
- FX pairs can be bare, such as `eurusd`.
- Other markets use provider-specific suffixes. Do not silently append a
  suffix when exchange, share class, currency, or country is ambiguous.
- State the mapping used, for example `AAPL` user ticker to `aapl.us` Stooq
  symbol.

## Method

1. Resolve the exact symbol before fetching.
2. Request one instrument and an explicit date range.
3. Parse CSV and sort by date before calculations.
4. Reject negative prices and malformed dates. Weekend and market-holiday
   gaps are normal; unexplained trading-day gaps need a cross-check.
5. State requested range, returned range, row count, last observation, source,
   and retrieval time.
6. Cache successful downloads instead of repeatedly hitting the website.

Stooq may present a JavaScript browser-verification page or return
`Access denied`, especially from hosted or rotating network paths. Stop in
that state. Use the user-controlled browser's manual CSV download or ask
whether Alpha Vantage or yfinance is acceptable. Do not loop around the
control or launch a broad parallel scrape.

## Data boundaries

The CSV does not reliably carry exchange timezone, quote currency,
corporate-action adjustment methodology, survivorship treatment, or freshness
entitlement. Do not infer those from OHLCV column names.

Cross-check large discontinuities, zero or missing volume, symbol changes,
splits, dividends, and redenominations with another source. Name every
sorting, resampling, return, or adjustment transformation.

Provide data and calculations, not buy/sell recommendations or price
predictions.
