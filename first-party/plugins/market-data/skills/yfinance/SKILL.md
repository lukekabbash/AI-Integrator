---
name: yfinance
description: Use the unofficial yfinance Python package for convenient Yahoo Finance price history, quote snapshots, corporate actions, options, searches, or lightweight screens. Use when Yahoo data is a practical fit, when Alpha Vantage or Stooq lacks the needed coverage, or when the user names Yahoo Finance or yfinance. Prefer Alpha Vantage or Stooq when they answer the request equally well. This skill does not bundle or install yfinance.
---

# yfinance

Use yfinance when it is the best practical fit for the request. Prefer Alpha
Vantage when a credentialed API, provider-defined endpoint, or clearer
entitlement is useful. Prefer Stooq for straightforward keyless historical
CSV when it is accessible and sufficient. Do not avoid yfinance merely
because the user did not name it.

## Source and dependency boundary

yfinance is an unaffiliated open-source client for Yahoo's public surfaces.
Its project states that it is intended for research and education and that
Yahoo data is intended for personal use. Fetch the current project guidance at
https://github.com/ranaroussi/yfinance and API reference at
https://ranaroussi.github.io/yfinance/ before version-specific work.

AI Integrator does not bundle yfinance as a first-party dependency. Use it
only when it is already available in the selected runtime or after the user
explicitly approves installing it in their own environment. If it is
unavailable, offer Stooq or Alpha Vantage.

## Price history

Single symbol, raw OHLC:

```python
import yfinance as yf

bars = yf.Ticker("AAPL").history(
    period="1y",
    interval="1d",
    auto_adjust=False,
    back_adjust=False,
)
```

Several symbols:

```python
bars = yf.download(
    ["AAPL", "MSFT", "NVDA"],
    period="6mo",
    interval="1d",
    auto_adjust=False,
)
```

Choose adjustment explicitly:

- Raw: `auto_adjust=False`, `back_adjust=False`.
- Auto-adjusted: `auto_adjust=True`, `back_adjust=False`.
- Back-adjusted: `auto_adjust=False`, `back_adjust=True`.

State the choice. In date-range calls, `start` is inclusive and `end` is
exclusive. Intraday history has a shorter available window than daily data;
verify the current documentation instead of fabricating unsupported bars.

## Quotes, actions, and options

- Prefer `Ticker.fast_info` for a lightweight quote snapshot.
- Inspect dividends, splits, and actions explicitly when return calculations
  depend on corporate actions.
- Read `Ticker.options`, validate the requested expiration, then call
  `Ticker.option_chain(expiration)`.
- Record option-chain fetch time and expiration. Bid, ask, last, volume, open
  interest, and implied volatility can be missing or stale; a last trade is
  not an executable price.

## Provider limitations

Expect rate limits, empty frames, delisted or changed symbols, timezone
mismatches, partial option chains, stale values, and upstream response
changes. Treat missing data as missing, not zero.

Yahoo statement, analyst, holder, calendar, and news fields are convenience
data. Verify decision-critical fundamentals against SEC filings or company
investor relations.

State symbol, interval, requested and returned range, adjustment, pre/post
setting, last observation, yfinance version, and retrieval time. Provide data
and calculations, not buy/sell recommendations or price predictions.
