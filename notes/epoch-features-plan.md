# Plan: Current-Epoch Data Throughout the Dashboard

Status: **Implemented** (2026-09-15). Kept as the design record — see §5 for
the decisions that shaped the final implementation and §7 for what actually
shipped vs. what was deliberately left out.
Requested by: twfhyr, 2026-09-15.

## 1. Goal

Buyers and sellers care most about *this epoch* — what they've earned so
far and what they stand to earn once it settles. Right now the dashboard
only shows all-time totals and a historical daily chart; there's no single
place that says "here's epoch #22, here's what's happened in it so far."//
This plan adds a current-epoch view across Overview, the daily/epoch chart,
Buyers, Sellers, Services, and Tokenomics — all following the "never
fabricate a number" rule the rest of the app already follows (see
`AGENTS.md`). Every new column below is real data traced to a source
before being added to this plan; where I couldn't find a clean real source,
I've flagged it instead of inventing one.

## 2. Terminology, upfront (to avoid building the wrong thing)

- **"Epoch #N"** — always the live current epoch number, read the same way
  the app already reads it (`emissionsGateClient.currentEpoch()`, cached in
  `chain_metrics` via `chain-poller.js`, exposed as `/api/chain-stats`
  `emissions.currentEpoch`). Every "current epoch" sub-tab/section label
  uses this exact number, so it's always correct without hardcoding 22
  anywhere — epoch 23 starts automatically next week.
- **"Potential rewards (not finalized)"** — for both buyers and sellers,
  this is **usage reward + pool/staker reward** (if the address holds any
  lANTS stake position), combined into one figure. Decided in §5 point 1:
  same treatment for both, even though (per `[[antseed-ants-staking]]`)
  *anyone* can stake ANTS into a seller's pool, not only the seller
  themselves — the pool-reward component just reflects whatever that
  specific address actually has staked, wherever they staked it.
- These are genuinely **live, moving numbers** while the epoch is open —
  they'll go up as more settlements land and can shift if participation
  changes (the reward math is share-based, not fixed-per-point). Per §5
  point 7, this is explained in a new About page section rather than a
  banner on every sub-tab, plus per-column tooltips.

## 3. What I confirmed is actually available (verified live, not assumed)

I introspected Antscan's live GraphQL schema (`antscan.co/graphql`) and the
`@antseed/node` SDK source rather than guessing. Two new, currently-unused
data sources make this whole feature possible:

**A. Antscan per-epoch entities** (`backend/antscan.js` only queries
`sellerEpochs`/`buyerEpochs` for `totalCount` today, throwing away the rows
— this plan uses the actual row data instead):

| Entity | Key fields | Use |
|---|---|---|
| `buyerEpoch(buyer, epoch)` | `points`, `weightedPoints`, `volumeUsdc`, `requests` | Buyers current-epoch "earned points" column |
| `sellerEpoch(seller, epoch)` | same + `agentId` | Sellers current-epoch "earned points" column |
| `poolEpoch(agentId, epoch)` | `activeStake`, `weight`, `usagePoints`, `settledEmission`, `settled` | Sellers current-epoch "staked ANTS" column (`activeStake`) |
| `stakingEpoch(epoch)` | `totalBuyerPoints`, `totalSellerPoints`, `totalActiveStake`, `totalPowerWeight`, `volumeUsdc`, `requests` | Network-wide epoch totals (Overview current-epoch cards, and the denominator if we ever need our own share math) |

**B. On-chain view functions, already wrapped by the SDK but unused in this
repo** (`UsageRewardsClient`, `node_modules/@antseed/node/dist/payments/evm/usage-rewards-client.js`):

```
pendingBuyerReward(buyer, epoch)      → uint256   // exact, authoritative, live
pendingAgentReward(agentId, epoch)    → uint256   // same, for sellers
buyerEpochBudget(epoch) / sellerEpochBudget(epoch) → uint256  // the real bucket size, no reimplemented formula needed
```

These are the **actual contract math**, not a reimplementation — calling
them is strictly more trustworthy than computing my own share formula from
points, and the app already has a batched multicall helper
(`multicallView` in `backend/server.js`, used for the tokenomics
minter-budget reads) that can call these for a whole page of buyers/sellers
in one or two RPC round-trips instead of one-per-row.

**What's genuinely not available:** a clean epoch-scoped number for
*services*. Services are a live catalog snapshot (`network.antseed.com
/stats`), not an event ledger — there's no `serviceEpoch` entity. The
closest real signal is `settlementService.timestamp`, but counting
distinct `serviceId`s active in an epoch's time window means fetching and
de-duplicating potentially tens of thousands of settlement rows per
request — too expensive to do live, and no separate service catalog entity
being able to indicate which epoch a service "belongs to" the way an
account does. **Open question 3 below.**

## 4. Per-surface plan

### 4.1 Overview

Add a fourth stat-card row (or a toggle above the existing one) labeled
"Epoch #N": buyers, sellers, volume. Backend: `epoch_metrics` (SQLite,
already synced from Antscan's `epochMetrics`/count queries) already has
`active_buyers`/`active_sellers`/`volume_usdc` per epoch — the *open*
epoch's row is kept live-updated (not frozen like closed rows, see
`sync-history.js`'s `is_closed` logic). No new sync needed; just expose the
current (highest, unclosed) row via `/api/stats` or a new
`/api/stats/epoch` field. **Services**: no clean source (see §3) —
proposing to either drop it from this specific row (3 cards, not 4) or
reuse the all-time service count with a "not epoch-scoped" note. **Open
question 3.**

### 4.2 Daily/Epoch chart (`HistoryCharts.jsx`)

Add an "Epoch #N" tab alongside the existing daily view, same chart
shape, backed by the `epoch_metrics` table (`/api/history/epochs`, already
built and already fetched by `Overview.jsx` — currently unused in
`HistoryCharts.jsx`, needs to actually render it). No backend work.

### 4.3 Buyers tab

Two sub-tabs: **Total** (current table, unchanged) and **Epoch #N**.

Epoch #N sub-tab, per row:
- Remove: "First seen" column (per your request).
- Add: **Earned points** — `buyerEpoch.weightedPoints` for that buyer +
  current epoch (weighted, not raw `points`, since weighted is what
  wash-trading-filtered rewards are actually based on — see
  `ANTSInfo.jsx`'s existing explainer text). Formatted as a plain number
  with a tooltip explaining it's recognized-volume-derived points, not a
  dollar amount.
- Add: **Potential reward (not finalized)** — `pendingBuyerReward(buyer,
  currentEpoch)`, batched via multicall for the current page of rows
  (buyers list is already paginated at `limit=100` by default — this
  keeps the batch small regardless of total buyer count).

Implemented as `GET /api/epoch/buyers`, reading from `buyer_epoch_rewards`
(populated hourly for the *whole* epoch's participant list, not per-page —
see §5 point 5 and §6).

### 4.4 Sellers tab

Two sub-tabs: **Total** / **Epoch #N**, mirroring Buyers.

Epoch #N sub-tab, per row:
- Remove: "Joined" column.
- Add: **Staked ANTS** — `poolEpoch(agentId, currentEpoch).activeStake`
  (Antscan, no RPC needed).
- Add: **Potential earned ANTS** — usage reward (`pendingAgentReward`) +
  pool reward if the seller's own wallet holds any stake position (§5
  point 1).

Implemented as `GET /api/epoch/sellers`, reading from
`seller_epoch_rewards`, joined with the live `sellers` table (by
`agent_id`) for display name.

### 4.5 Services tab

Dropped — no epoch sub-tab for Services (§5 point 2).

### 4.6 Tokenomics

This one's a smaller, more surgical change: `TokenomicsTab.jsx` already
shows the *range* (`usage.sellerMinSharePct`–`usage.sellerMaxSharePct`)
but never the actual live effective share for the open epoch — unlike the
staker share, which already computes `effectiveSharePct` (see
`computeTokenomics()` in `backend/server.js`). Adding the equivalent for
usage is now possible with the same Antscan data: `stakingEpoch(currentEpoch
).totalBuyerPoints` / `.totalSellerPoints` as the formula's "input"
(mirroring the staker share's `min + (max-min) × input/(input+target)`
already implemented). Also surfacing `buyerEpochBudget(currentEpoch)` /
`sellerEpochBudget(currentEpoch)` / `allocatedEpochBudget(currentEpoch)`
directly from the contract (exact ANTS-denominated bucket sizes for this
epoch, no formula reimplementation needed) as a concrete "here's the total
pool being split this epoch" number above the per-user estimates on the
Buyers/Sellers tabs.

## 5. Decisions (answered 2026-09-15, before implementation)

1. **Seller "potential earned ANTS" includes both usage reward and pool
   reward** (if the address holds any stake position, in any pool) — same
   treatment as buyers. Implemented as: usage reward
   (`pendingBuyerReward`/`pendingAgentReward`, exact on-chain) + pool
   reward (`previewStakerRewards` summed over that address's currently-open
   lANTS positions, exact on-chain preview, no reimplemented formula) —
   shown as one combined "Potential ANTS" figure.
2. **No epoch sub-tab for Services** — dropped entirely, per §3/§4.5's
   analysis (no clean per-epoch service entity to build it on).
3. **Overview's current-epoch row is 3 cards** — buyers/sellers/volume,
   no services number.
4. **No specific address needed to sanity-check against** — verified
   instead against real, already-public epoch-22 participant data pulled
   live from Antscan during implementation (not tied to any one person's
   wallet). Confirmed both `pendingBuyerReward`/`pendingAgentReward` and
   `previewStakerRewards` return real, live, non-zero numbers for the
   still-open current epoch, as designed.
5. **Refresh cadence: hourly**, not the 60s originally proposed in §4.3 —
   these are "how's my week going" numbers, not numbers that need to feel
   live-live. Implemented as a background poller
   (`startEpochRewardsPoller`, `backend/server.js`), not a per-request
   computation — keeps page loads fast and RPC usage low regardless of
   traffic.
6. **Sub-tab order: Epoch #N first (default), Total second** — on both
   Buyers and Sellers, reflecting that this is what most visitors care
   about first.
7. **No per-tab "estimates, not final" banner** — the explanation lives in
   a new About page section instead (see §7), plus per-column info-icon
   tooltips (existing pattern, e.g. `StatsCards.jsx`'s `.stat-info-icon`)
   on Points/Potential ANTS/Staked ANTS specifically.

## 6. Implementation order (as executed)

1. `backend/antscan.js`: added `fetchBuyerEpochs(epoch)` /
   `fetchSellerEpochs(epoch)` / `fetchPoolEpochs(epoch)` /
   `fetchOpenStakePositions()` / `fetchStakingEpoch(epoch)`, and extended
   `fetchAllPaged` to accept an optional `where` clause.
2. `backend/database.js`: added `buyer_epoch_rewards` / `seller_epoch_rewards` tables.
3. `backend/server.js`: `syncCurrentEpochRewards()` (batches usage reward via
   the existing `multicallView` + `usageRewardsViewIface`, and pool reward
   via `sellerPoolsRewardsClient.previewStakerRewards`), `GET
   /api/epoch/buyers` / `GET /api/epoch/sellers` (paginated, searchable,
   matching the existing `/api/history/buyers` shape), `POST
   /api/admin/force-epoch-rewards-sync`; extended `/api/stats` with a
   `currentEpoch` block; extended `computeTokenomics()`'s `usage` section
   with live effective-share + on-chain epoch budgets.
4. Frontend: `HistoryCharts.jsx` now labels its existing epoch tab
   dynamically ("Epoch #N"); `EpochStatsCards.jsx` (new) for the Overview
   epoch row; `BuyersList.jsx`/`SellersList.jsx` rewritten with an
   Epoch/Total sub-tab toggle (`SellersList.jsx` also gained its own
   paginated fetch for epoch mode, since the Total tab's `sellers` prop
   from `App.jsx` has no epoch dimension); `TokenomicsTab.jsx` usage-share
   cards now show a live effective % (was range-only) plus the epoch's
   ANTS budget; `About.jsx` gained an "Epoch Data" section explaining the
   hourly refresh and what "not finalized" means. All new copy has
   `en.js`/`zh.js` entries.
5. Verified end-to-end against the live production process (restarted
   locally, both `dist`/`dist-root` builds, before pushing) — real
   non-zero points/rewards/stake confirmed via `/api/epoch/buyers`,
   `/api/epoch/sellers`, `/api/stats`, `/api/tokenomics`.

## 7. Notable implementation finding (not a bug)

`pendingBuyerReward`/`pendingAgentReward` are subject to a real, on-chain
per-participant cap: `UsageRewardsClient.maxRewardShareBps()` = 500 (5% of
that side's epoch budget). With only 69 buyers / 16 sellers recognized in
epoch 22 so far, several participants' raw point-proportional share already
exceeds 5%, so they clamp to the *same* capped value — which is why several
rows can show an identical "Potential ANTS" figure right now. This is
correct, verified on-chain behavior, not a display bug; it'll naturally
show more variation as epoch participation grows.
