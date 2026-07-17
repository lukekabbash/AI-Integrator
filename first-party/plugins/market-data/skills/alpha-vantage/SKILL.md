---
name: alpha-vantage
description: Fetch Alpha Vantage equity, ETF, FX, crypto, commodity, macro, fundamental, news, and technical-indicator data through AI Integrator's credential-safe provider route. Use when the user names Alpha Vantage, needs intraday or provider-computed data, or wants a keyed alternative to public Yahoo or Stooq data.
---

# Alpha Vantage

## Requirements and security

A free or paid Alpha Vantage API key saved in AI Integrator Settings is
required for requests. Call `skill_data_request` on the `integrator` MCP
server with provider `alpha-vantage`. AI Integrator injects the key inside the
native app.

Never ask for, print, inspect, or include the key in a query. The `apikey`
parameter is reserved and rejected. If the key is missing, direct the user to
https://www.alphavantage.co/support/#api-key and AI Integrator Settings.

## Core requests

Raw daily OHLCV:

```json
{"provider":"alpha-vantage","query":{"function":"TIME_SERIES_DAILY","symbol":"AAPL","outputsize":"compact"}}
```

Lightweight quote:

```json
{"provider":"alpha-vantage","query":{"function":"GLOBAL_QUOTE","symbol":"AAPL"}}
```

Resolve a global symbol before guessing an exchange suffix:

```json
{"provider":"alpha-vantage","query":{"function":"SYMBOL_SEARCH","keywords":"Shopify"}}
```

Intraday bars:

```json
{"provider":"alpha-vantage","query":{"function":"TIME_SERIES_INTRADAY","symbol":"AAPL","interval":"5min","outputsize":"compact"}}
```

## Function families

- Price history: `TIME_SERIES_DAILY`, `TIME_SERIES_INTRADAY`, weekly and
  monthly variants.
- Fundamentals: `OVERVIEW`, `ETF_PROFILE`, `INCOME_STATEMENT`,
  `BALANCE_SHEET`, `CASH_FLOW`, `EARNINGS`.
- FX and crypto: exchange-rate and daily/weekly/monthly time-series functions.
- Macro and commodities: Treasury yields, CPI, unemployment, GDP, oil,
  natural gas, metals, and agricultural series.
- News and events: `NEWS_SENTIMENT`, earnings calendar, IPO calendar,
  dividends, splits, and insider transactions.
- Indicators: `SMA`, `EMA`, `RSI`, `MACD`, `BBANDS`, `ATR`, and others.

Fetch https://www.alphavantage.co/documentation/ before answering
version-specific endpoint, entitlement, or parameter questions. Premium
designations change. Realtime, delayed, and historical data are distinct
entitlements; do not infer realtime status from a recent timestamp.

## Quota discipline

The official support page currently describes the free service as up to 25
requests per day. Treat that as drift-prone and verify it when cost or
production capacity matters.

1. Use `GLOBAL_QUOTE` instead of a full series for one snapshot.
2. Cache one successful bar response and compute several indicators locally
   when practical.
3. Do not retry quota or entitlement messages automatically.
4. Preserve HTTP-200 provider envelopes containing `Error Message`,
   `Information`, or `Note`; they are failures, not empty datasets.

## Data boundaries

- State function, symbol or pair, interval, requested range, last observation,
  fetch time, and entitlement when used.
- Distinguish raw from split/dividend-adjusted data. Current documentation
  presents some adjusted and full-history functions as premium.
- Treat normalized fundamentals and indicators as provider data. Verify
  decision-critical company facts against SEC filings or investor relations.
- Provide data and calculations, not buy/sell recommendations or price
  predictions.
