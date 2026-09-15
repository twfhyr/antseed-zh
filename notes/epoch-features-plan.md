# Plan: Current-Epoch Data Throughout the Dashboard

Status: **DRAFT — awaiting review, no implementation yet.**
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
- **"Potential rewards (not finalized)"** — for a **buyer**, this means
  their usage-reward bucket only (`AntseedUsageRewards.pendingBuyerReward`).
  For a **seller**, I'm proposing it means their own **usage** reward
  (`pendingAgentReward`, i.e. what they earn for serving requests) — **not**
  the seller-pool/staker reward, because per existing memory (see
  `[[antseed-ants-staking]]`) *anyone* can stake ANTS into a seller's pool,
  so "staker rewards for this pool" isn't really "the seller's" number —
  it belongs to whoever staked. **Open question 1 below** — confirm this
  reading before I build it.
- These are genuinely **live, moving numbers** while the epoch is open —
  they'll go up as more settlements land and can shift if participation
  changes (the reward math is share-based, not fixed-per-point). The UI
  needs to say this out loud, not just in a column label nobody reads —
  proposing a persistent "epoch in progress — estimates only, not final
  until the epoch closes" banner on every current-epoch sub-tab.

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

Backend: new `GET /api/history/buyers?epoch=current&...` (or a parallel
endpoint) that, for the requested page's addresses, queries Antscan
`buyerEpochs(where: {buyer_in: [...], epoch: "N"})` for points and
multicalls `pendingBuyerReward` for the reward estimate. Cache per-page
with a short TTL (proposing 60s — long enough to avoid hammering the RPC
on every scroll, short enough that "live" still means something).

### 4.4 Sellers tab

Two sub-tabs: **Total** / **Epoch #N**, mirroring Buyers.

Epoch #N sub-tab, per row:
- Remove: "Joined" column.
- Add: **Staked ANTS** — `poolEpoch(agentId, currentEpoch).activeStake`
  (Antscan, no RPC needed).
- Add: **Potential earned ANTS** — `pendingAgentReward(agentId,
  currentEpoch)` (seller's own usage reward; see §2 on why this excludes
  pool/staker rewards — **open question 1**).

Backend: same pattern as Buyers — batched by `agentId` for the current
page (`sellers` table already carries `agent_id` from the DHT sync).

### 4.5 Services tab

Blocked on **open question 2** — I don't have a concrete, cheap, accurate
plan for this one the way I do for Buyers/Sellers/Overview. Once you
confirm what "current epoch" should mean for a live catalog (see the
question), I'll fill this section in properly rather than guess.

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

## 5. Open questions (need your answer before I implement)

1. **Seller "potential earned ANTS" — usage reward only, or usage + pool
   reward if the seller also happens to stake in their own pool?** I'm
   proposing usage-only (see §2) since pool rewards aren't really "the
   seller's" in general. If you want pool rewards included when the seller
   IS also a staker in their own pool, that's a bit more work (checking
   whether the seller's own address holds any stake positions in that
   pool) — let me know.
2. **Services — what should "current epoch" mean here?** Given there's no
   clean per-epoch service entity (§3), pick one: (a) drop the epoch
   sub-tab for Services entirely and only do it for Overview/Buyers/
   Sellers/Tokenomics; (b) show per-service volume/requests for the
   current epoch anyway, accepting it'll be a heavier, more cached, maybe
   periodic-batch-computed number rather than live-on-every-request; (c)
   something else you have in mind that I'm missing.
3. **Overview's current-epoch row — 3 cards (buyers/sellers/volume) or 4
   with a caveated services number?** See §4.1 — leaning toward 3 unless
   you'd rather see a non-epoch-scoped services count sitting next to
   epoch-scoped numbers with a clear label.
4. **Any wallet address whose current-epoch numbers I should sanity-check
   `pendingBuyerReward`/`pendingAgentReward` against before wiring this up
   for real?** (e.g. one of your two seller agent IDs — 51642 or 47218 —
   or a buyer address you know has settled volume this epoch.) I'd rather
   verify against a known real case than assume the contract behaves
   exactly as documented for a still-open epoch.

## 6. Implementation order (once approved)

1. `backend/antscan.js`: add `fetchBuyerEpoch(buyer, epoch)` /
   `fetchSellerEpoch(seller, epoch)` / `fetchStakingEpoch(epoch)` /
   `fetchPoolEpoch(agentId, epoch)` — batched/plural variants where Antscan
   supports an `_in` filter, to avoid one GraphQL round-trip per row.
2. `backend/server.js`: current-epoch reward endpoints for Buyers/Sellers
   (multicall-batched `pendingBuyerReward`/`pendingAgentReward`), short-TTL
   cached; extend `computeTokenomics()` with the usage effective-share
   calc; extend `/api/stats` (or add a sibling) with the current-epoch
   Overview numbers from `epoch_metrics`.
3. Frontend: `HistoryCharts.jsx` epoch tab (data already fetched, just not
   rendered); `BuyersList.jsx`/`SellersList.jsx` sub-tab toggle + new/
   removed columns; `Overview.jsx` epoch card row; `TokenomicsTab.jsx`
   usage effective-share display. All new copy needs `en.js`/`zh.js`
   entries per `AGENTS.md`.
4. Services, once open question 2 is answered.

I have **not** started implementation — this is the plan for your review.
