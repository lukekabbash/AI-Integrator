---
name: census
description: Query US Census Bureau APIs — ACS demographics (population, income, housing, education by state/county/tract), decennial census, and business patterns. Use for questions about population, demographics, or local-area statistics.
---

# US Census Bureau

## Requirements

A free key from https://api.census.gov/data/key_signup.html set as
`CENSUS_API_KEY`. Small volumes work keyless, but the key avoids IP blocks.

## Core pattern

Base: `https://api.census.gov/data/{year}/{dataset}`

Most useful dataset: ACS 5-year (`acs/acs5`) — reliable down to tract level.

```
https://api.census.gov/data/2023/acs/acs5?get=NAME,B01003_001E,B19013_001E&for=county:*&in=state:06&key=$CENSUS_API_KEY
```

Response is a JSON array-of-arrays; first row is headers.

## Variables you should know (ACS)

Total population `B01003_001E` · Median household income `B19013_001E` ·
Median home value `B25077_001E` · Median gross rent `B25064_001E` ·
Bachelor's+ `B15003_022E` (of `B15003_001E` total) · Poverty `B17001_002E` ·
Median age `B01002_001E`. `E` suffix = estimate, `M` = margin of error —
report MOE for small geographies.

Discover variables: `https://api.census.gov/data/2023/acs/acs5/variables.json`
(large; grep it rather than loading whole).

## Geography

`for=state:*` · `for=county:*&in=state:06` · `for=tract:*&in=state:06+county:075`
· `for=place:*&in=state:48`. State/county codes are FIPS; look them up rather
than guessing (California=06, Texas=48, New York=36).

## Failure modes

- A bare `204`/empty response means the variable doesn't exist in that
  year/dataset — variable ids change between ACS years; verify in
  variables.json for the exact year.
- The Census Bureau can block abusive IPs; batch variables (up to 50 per
  `get=`) instead of looping.
