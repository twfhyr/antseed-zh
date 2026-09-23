# Architecture

## System Design

The AntSeed Dashboard is a **single-page application (SPA)** backed by a lightweight REST API and an embedded SQLite database. It is designed to run anywhere Node.js is available with no external database dependency.

### Key Design Decisions

1. **Single-port serving** — Express handles both `/api/*` routes and static file serving for the built React app. This removes CORS complexity in production.
2. **SQLite with WAL mode** — better-sqlite3 runs synchronously, requires no separate service, and WAL mode improves concurrent read/write performance.
3. **Startup sync** — On boot, the server hits the official AntSeed network stats endpoint, wipes stale service/seller data, and repopulates the DB with live peers.
4. **No auth layer yet** — The `/api/admin/sync` endpoint is open (add middleware if exposing publicly long-term).

---

## Data Sources

### Mock → Local Proxy → Official API

| Phase | Source | Models | Pricing |
|---|---|---|---|
| Mock | `src/data/mockData.js` | 14 fake services | Hardcoded |
| Local proxy | `http://localhost:8377/v1/models` | 13 models (local node only) | Estimated from tiny completion |
| Official API | `https://network.antseed.com/stats` | 349 real services across 21 peers | Live per-service pricing from providers |

The official endpoint is a JSON blob containing every active peer, their providers, service lists, per-service pricing (input/output/cached), categories, and protocols. It also includes on-chain stats (requests, tokens, settlements).

---

## Sync Lifecycle

```
Server starts
  |
  v
DELETE FROM services
DELETE FROM sellers
  |
  v
fetch(network.antseed.com/stats)
  |
  v
for each peer:
    create seller (displayName + peerId)
    for each provider on that peer:
        for each service offered:
            dedupe by (serviceName + provider + sellerId)
            insert service with real pricing, categories, protocols
  |
  v
UPDATE stats
  |
  v
Ready to serve
```

Deduplication is global across the whole sync: the same provider on a single peer may list services multiple times (this happens in real peer metadata), so we skip duplicates by service ID.

---

## Frontend Architecture

- `App.jsx` fetches stats + buyers + sellers + services on mount via `useEffect`
- Loading and error states are handled in `App.jsx`
- Tab state is URL-driven (`src/hooks/useTabRouter.js`), not plain `useState`,
  so every section is a shareable/bookmarkable/reload-safe link
  (`antseed-zh.com/buyers`, `.../zh/tokenomics`, etc.) — the server's SPA
  catch-all serves `index.html` for any of these on a fresh load
- No state management library; plain React `useState` is sufficient for this scope
- `Header.jsx` renders a RainbowKit `<ConnectButton>` globally (compact —
  no balance shown) because the Claim ANTS and Payment Channels tabs are
  wallet-gated; the rest of the dashboard works fully read-only without
  connecting

### Data Binding

```
App.jsx (useTabRouter → one tab active at a time)
  ├─ Overview     ← StatsCards (/api/stats) + HistoryCharts (/api/history/daily, /epochs)
  ├─ BuyersList   ← /api/history/buyers (paginated, on-chain)
  ├─ SellersList  ← sellers array (live DHT + on-chain earned)
  ├─ ServicesList ← services array + search + category filter
  ├─ TokenomicsTab ← /api/tokenomics (supply, allocation pies, dynamic shares)
  ├─ ANTSInfo     ← /api/chain-stats (supply, epoch clock, allocation, contract map, reward-mechanics explainer)
  ├─ ClaimANTS    ← /api/rewards (five buckets) + wagmi wallet claims
  ├─ ChannelsView ← /api/channels (buyer proxy) + live channels() reads via
  │                 the address from /api/deposits/config (never hardcoded —
  │                 AntseedChannels is swappable and does get redeployed)
  ├─ StakeANTS    ← /api/lants-market (paginated) + on-chain lANTS positions
  │                 for the connected/searched address + direct Seaport
  │                 calls (list/buy/cancel/offer/accept) via src/lib/listLants.js
  └─ About        ← this node's own peer info + connection guide
```

`TokenomicsTab` and `ANTSInfo` both read chain-level ANTS data and overlap
somewhat (supply/allocation appear in both, styled differently — pie charts
vs. a flat list); `ANTSInfo` additionally has the full contract-address list
and the "how rewards are earned" / "how to earn" explainers that
`TokenomicsTab` doesn't. Left as two tabs for now — see `notes/dev-plan.md`
for the consolidation question.

---

## ANTS Claim System

### Overview

The Claim tab lets users connect their EVM wallet (MetaMask, Coinbase Wallet, etc.) on Base mainnet and claim ANTS rewards. Since the recognized-usage era (epoch 22, September 10, 2026) rewards come in **five buckets**: staker (seller-pool positions), seller usage, buyer usage, legacy emissions, and the locked M002 pool. A "Claim All" button runs every bucket in sequence, mirroring the official ANTS dashboard flow.

### Reward Buckets & Contracts

| Bucket | Contract(s) | Claim function |
|---|---|---|
| Staker | `AntseedSellerPools` `0x8bf4d39aa13f3cb03f87d9500767fbc4d0940652`, `AntseedSellerPoolsRewards` `0x83cc5b9aa0c8cb8683f35462c385a5baaa755ee5` | `indexPoolRewards(agentId, maxEpochs)` loop (brings each pool's reward index up to date), then `claimStakerRewardsBatch(positionIds, recipient)` in batches of 32 |
| Seller usage | `AntseedUsageAccounting` `0xadd2d85316153d7bfaf7921ee9bf1bb6c7a1cbc9`, `AntseedUsageRewards` `0x78330bf154172f1137219bb559d4f3a270b3201f` | `claimSellerEmissions(epochs)` |
| Buyer usage | `AntseedUsageRewards` | `claimBuyerReward(buyer, epoch)` — per epoch; paid to the deposits operator |
| Legacy (epochs 0–21) | Emissions V2 `0xF13bE52c4A3afC6AE29536f073588d01A0564088`, V1 `0x36877fBa8Fa333aa46a1c57b66D132E4995C86b5` (epochs < 4) | `claimSellerEmissions(epochs)` / `claimBuyerEmissions(buyer, epochs)` |
| Locked (M002) | `SellerRewardsPool` (resolved from legacy Emissions `sellerRewardsPool()`) | `claim(recipient)` |

Backend reads come from `@antseed/node` clients; `resolveLegacyContractAddresses(cfg)` is used for the legacy trio so the code works regardless of whether the published SDK points `emissionsContractAddress` at the legacy V2 or the new UsageAccounting.

### Emission Schedule (recognized-usage era)

| Parameter | Value |
|---|---|
| Max supply | 1,040,000,000 ANTS (read live from `ANTSToken.maxSupply()`) |
| Epoch duration | 1 week (604,800 seconds) |
| Halving interval | 104 epochs (~2 years), gate genesis April 9, 2026 |
| Recognized-usage start | Epoch 22 (September 10, 2026) |
| Allocation ceilings | 40% seller-pools / 20% usage / 15% team / 15% reserve / 10% verification (read live from the gate minters) |

The seller-pool and usage shares are **dynamic**: the staker share scales from a 2% baseline toward its 40% ceiling with active stake (target 400M ANTS), and buyer/seller-operator usage shares each scale from 5% toward 10% with recognized USDC volume (target 1M USDC/epoch). Unallocated remainder is burned (up to 30% of epoch emissions) with the rest going to the reserve.

### Claim Flow (Frontend)

```
1. User connects wallet (wagmi) or searches any address (read-only view)

2. Load the five-bucket rewards view
   → GET /api/rewards?address=0x...
   → { staker, sellerUsage, buyerUsage, legacy, locked, total, contracts, phase }

3. Legacy epoch table (epochs 0–boundary-1)
   → GET /api/emissions/pending?address=...&epochs=0,...,boundary-1
   → per-epoch points/rewards/claimed (V1+V2 merged)

4. Claim a bucket (browser sends the tx directly via wagmi + wallet):
   - Staker: read currentEpoch + poolRewardIndexNextEpoch via publicClient,
     indexPoolRewards until the cursor reaches each position's target epoch,
     then claimStakerRewardsBatch
   - Seller usage: claimSellerEmissions(epochs)
   - Buyer usage: claimBuyerReward(buyer, epoch) per epoch (requires the wallet
     to be the deposits operator)
   - Legacy: epochs 0–3 claim from V1, epoch 5+ from V2; epoch 4 has partial
     points in BOTH contracts, so it claims from each contract that still has
     pending (per-contract breakdown from /api/emissions/pending)
   - Locked: claim(recipient)

5. Refresh rewards view with &bust=1 after claims
```

### Backend Endpoints (read-only, proxy to chain)

| Endpoint | Method | Description |
|---|---|---|
| `/api/rewards` | GET | `?address=0x...&bust=1` → all five buckets + contracts + epoch info (90s cache) |
| `/api/emissions/epoch-info` | GET | Current epoch, emission rate, effective epoch, phase, legacy shares + gate allocation |
| `/api/emissions/pending` | GET | `?address=...&epochs=` → legacy-era pending seller/buyer ANTS per epoch (V1+V2 merged; epoch rows ≤ 4 include a per-contract `sellerRewardV1/V2`, `buyerRewardV1/V2` breakdown) |
| `/api/emissions/claimed` | GET | `?address=...&epochs=` → which legacy epochs already claimed |
| `/api/chain-stats` | GET | Supply, max supply, epoch clock, allocation, USDC balances, contract map |

Claims are **not** proxied through the backend — the user's browser sends transactions directly to Base mainnet via their wallet provider. This keeps private keys in the wallet and avoids the server needing any signing capability.

### SDK Usage (@antseed/node)

```javascript
import {
  EmissionsClient, EmissionsGateClient, UsageAccountingClient, UsageRewardsClient,
  SellerPoolsClient, SellerPoolsRewardsClient, SellerRegistryClient, SellerRewardsPoolClient,
  RegistryClient, StakingClient, ANTSTokenClient, DepositsClient,
  resolveChainConfig, resolveLegacyContractAddresses,
  previewPoolRewards, pendingEpochRewards, GATE_MINTERS, gateMinterId,
} from '@antseed/node';

const cfg = resolveChainConfig('base-mainnet');
const legacy = resolveLegacyContractAddresses(cfg); // legacy V2/V1 + staking addresses

// Five-bucket view (read-only, no signer)
const pending = await new UsageAccountingClient({ ...opts(cfg), contractAddress: cfg.usageAccountingAddress })
  .pendingEmissions(address, epochs); // → { seller, buyer }
const positions = await previewPoolRewards(poolsClient, poolsRewardsClient, address); // staker bucket
const agentId = await new SellerRegistryClient({ ...opts(cfg), contractAddress: cfg.sellerRegistryAddress })
  .getAgentId(address); // falls back to legacy StakingClient.getAgentId

// Epoch clock + allocation from the gate
const gate = new EmissionsGateClient({ ...opts(cfg), contractAddress: cfg.emissionsGateAddress });
const [epoch, effectiveEpoch] = await Promise.all([gate.currentEpoch(), gate.effectiveEpoch()]);
```

### Contract Addresses (Base Mainnet, Chain ID 8453)

Full live map served by `/api/chain-stats` → `contracts`. Core entries:

| Contract | Address |
|---|---|
| ANTS Token | `0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263` |
| Emissions Gate | `0xe60a31e6cd2f8455503ca0b3f6545dd3ddf543bd` |
| Usage Accounting | `0xadd2d85316153d7bfaf7921ee9bf1bb6c7a1cbc9` |
| Usage Rewards | `0x78330bf154172f1137219bb559d4f3a270b3201f` |
| Seller Pools | `0x8bf4d39aa13f3cb03f87d9500767fbc4d0940652` |
| Seller Pools Rewards | `0x83cc5b9aa0c8cb8683f35462c385a5baaa755ee5` |
| Seller Registry | `0x99c533bcc6ca646e543dba835fdbb9c2ee02cb60` |
| Legacy Emissions (V2) | `0xF13bE52c4A3afC6AE29536f073588d01A0564088` |
| Legacy Emissions (V1) | `0x36877fBa8Fa333aa46a1c57b66D132E4995C86b5` |
| Legacy Staking | `0x3652E6B22919bd322A25723B94BB207602E5c8e6` |
| Deposits | `0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2` |
| Channels | `0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d` |
| Stats | `0x15649ff076BFa5e37e24EE3154a00503149954Fd` |
| Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

### Eligibility Notes

- **Seller usage rewards**: require a registered seller agent (`SellerRegistry.getAgentId`) with an eligible pool and sufficient epoch power. A missing or filtered pool still settles USDC but earns no new usage points.
- **Buyer usage rewards**: paid to the deposits operator wallet; if the operator differs from the buyer, claims must come from the operator wallet.
- **Staker rewards**: power activates the epoch after staking; rewards on positions closed by split/merge/move remain claimable under the old position ID.
- **Legacy emissions**: frozen at epochs 0–21; V1 for epochs < 4, V2 for later epochs. The locked M002 pool releases 10% of cumulative locked legacy seller ANTS per claim.
- **Anti-abuse**: the registered points policies (e.g. the historical wash-trading filter) can zero points for flagged volume; farming/fake volume may be capped or excluded.

---

## lANTS Marketplace (Self-Hosted Seaport)

### Overview

Locked ANTS positions (`AntseedSellerPools`) are ERC-721 NFTs — "lANTS". The
**lANTS tab** (`/lants`, `src/components/StakeANTS.jsx` — briefly labelled
"IANTS" for a few hours on 2026-09-21 after moving next to Stakers, reverted
to "lANTS" the same day on founder feedback: the name is locked ANTS,
lowercase L, not a capital I)
lets holders list, buy, cancel, make offers on, accept offers, split, merge,
and move these NFTs entirely on **antseed-zh's own order book** (for the
trading actions) or directly against `AntseedSellerPools` on-chain (for
split/merge/move, which have no marketplace component), using the
[Seaport](https://github.com/ProjectOpenSea/seaport) protocol directly
against the contract on Base. Nothing on this flow depends on OpenSea's API,
an API key, or OpenSea having indexed the NFT — a listing is usable the
instant it's created. OpenSea cross-posting still happens best-effort (wider
discovery, when a key is available) but the site never blocks on it or
requires it.

The **Stakers tab** (`/stakers`, next to Sellers) is a separate, public,
no-wallet-needed view of the *same underlying positions* — grouped by
staker address and lock length instead of listed NFT-by-NFT. See "Stakers
tab (public, read-only)" near the end of this section for how it relates to
the lANTS tab and why the two are kept as separate tabs rather than merged.

This replaced an earlier approach that called OpenSea's API directly for
listing, which failed in production with "no API key" — OpenSea's free
instant keys are rate-limited to 2/day per IP and were being burned by every
dev-server restart (see `backend/opensea-list.js` below for the fix). Rather
than depend on that quota at all, listings/buys/offers now go straight to
Seaport, with OpenSea reduced to an optional bonus channel.

### Why Seaport orders don't need gas to create

A Seaport order is an **off-chain signed message** (EIP-712), not a
transaction — creating or cancelling one (when it never touched the chain)
costs nothing. The chain is only touched once, when someone **fulfills**
the order by calling `fulfillOrder()`/`fulfillBasicOrder()` on the Seaport
contract. This is what makes a "free to list, only the buyer pays gas"
marketplace possible without any backend holding funds or keys.

- **Listing** = `offer: [ERC721 NFT]`, `consideration: [USDC payment →
  seller]`. The buyer's wallet calls `fulfillOrder()`; Seaport pulls the
  buyer's pre-approved USDC and moves it to the seller, and moves the NFT
  to the buyer, in one transaction.
- **Offer** = the mirror image — `offer: [USDC payment]`, `consideration:
  [ERC721 NFT → buyer]`. The **owner's** wallet calls `fulfillOrder()` to
  accept it, pulling the buyer's pre-approved USDC and sending the NFT.

### Priced in USDC, everywhere, since 2026-09-21 (no ETH shown at all)

Every listing and offer this site creates is denominated in **USDC**
(`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` on Base — the same constant
`DepositModal.jsx` already used for real deposits), not native ETH or
WETH. This replaced an earlier version where listings used a native-ETH
consideration item and offers used WETH — changed after live user
feedback: "lANTS feels more like BRC-20, so its trading should use
similar ways… denominate in USDC and allow users [to] buy or pay in USDC
while not show[ing] ETH any more" (referencing BRC-20 marketplace UIs
like unisat.io's).

**Why this was a smaller change than it sounds.** `fulfillOrder()` for an
offer is called by the **seller** (the position owner), not the buyer —
only the transaction's caller can attach `msg.value`, so the owner's
fulfillment tx could never pull raw ETH out of the buyer's wallet; it
could only pull a pre-approved ERC20. That's exactly why offers were
*already* ERC20-only (WETH) before this change — switching the token from
WETH to USDC didn't introduce a new mechanism, it just swapped which
ERC20. The one real behavior change is that offers no longer wrap
anything first: WETH needed an explicit `deposit()` step
(`ensureWeth()`, now deleted) to convert ETH into an ERC20 before it could
be offered; USDC is already an ERC20 the offerer holds directly, so
`makeOffer()` (`src/lib/listLants.js`) just builds the order.

Listings went from native ETH to ERC20 USDC the same way — this *does*
change the consideration item's `itemType` from native to ERC20, but
needed **zero new approval-handling code**: `createOrder()`'s and
`fulfillOrder()`'s own `executeAllActions()` already inspect whatever
token an order's offer/consideration items name and insert an `approve()`
action first if the relevant party (lister for the NFT, fulfiller for the
USDC) hasn't already approved it — confirmed by reading seaport-js's own
`getApprovalActions()`/`validateStandardFulfillBalancesAndApprovals()`
source, not assumed. `fulfillListing()`/`acceptOffer()` needed no code
changes at all.

**A real bug this caught before shipping:** the per-ANT-priced total
(below) is computed in plain JS floating point (`perAnt * amount`), which
routinely produces values like `0.30000000000000004`. `ethers`'
`parseUnits()` throws `NUMERIC_FAULT: too many decimals` on a string with
more fractional digits than USDC's 6 — reproduced with a throwaway
`node -e` before trusting the code, not just by reading it. Fixed with
`Number(priceUsdc).toFixed(6)` before `parseUnits()` in both
`createAndPostListing()` and `makeOffer()`.

**Backend validation** (`/api/lants/list`, `/api/lants/offer` in
`server.js`) rejects any order whose consideration/offer token isn't
`emissionsCfg.usdcContractAddress` (resolved live via `@antseed/node`, not
hardcoded) — the same shape the WETH check used before, just pointed at a
different address. `computeLantsMarket()`'s own USD figure for a local
listing no longer needs the Coinbase ETH-USD spot-price call it used to
(`ethUsdPrice()`, removed) — USDC's own peg *is* the USD figure, so
`usd = price_wei / 1e6` directly. The frontend's `formatListing()` was
simplified to always show that USD total and never a raw token unit,
which also covers an OpenSea-scraped listing that might still carry an
ETH `unit`/`symbol` from the scraper — this site shows every price as a
USD total, full stop.

**Pre-2026-09-21 rows are kept, not migrated or hidden.** A handful of
real WETH offers were already open in production at the moment of this
switch (found by querying the live database before writing the fix, not
guessed) — they're still perfectly fulfillable (`fulfillOrder()` doesn't
care what token an already-signed order names), so the frontend's offer
row and trade-history rendering read each row's own recorded currency/
decimals (`formatTradeAmount()`/`CURRENCY_DECIMALS` in `StakeANTS.jsx`)
rather than assuming everything is 6-decimal USDC. `offersForToken()`'s
price-descending sort (below) is a known approximation for a token that
mixes an 18-decimal WETH offer with 6-decimal USDC ones, since their raw
base-unit amounts aren't directly comparable — not worth solving given
every *new* offer is USDC-only going forward.

### Per-ANT pricing, like a BRC-20 marketplace

The List/Offer forms collect a price **per ANT**, not a flat total — the
same convention a BRC-20 marketplace uses (price per token, total shown
alongside). `doList`/`doMakeOffer` (`StakeANTS.jsx`) compute
`perAnt * position.amount` and show that computed total inline in the
modal (`stake.totalPrice`) before sending it as the one flat amount
Seaport's order actually needs — Seaport itself has no "per unit"
concept, an order is always for one total price. `formatListing()` and
the market card's per-ANT reference line (`listing.perAntUsd`, computed
server-side in `computeLantsMarket()`) show the same total/per-ANT pair
on the read side.

Listings and the market's default sort both rank by **per-ANT price**,
not the total: `paginateMarketItems`'s `'price'` sorter
(`backend/server.js`) already keyed off `listing.perAntUsd`, and
`marketSort`'s frontend default was changed from `'id'` to `'price'`
(ascending — cheapest per-ANT first) to actually surface that ranking by
default, matching a BRC-20 market's own default view.

### One open offer per address per token

`makeOffer()`'s entry point (`openOfferModal()` in `StakeANTS.jsx`) checks
whether the connected address already has an open offer on a token before
showing the form at all, and blocks with a clear message
(`stake.offerAlreadyExists`) if so, rather than letting a second offer go
through silently. `/api/lants/offer` enforces the same rule server-side
(409 on a duplicate `(offerer, tokenId)`) as a backstop against a stale
tab or race bypassing the client-side check. This exists because real
production data showed the actual failure mode: the same address had
three open (WETH) offers already sitting on one token from earlier
live-testing this session, found by querying the database directly.

### Conduit: Seaport's own, not OpenSea's

Every order sets `conduitKey` to the **zero conduit key**
(`0x` + 64 zeros) — Seaport's own default conduit — instead of the conduit
key OpenSea's own tooling normally defaults to. This means a seller's
`setApprovalForAll` grants transfer approval to the Seaport contract
itself, with no OpenSea-operated contract anywhere in the approval or
fulfillment path.

Seaport 1.6 on Base: `0x0000000000000068F116a894984e2DB1123eB395`
(`SEAPORT_V16` in both `backend/opensea-list.js` and `src/lib/listLants.js`).

### Data model (`backend/database.js`)

| Table | Purpose |
|---|---|
| `lants_listings` | One row per token (`token_id` PK) — the current active sell listing: offerer, `price_wei`, the full signed Seaport order (`order_parameters` JSON + `signature`), `cancelled_at`. Upserted on re-list, soft-deleted via `cancelled_at`. |
| `lants_offers` | One row per offer (autoincrement id, many per token) — offerer, `price_wei`, the offer's payment-token address (`weth` column name predates the 2026-09-21 USDC switch — still just "whichever ERC20 this offer names", USDC for anything current), the signed order, `cancelled_at`/`accepted_at`. |
| `lants_positions` | Cached position metadata (owner, `agent_id`, `amount`, `weight_amount`, stake start/end epoch, `withdrawn`) so the market page can page/filter/sort with plain SQL instead of an on-chain or Antscan read on every request. Refreshed each time `computeLantsMarket()` runs (~90s TTL). |

Storage/query layers: `backend/lants-listings.js`, `backend/lants-offers.js`,
`backend/lants-positions.js`.

### Backend endpoints (`backend/server.js`)

| Endpoint | Method | Description |
|---|---|---|
| `/api/lants-market` | GET | `?page&pageSize&sort&dir&owner&agentId&minAmount&maxAmount&minLockDays&maxLockDays&listed&wait` — paginated/filtered/sorted market view. Serves from a 90s in-memory + on-disk cache (stale-while-revalidate); `wait=1` forces a synchronous refresh. |
| `/api/lants/list` | POST | `{ tokenId, order, protocolAddress }` — verifies the position exists, isn't a 1-ANT activation stake, and the order's offerer owns it; saves the listing locally (always succeeds independent of OpenSea), then best-effort cross-posts to OpenSea. |
| `/api/lants/order/:tokenId` | GET | The stored signed order for a listed token, for a buyer's wallet to fulfill directly. |
| `/api/lants/cancel` | POST | `{ tokenId, message, signature }` — signature-authenticated (see below); invalidates the local listing. |
| `/api/lants/offer` | POST | `{ tokenId, order, protocolAddress }` — validates the offer's payment item is USDC and its consideration targets this token, and rejects a duplicate (409) if this offerer already has an open offer on it; saves it. |
| `/api/lants/offers/:tokenId` | GET | All active (not cancelled/accepted) offers on one token. |
| `/api/lants/offer/:offerId` | GET | One offer's stored order, for the owner to fulfill. |
| `/api/lants/offer/cancel` | POST | `{ offerId, message, signature }` — signature-authenticated against the offer's maker. |
| `/api/lants/offer/accept` | POST | `{ offerId }` — called after the owner's `fulfillOrder()` tx confirms on-chain; the tx itself is the real authorization, this just records the accepted offer, retires the token's other offers, and invalidates any stale listing. |

### Signature-based auth for actions with no Seaport signature of their own

Listing and making an offer are self-authenticating — a valid Seaport
signature already proves the offerer's intent. Cancelling a listing or an
offer isn't backed by any on-chain signature, so those two endpoints use a
lightweight scheme (`verifySignedAction()` in `backend/server.js`, mirrored
by `signTimestampedMessage()` in `src/lib/listLants.js`):

```
message   = "Antseed-zh lANTS: {action} #{id} @ {timestamp}"
signature = walletClient.signMessage({ account, message })
```

The server extracts the trailing `@ {timestamp}`, rejects anything outside
a 5-minute window (limits replay), recovers the signer via ethers'
`verifyMessage()`, and checks it against the resource's stored
owner/offerer.

### Market computation & caching (`computeLantsMarket()`)

Runs on a 90s TTL, gathering from three sources in parallel and merging by
token id:

1. **Antscan / on-chain fallback** — position metadata (owner, agent,
   amount, epochs). Any id seen elsewhere but missing here (e.g. a
   brand-new position Antscan hasn't indexed yet) is filled in with a
   direct `sellerPoolsClient.position(id)` call, up to 40 at a time.
2. **OpenSea scrape** (`backend/opensea-lants.js`) — best-effort, for
   listings created via the old direct-OpenSea path or the cross-post
   bonus. Never required.
3. **Local order book** (`lants_listings`) — takes priority over an OpenSea
   listing for the same token when the offerer still owns the position (a
   sold/transferred/withdrawn position's stale listing is dropped, not
   shown as live).

**Real bug fixed here (2026-09-20):** the id union used to be
`osItems.length ? osItems.map(...) : [...byAntscan.keys()]` — i.e. any
non-empty OpenSea scrape result *replaced* the fuller Antscan-derived id
list instead of merging with it, silently hiding real positions OpenSea
hadn't indexed yet. Fixed to always union both sources
(`new Set([...byAntscan.keys(), ...osItems.map(i => i.id)])`).

Every gathered position is upserted into `lants_positions`
(`upsertPositions()`), and `paginateMarketItems()` then applies
page/filter/sort purely against that already-computed array — no
additional chain or Antscan calls happen per request.

Local (ETH-denominated) and OpenSea (USD-denominated) listings are made
comparable for floor-price/sort purposes via a 5-minute-cached ETH/USD spot
price from Coinbase's public endpoint (`ethUsdPrice()`) — used only for
this display conversion, never anything financial. **The card UI always
shows the actual listed price in ETH first** (what a buyer's wallet
actually pays), with the USD-denominated $/ANT figure kept as a separate
reference line — an earlier version showed USD first, which made a 1 ETH
listing look like its dollar equivalent.

Lock duration/remaining time are computed from real dates, not raw epoch
counts: `epoch N starts at genesis + N * epochDuration` (both seconds, from
the on-chain `EmissionsGate`, `epochDuration` = 604,800 = 7 days). Computed
identically server-side (`epochToDate` in `server.js`) and client-side
(`epochDates` in `StakeANTS.jsx`, used as a fallback for the personal-
positions grid, which reads positions directly on-chain without these
precomputed fields).

### OpenSea cross-post (best-effort only)

`backend/opensea-list.js` posts a copy of a local listing to OpenSea's own
orderbook, purely for wider discovery — the site never depends on this
succeeding. Instant API keys are free but rate-limited (2/day per IP,
~7-day validity); the original bug this replaced was an **in-memory-only**
key cache burning the whole day's quota on every dev-server restart. Fixed
by persisting the resolved key to `backend/private/opensea-key.json`
(gitignored), reused across restarts until its real expiry (minus a 1h
margin).

### Frontend (`src/lib/listLants.js`, `src/api.js`, `src/components/StakeANTS.jsx`)

`src/lib/listLants.js` loads `@opensea/seaport-js` and `ethers` on demand
(so the rest of the dashboard doesn't pay for that bundle weight) and
exposes one function per user action — `createAndPostListing`,
`fulfillListing`, `cancelListing`, `makeOffer`, `cancelOffer`,
`acceptOffer`, plus the three chain-only actions below
(`splitPosition`, `mergePositions`, `movePosition`) — each
building/signing the Seaport order (marketplace actions) or sending the raw
contract call (split/merge/move) client-side via the connected wallet, then
calling the matching `src/api.js` wrapper (`postLantsListing`,
`cancelLantsListing`, `postLantsOffer`, `cancelLantsOffer`,
`acceptLantsOffer`, `fetchLantsOrder`/`fetchLantsOffer`) to persist or fetch
from the order book. Split/merge/move never touch the order book — they go
straight to `AntseedSellerPools` and the resulting position(s) show up via
`ensureIds` (below), not a database write.

`StakeANTS.jsx`'s market grid is paginated (10 per page, `MarketPager`),
filterable (seller, ANTS-amount range, lock-days range) and sortable
(id/amount/lock-length/time-left/price), with four tabs — **For sale**
(default), **All NFTs**, **Mine** (shown only when a wallet is connected,
filters to the connected address), and **History**. Each `LantsNftCard`
shows the real lock start/end dates as a Uniswap-LP-style diagonal range
curve (`LantsNftArt`, site-language-aware date formatting) rather than a
raw epoch range, and exposes List/Buy/Cancel-listing/Make-offer/
Accept-offer/Cancel-my-offer/Split/Merge/Move actions inline based on
ownership and listing state — there is no "view/buy on OpenSea" link
anywhere in this flow. Split/Merge/Move only ever appear on **Mine**, since
all three require the viewer to own the position.

### Split / Merge / Move (`AntseedSellerPools`, on-chain only — no Seaport)

These three actions restructure an existing lANTS position directly against
`AntseedSellerPools` on Base. None of them touch the order book — a listed
position can't be split/merged/moved (the UI hides the buttons; the
contract would also reject it since the position is escrowed to the
marketplace via approval, not literally transferred, so this is a UI-level
safeguard against confusing a buyer who has a pending fulfillment).

All three call one of `splitPosition`/`mergePositions`/`movePosition` in
`src/lib/listLants.js`, which share one shape end-to-end: build a minimal
single-function ABI, send the tx from the connected wallet via `ethers`'
`BrowserProvider`, wait for the receipt, parse the resulting event out of
the receipt's logs with `Interface.parseLog()` to recover the new position
id(s), then call `fetchLantsMarket({ ...marketQuery, wait: '1', ensureIds })`
with those new (and old, for merge) ids — same reasoning as a fresh
listing/buy: the new position(s) won't be in Antscan's cache yet, so the
ids are passed explicitly to force a synchronous on-chain read of exactly
those tokens (see `/api/lants-market`'s `ensureIds` handling above) instead
of waiting for the next background refresh. `StakeANTS.jsx`'s
`doSplit`/`doMergeSelected`/`doMove` chain a `refreshMyPositions()` call
*after* that market refresh resolves (not alongside it) for the same
reason `myPositions` exists at all — see the Merge writeup below for the
real race this fixed.

**Split** (`splitStake(positionId, splitAmountWei)` → `StakeSplit(positionId,
firstPositionId, secondPositionId)`): breaks one position into two, each
keeping the original's lock start/end epoch, one holding `splitAmountWei`
and the other the remainder. Burns the original NFT, mints two new ones,
both starting "Pending" until next epoch. UI gate (`canSplit`): caller owns
it, it isn't listed, it isn't a 1-ANT provider-activation stake, and its
amount is `> 1` ANT (so a valid split amount exists). The modal also warns
if either resulting half would land on exactly 1 ANT — indistinguishable
on-chain from a real activation stake, so this site would then refuse to
list it.

**Merge** (`mergeStakes(positionIds[])` → `StakesMerged(positionIds,
newPositionId, staker, amount, weightAmount)`): the inverse — combines two
or more positions into one. **On-chain requirements** (verified against the
live contract, not just source): every position must be owned by the
caller, share the same `agentId`, and — after each is closed for
restructuring — resolve to the *exact same* normalized start/end epoch, or
the whole call reverts (`InvalidValue`). In practice that only happens for
positions that already share both `stakeStartEpoch` and `stakeEndEpoch`, so
`mergeGroupKey()`/`groupMyPositions()` in `StakeANTS.jsx` filter to "same
seller + identical lock window" as a safe, simple stand-in for replicating
the contract's restructure math client-side — deliberately the same "same
locked time" grouping the Stakers tab already uses for its own combined
rows.

**UI (2026-09-21, redesigned from an earlier per-card "Merge" button after
live feedback):** the Mine tab groups the caller's positions
(`myPositions` — an uncapped fetch of every position they own, not just
whatever page of "Mine" happens to be open, since a mergeable sibling could
be on a different page) by `mergeGroupKey()`; any group of 2+ renders as one
`MergeGroup` block — a bordered cluster showing every member card with a
checkbox on it (`mergeCheckbox` prop) instead of each card getting its own
button, plus one "Merge selected (n)" action for the whole group. Any 2+
checked members can be merged together — there's no fixed "base" position
the way a per-card entry point would imply. A position with no eligible
partner (unique lock window, listed, or a 1-ANT activation stake) renders
as a plain standalone card with no merge affordance at all. Unlike List/
Offer/Split/Move, Merge has no modal: there's no extra input to collect
beyond "which ones," and the checkboxes already are that input, so
`doMergeSelected` fires directly off the group's button — the same
directness as Cancel/Buy elsewhere on this tab.

Groups are recomputed fresh from `myPositions` on every render, so a group
dissolves or reforms automatically: **the real bug this caught in
testing** was that moving one of two mergeable positions to a different
seller left the other one still showing as mergeable for a few seconds,
against a partner that had just moved away. Root cause was a race, not a
missing check — `doMove`'s `refreshMyPositions()` call used to fire
*alongside* its own `wait=1` market refresh instead of after it, so it
could return first with the pre-move data. Fixed by chaining
`refreshMyPositions()` in a `.then()` after that refresh resolves; see its
comment in `StakeANTS.jsx` for why that ordering alone is enough (the
market refresh's cache write completes before its response is even sent).
Merging or moving a position away removes it from `myPositions` on the
next refresh, so any group it was part of either shrinks (if 2+ remain) or
disappears (if only one position is left with no partner) with no separate
"undo the group" step needed. Burns every selected source, mints one new
position for the combined amount, starting "Pending" until next epoch.

**Move** (`moveStake(positionId, toAgentId)` → `StakeMoved(oldPositionId,
newPositionId, staker, fromAgentId, toAgentId)`): re-points a position at a
*different* registered seller agent, keeping its principal and unlock date
unchanged — this is "which seller does my stake back," not a
lock/amount change. On-chain requirement: `toAgentId` must be a currently
registered seller agent (`SellerRegistry`); the contract has no lock-window
constraint here (unlike merge) since it's a single position, not a
combination. The contract can apply an admin-settable
`moveWeightPenaltyBps` to the position's *future* reward weight as a
disincentive against churning between sellers — **read live on-chain while
building this** and confirmed it is currently `0`, so the Move modal's copy
says "0% currently" rather than promising no penalty forever, since it's a
governance knob that could change. UI gate (`canMove`): same ownership/
not-listed/not-activation-stake checks as Split, with no minimum amount
(moving doesn't split anything) — any single eligible position can move.
The Move modal is a `<select>` of registered sellers (the same `sellers`
list used for the market's seller filter), excluding the position's
current agent. Burns the old NFT, mints a new one backing the chosen
seller, starting "Pending" until next epoch.

**To actually test Merge**, you need two lANTS positions in the same
wallet, staked with the *same* seller and locked for the *same* number of
days at the *same* time (so their `stakeStartEpoch`/`stakeEndEpoch` already
match) — e.g. stake twice in a row into the same seller with the same lock
length before the epoch rolls over, or use Split first to produce two
siblings from one position (Split always preserves the original epochs on
both halves, so a freshly-split pair is always merge-eligible with each
other). **To test Move**, you only need one non-listed, non-activation
position and at least two registered sellers to choose between.

### Stakers tab (public, read-only) vs. the lANTS tab

Both tabs read the same underlying `AntseedSellerPools` positions, but for
different purposes and audiences:

| | lANTS tab | Stakers tab |
|---|---|---|
| Shown as | one card per NFT (`lants-market` items) | one row per staker, positions with the same address + lock length combined |
| Needs a wallet? | only to act (list/buy/split/merge/move) — browsing doesn't | never — fully public |
| Data source | `/api/lants-market` (Antscan + on-chain + local order book, 90s cache) | `/api/stakers` → local `stake_positions` SQLite table, synced every 5 min alongside the rest of `runHistorySync()` (no live Antscan call on the request path — this was a 2026-09-21 loading-speed fix, see `notes/dev-plan.md`) |
| Purpose | trade/manage individual positions | "how much is staked, by whom, for how long" at a glance |

They're deliberately two tabs, not one view with a toggle: the lANTS tab's
unit of interaction is the NFT (you split/merge/move *a specific position*),
while the Stakers tab's unit is the *person* (their combined stake). Forcing
both into one table would mean either losing the per-NFT actions or losing
the clean combined-per-staker numbers.

### Planned: a marketplace fee (not yet implemented)

**Status: deferred on purpose.** The marketplace just shipped (USDC
pricing, split/merge/move, the Mine-tab staleness fixes — all this
session) and currently charges **0% to anyone** on every trade — verified
directly against the real deployed Seaport 1.6 contract (`0x0000...eB395`
on Base, source pulled live from Sourcify): every offer/consideration item
pays `item.amount` straight to `item.recipient`, with no protocol-level
skim, and this site's own orders (`src/lib/listLants.js`) only ever
include one consideration item — no fee item appended. The call was to
get real users trading first and only add a fee once there's real volume
to justify the engineering + UX cost of a change that touches every order
a user signs. Revisit once there's a meaningful base of repeat listers/
buyers, not before.

**How it would work, when it's time:** Seaport already supports this
natively — seaport-js's `createOrder()` takes a `fees: [{ recipient,
basisPoints }]` array and appends an extra consideration item paying that
cut, the exact mechanism OpenSea's own site uses for its 2.5%. No new
on-chain mechanism needed, just start passing that parameter.

**What actually needs a decision before implementing** (not this doc's
call to make):

- **Rate.** OpenSea charges 2.5%; most newer marketplaces run 0.5–1% to
  stay competitive. Needs an explicit number from the site owner.
- **Recipient.** A plain wallet address, or something more structured
  (e.g. routed toward ANTS stakers) if the fee should read as
  protocol-native revenue rather than personal take.
- **List side, offer side, or both.** Same mechanism either way.
- **Backend validation must change.** `/api/lants/list` and
  `/api/lants/offer` (`backend/server.js`) currently assume exactly one
  consideration/offer item is the real payment
  (`order.parameters.consideration?.[0]`); adding a fee item means
  distinguishing "the real payment to the seller" from "the fee to us"
  when extracting `priceWei` to store and display, not just accepting a
  longer array.
- **Backward compatibility.** A fee can only apply going forward — it
  cannot retroactively attach to anything already signed. Any listing/
  offer created before the change stays fee-less until it's cancelled and
  redone; no migration needed, but don't assume every stored order has
  the new shape once this ships.
- **Display honesty.** The price shown must stay what the buyer actually
  pays; if a fee comes out of the seller's side, the UI needs to say the
  seller nets less than the sticker price, not just silently show a
  smaller number arriving on-chain (matches this session's "there should
  be a message" / no-silent-surprises bar for every other action on this
  page).

---

## Lessons Learned

### 1. Always rebuild before restarting the server

After adding new API routes to `backend/server.js`, you **must** run `npm run build` (or `vite build`) and then restart the Express server. The server serves the SPA from `dist/` via a catch-all fallback:

```js
app.use(express.static(path.join(__dirname, '../dist')));
app.use((_req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});
```

If the old `dist/` is still in place when the server starts, new `/api/*` routes may be shadowed by the static middleware or the SPA fallback, returning `index.html` instead of JSON. The fix is always: **build first, then restart**.

### 2. API route registration order matters with SPA fallback

Express evaluates middleware in registration order. The `express.static` and catch-all fallback must be registered **after** all `/api/*` routes. If you accidentally place them before an API route, that route will never be reached — the fallback will serve `index.html` for every unmatched path. Keep this invariant:

```
/api/* routes  →  express.static  →  SPA catch-all
```

### 3. User-facing copy actions must confirm success

When implementing "copy to clipboard" buttons, always provide inline feedback (e.g., button text briefly changes to "Copied!") instead of using `alert()`. A popup dialog is disruptive and not user-friendly. Use a state-driven approach: set a `copiedKey` state on copy, render "Copied!" on the button, and clear it after a short timeout (1.5s).

### 4. Environment-dependent endpoints must be tested end-to-end

The `/api/provider/models` endpoint proxies to an external service (`PROVIDER_BASE_URL`). When testing, verify the full chain:

1. External service is reachable: `curl $PROVIDER_BASE_URL/models`
2. Backend API returns JSON: `curl localhost:3001/api/provider/models`
3. Frontend renders the data correctly

Skipping any step can lead to false confidence. In this project, step 2 failed because the stale `dist/` caused the SPA fallback to intercept the route.

---

## Network Diagram

```
User Browser
  |
  |-- HTTP GET /                  → index.html (Vite production build)
  |-- HTTP GET /assets/*.js       → static JS bundle
  |-- HTTP GET /api/stats         → SQLite stats row (Antscan-sourced volume/buyers)
  |-- HTTP GET /api/services      → all services from SQLite (live DHT snapshot)
  |-- HTTP GET /api/history/*     → daily/epoch/buyers/sellers time series (Antscan, cached)
  |-- HTTP GET /api/chain-stats   → live Base mainnet reads (supply, epoch, allocation)
  |-- HTTP GET /api/tokenomics    → cached (5min TTL) allocation + dynamic-share computation
  |-- HTTP GET /api/emissions/*   → legacy-era emissions data from Base mainnet
  |-- HTTP GET /api/rewards       → five-bucket rewards view (staker/usage/legacy/locked)
  |-- HTTP GET /api/deposits/config → live contract addresses (source of truth for wagmi calls)
  |-- HTTP GET /api/channels      → proxies the local buyer proxy's channel list
  |-- HTTP GET /api/lants-market  → paginated lANTS NFT market (self-hosted Seaport order book)
  |-- HTTP POST /api/lants/list   → save a signed Seaport listing (+ best-effort OpenSea cross-post)
  |-- HTTP GET /api/lants/order/:tokenId → stored signed order for a buyer to fulfill
  |-- HTTP POST /api/lants/cancel → cancel a listing (signed-message auth)
  |-- HTTP POST /api/lants/offer  → save a signed USDC offer
  |-- HTTP GET /api/lants/offers/:tokenId, /api/lants/offer/:offerId → read offers
  |-- HTTP POST /api/lants/offer/cancel, /api/lants/offer/accept → cancel/accept an offer
  |-- HTTP POST /api/admin/sync   → triggers live network re-sync (token-gated, see README)
  |-- Direct wallet tx            → claimSellerEmissions / claimBuyerEmissions on Base
  |-- Direct wallet tx            → indexPoolRewards + claimStakerRewardsBatch / claimBuyerReward
  |-- Direct wallet tx            → AntseedChannels.requestClose / .withdraw
  |-- Direct wallet tx            → Seaport fulfillOrder() — buy a listing, or accept an offer
```
