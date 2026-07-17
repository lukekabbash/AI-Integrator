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

Base: `https://api.eia.gov/v2/`

Data requests take the form:

```
https://api.eia.gov/v2/{route}/data/?frequency=monthly&data[0]=value&facets[...]=...&start=2020-01&sort[0][column]=period&sort[0][direction]=desc
```

Discover routes by walking the tree: a GET on any non-`/data` route returns
its child routes and available facets/frequencies — start at the base URL and
navigate rather than guessing deep paths.

## Routes you should know

- Retail gasoline prices: `petroleum/pri/gnd`
- Crude spot (WTI/Brent): `petroleum/pri/spt`
- Electricity retail price by state: `electricity/retail-sales`
- Generation by fuel: `electricity/electric-power-operational-data`
- Natural gas prices: `natural-gas/pri/sum`
- CO2 emissions: `co2-emissions/co2-emissions-aggregates`

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
