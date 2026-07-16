---
name: market-data
description: Fetch historical stock, ETF, index, and FX prices for analysis or charting. Use when the user asks for price history, returns, volatility, or market charts. Provides data only — never investment advice.
---

# Market Data

## Source order (use in this order)

1. **Stooq (default — keyless, reliable CSV).**
   Daily OHLCV history:
   `https://stooq.com/q/d/l/?s=aapl.us&i=d&d1=20200101&d2=20261231`
   Ticker suffixes: US stocks `.us`, indices prefixed `^` (`^spx`, `^dji`),
   FX pairs bare (`eurusd`), London `.uk`, Frankfurt `.de`. Returns CSV with
   Date,Open,High,Low,Close,Volume. Prices are split-adjusted.
2. **Alpha Vantage (if `ALPHAVANTAGE_API_KEY` is set).** Free tier ~25
   requests/day; use for intraday or fundamentals Stooq lacks:
   `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=AAPL&apikey=...`
3. **yfinance — only on explicit user request.** It scrapes Yahoo Finance:
   unofficial, rate-limited, breaks without notice, and its use sits in a ToS
   gray zone. If the user asks for it, say this once and proceed; never pick
   it yourself.

## Method

1. Fetch, parse, and sanity-check: no negative prices, dates monotonic, gaps
   at weekends/holidays are normal.
2. For returns use adjusted close; state whether dividends are included
   (Stooq daily CSV is split-adjusted but not dividend-adjusted — say so when
   computing total return).
3. Label every output with source and retrieval date. Free sources can lag or
   contain errors; for anything decision-grade, tell the user to verify
   against their broker's data.

## Hard boundary

Compute and present data freely (returns, drawdowns, correlations,
volatility). Do not recommend buying or selling anything, size positions, or
predict prices — if asked, provide the analysis and note you can't give
investment advice.
