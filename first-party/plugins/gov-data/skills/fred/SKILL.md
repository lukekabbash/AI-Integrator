---
name: fred
description: Fetch US and international economic time series from FRED (Federal Reserve Economic Data) — GDP, CPI, unemployment, interest rates, money supply, and 800k+ other series. Use when the user asks about economic indicators, macro data, or charts of economic history.
---

# FRED (Federal Reserve Economic Data)

## Requirements

A free API key from https://fred.stlouisfed.org/docs/api/api_key.html, set as
the environment variable `FRED_API_KEY`. If it is missing, tell the user how
to get one — do not proceed with scraping.

## Core endpoints

Base: `https://api.stlouisfed.org/fred/`

- Observations (the data):
  `series/observations?series_id=GDP&api_key=$FRED_API_KEY&file_type=json`
  Optional: `observation_start=YYYY-MM-DD`, `observation_end`, `units`
  (`pc1` = % change from year ago, `pch` = % change), `frequency` (`q`, `a`).
- Search for a series id:
  `series/search?search_text=median+home+price&api_key=...&file_type=json`
- Series metadata: `series?series_id=CPIAUCSL&...`

## Series ids you should know

GDP `GDP` (nominal, quarterly) / `GDPC1` (real) · CPI `CPIAUCSL` · Core CPI
`CPILFESL` · Unemployment `UNRATE` · Nonfarm payrolls `PAYEMS` · Fed funds
`FEDFUNDS` (monthly) / `DFF` (daily) · 10Y Treasury `DGS10` · 2Y `DGS2` ·
30Y mortgage `MORTGAGE30US` · Case-Shiller `CSUSHPINSA` · M2 `M2SL` ·
Recession flag `USREC`. When unsure, use the search endpoint rather than
guessing an id.

## Method

1. Resolve the series id (known table above, else search endpoint).
2. Fetch observations with an explicit date range; values arrive as strings,
   `"."` means missing — filter those before math.
3. State the units and seasonal adjustment from the series metadata when
   presenting; FRED series differ (levels vs indices vs percents) and mixing
   them is the most common error.
4. Respect the data: cite the series id and last observation date in output.

## Failure modes

- 400 with "Bad Request" usually means a wrong series id — search first.
- The API is rate limited (~120 req/min); batch date ranges instead of
  looping per-year.
