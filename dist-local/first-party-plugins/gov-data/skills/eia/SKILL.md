---
name: eia
description: Fetch US energy data from the EIA API — electricity generation and prices, natural gas, crude oil and gasoline prices, renewables capacity, CO2 emissions. Use for questions about energy markets, fuel prices, or the power grid.
---

# EIA (US Energy Information Administration)

## Requirements

A free key from https://www.eia.gov/opendata/register.php saved in AI
Integrator Settings. Required for all requests. Call `skill_data_request` on
the `integrator` MCP server with provider `eia`; never ask for, print, or
inspect the key.

## Core pattern (APIv2)

Call `skill_data_request` with `provider: "eia"`, `path` set to the literal
string below (leading slash, `/v2/` prefix included — it is NOT relative to a
base URL), and the parameters in `query`, never appended to `path`.

Data requests take the form:

`path: "/v2/{route}/data/"`,
`query: {"frequency": "monthly", "data[0]": "value", "start": "2020-01", "sort[0][column]": "period", "sort[0][direction]": "desc", ...facets}`.

Discover routes by walking the tree: a request to any non-`/data` route (e.g.
`path: "/v2/petroleum/pri/gnd"`) returns its child routes and available
facets/frequencies — start at `/v2` and navigate rather than guessing deep
paths.

## Routes you should know

- Retail gasoline prices: `path: "/v2/petroleum/pri/gnd/data/"`
- Crude spot (WTI/Brent): `path: "/v2/petroleum/pri/spt/data/"`
- Electricity retail price by state: `path: "/v2/electricity/retail-sales/data/"`
- Generation by fuel: `path: "/v2/electricity/electric-power-operational-data/data/"`
- Natural gas prices: `path: "/v2/natural-gas/pri/sum/data/"`
- CO2 emissions: `path: "/v2/co2-emissions/co2-emissions-aggregates/data/"`

## Method

1. Walk the route tree to confirm facets (state, sector, product codes)
   before requesting data.
2. Always pass `data[0]=value` — without it you get metadata only, a common
   confusion.
3. Responses page at 5000 rows (`offset` to continue); check
   `response.total`.

## Failure modes

- 403 = missing/invalid key. 200 with empty `data` = over-constrained facets;
  loosen and re-check via the route's facet listing.
