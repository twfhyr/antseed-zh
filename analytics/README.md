# AntSeed Dune Analytics SQL Scripts

SQL queries for the [AntSeed Dune Dashboard](https://dune.com/antseed_com/antseed).

All queries target **Base mainnet**. Contract addresses:

| Contract | Address |
|---|---|
| Emissions V2 | `0xF13bE52c4A3afC6AE29536f073588d01A0564088` |
| ANTS Token | See registry |
| Deposits | See registry |
| Channels | See registry |

## Reference SQL Snippets

Below are canonical Dune SQL snippets that power the main AntSeed dashboard. They can be copy-pasted directly into Dune.

### Total Token & Request Counters
```sql
-- Totals across all time
SELECT
  SUM(inputTokens)  AS total_input_tokens,
  SUM(outputTokens) AS total_output_tokens,
  SUM(inputTokens + outputTokens) AS total_tokens,
  SUM(requestCount) AS total_requests
FROM antseed_base.AntseedStats_evt_MetadataRecorded;
```

This query hits the on-chain `AntseedStats` event log (`MetadataRecorded`) instead of the `settlements` helper table so it is chain-agnostic and does **not** double-count tokens.

---

## Queries

| File | Dashboard Widget | Description |
|---|---|---|
| `01_total_tokens_consumed.sql` | Counter | Total tokens consumed across all requests |
| `02_daily_tokens.sql` | Area chart | Daily token consumption over time |
| `03_dau_new_users.sql` | Bar + line chart | Daily active paying users + new users |
| `04_mau.sql` | Bar chart | Monthly active paying users |
| `05_daily_volume.sql` | Area chart | Daily and cumulative volume in USDC |
| `06_daily_requests.sql` | Area chart | Daily and cumulative inference requests |
| `07_total_users.sql` | Counter | Total unique paying users |
| `08_ants_released_claimed.sql` | Bar chart | ANTS released vs claimed |
| `09_avg_ltv.sql` | Counter | Average buyer LTV in USDC |
| `10_median_ltv.sql` | Counter | Median buyer LTV in USDC |
| `11_leaderboard.sql` | Table | Per-epoch buyer leaderboard ranked by spend |
