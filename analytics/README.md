# AntSeed Dune Analytics SQL Scripts

SQL queries for the [AntSeed Dune Dashboard](https://dune.com/antseed_com/antseed).

All queries target **Base mainnet**. Contract addresses:

| Contract | Address |
|---|---|
 | Emissions V2 | `0x36877fBa8Fa333aa46a1c57b66D132E4995C86b5` |
| Emissions V1 (active, receiving points) | `0xF13bE52c4A3afC6AE29536f073588d01A0564088` |
| ANTS Token | `0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263` |
| Deposits | `0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2` |
| Channels | `0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d` |
| Staking | `0x3652E6B22919bd322A25723B94BB207602E5c8e6` |
| Stats | `0x15649ff076bfa5e37e24ee3154a00503149954fd` |
| Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

## Emissions V2 Event Signatures (verified on-chain)

| Event | Signature | topic0 |
|---|---|---|
| Buyer points accrued | `BuyerPointsAccrued(address,uint256,uint256)` | `0xb6f182096ccbcdb01f88678850709e152446912df451858d3bdda2a5a02b46db` |
| Seller points accrued | `SellerPointsAccrued(address,uint256,uint256)` | `0xb463b4f6c3f2713f04717117455c27f0869dff33eec4100dc16519cd18e1be54` |
| Buyer emissions claimed | `BuyerEmissionsClaimed(address,address,uint256,uint256,uint256[])` | `0x55dbb74b8ed455500bea764ff26f8559862d6dd3e6632f82fdbb88091f68a0e8` |
| Seller emissions claimed | `SellerEmissionsClaimed(address,address,uint256,uint256,uint256[])` | `0xcf2009d50759437c9362a19e2512aa0160296153d63c36dfb6dacd1f83857baf` |

> Points events: topic1 = user (indexed), topic2 = epoch (indexed), data = pointsDelta (non-indexed).
> Claim events: topic1 = caller (indexed), topic2 = recipient (indexed), data = (amount, reserveDeduct, offset, count, epoch1, epoch2, ...).

## Deposits Event Signatures (verified on-chain)

| Event | Signature | topic0 |
|---|---|---|
| Deposited | `Deposited(address,uint256)` | `0x2da466a7b24304f47e87fa2e1e5a81b9831ce54fec19055ce277ca2f39ba42c4` |
| Operator set | `OperatorSet(address,address)` | `0xfd489696792cc4c5d5b226c46f008e459c8ec9b746c49191d74bb92c19fd1867` |

## Emissions V2 Contract Constants

| Constant | Value |
|---|---|
 | Seller share | 50% |
| Buyer share | 20% |
| Reserve share | 15% |
| Team share | 15% |
| Max seller share (per epoch) | 50% |
| Max buyer share (per epoch) | 5% |
| Platform fee (Channels) | 4% (BPS=400) |

## Important Notes

 - **BuyerPointsAccrued already contains the final credited buyer points.** Do NOT combine with a separate `PairPointsAccrued` event — combining would double-count points.
- **Points are based on the full settlement delta (pre-fee).** When a channel is settled, `delta = cumulativeAmount - channel.settled` is passed to both `accrueSellerPoints(seller, delta)` and `accrueBuyerPoints(buyer, delta)`. The 4% platform fee is only deducted from the USDC transfer, not from points.
- Points are raw integers (USDC 6-decimal units). To calculate ANTS allocation: `user_points / epoch_total_points × epoch_emission × share_pct / 100`
- Excess above per-user caps (maxBuyerSharePct=5%, maxSellerSharePct=50%) is redirected to the protocol reserve.

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
| `08_ants_released_claimed.sql` | Bar chart | ANTS released vs claimed per epoch |
| `09_avg_ltv.sql` | Counter | Average buyer LTV in USDC |
| `10_median_ltv.sql` | Counter | Median buyer LTV in USDC |
| `11_leaderboard.sql` | Table | Per-epoch buyer leaderboard ranked by spend |
| `12_buyer_points.sql` | Table | Buyer points per epoch per user |
| `13_seller_points.sql` | Table | Seller points per epoch per user |
| `14_operator_buyer_mapping.sql` | Table | Deposits operator-to-buyer address mapping |
