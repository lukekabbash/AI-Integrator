---
name: bls
description: Fetch US labor statistics from the Bureau of Labor Statistics API — CPI detail, unemployment, wages, employment by industry and region, productivity. Use for questions about jobs data, inflation components, or wage growth.
---

# BLS (Bureau of Labor Statistics)

## Requirements

Works without a key for small volumes (v2 API allows limited daily queries
unregistered; a free registration key raises the cap to 500/day). Users can
save that optional key in AI Integrator Settings. Call `skill_data_request`
on the `integrator` MCP server with provider `bls`; it adds
`registrationkey` without exposing the secret.

## Core endpoint

POST `https://api.bls.gov/publicAPI/v2/timeseries/data/` with JSON body:

```json
{
  "seriesid": ["CUUR0000SA0", "LNS14000000"],
  "startyear": "2020",
  "endyear": "2026"
}
```

Up to 50 series per request (25 unregistered), 20-year range max per call.

## Series ids you should know

CPI-U all items `CUUR0000SA0` · CPI-U core `CUUR0000SA0L1E` · Unemployment
rate `LNS14000000` · Nonfarm employment `CES0000000001` · Avg hourly earnings
`CES0500000003` · Job openings (JOLTS) `JTS000000000000000JOL` · Employment
cost index `CIU1010000000000A`. BLS series ids encode survey + area + item;
when constructing unfamiliar ones, look up the format on
https://www.bls.gov/help/hlpforma.htm rather than guessing.

## Method

1. Batch all needed series into one POST.
2. Response nests as `Results.series[].data[]` with `year`, `period`
   (`M01`–`M12`, `M13` = annual avg), `value`. Filter `M13` unless the user
   wants annual averages.
3. BLS data is often NSA by default — say which you're using.

## Failure modes

- `REQUEST_NOT_PROCESSED` with a daily-threshold message: quota exhausted;
  tell the user to register a key.
- Empty `data` for a valid-looking id usually means a discontinued series.
