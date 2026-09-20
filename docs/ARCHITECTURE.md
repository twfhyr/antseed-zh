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
Staking tab lets holders list, buy, cancel, make offers on, and accept
offers for these NFTs entirely on **antseed-zh's own order book**, using the
[Seaport](https://github.com/ProjectOpenSea/seaport) protocol directly
against the contract on Base. Nothing on this flow depends on OpenSea's API,
an API key, or OpenSea having indexed the NFT — a listing is usable the
instant it's created. OpenSea cross-posting still happens best-effort (wider
discovery, when a key is available) but the site never blocks on it or
requires it.

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

- **Listing** = `offer: [ERC721 NFT]`, `consideration: [ETH payment →
  seller]`. The buyer's wallet calls `fulfillOrder()`, attaching the price
  as `msg.value`; Seaport moves the NFT to the buyer and the ETH to the
  seller in one transaction.
- **Offer** = the mirror image — `offer: [ERC20 payment]`, `consideration:
  [ERC721 NFT → buyer]`. The **owner's** wallet calls `fulfillOrder()` to
  accept it, pulling the buyer's pre-approved ERC20 and sending the NFT.

### Why offers use WETH, not raw ETH

`fulfillOrder()` for an offer is called by the **seller** (the position
owner), not the buyer. Only the caller of a transaction can attach
`msg.value` — so the owner's fulfillment tx can't pull ETH out of the
buyer's wallet on their behalf. It *can* pull a pre-approved ERC20, though.
So a buy-side offer's payment item must be WETH: `src/lib/listLants.js`'s
`makeOffer()` wraps ETH into WETH first (`ensureWeth()` calls `deposit()`
for any shortfall) before creating the order. Base's canonical WETH
predeploy — same address on every OP-Stack chain — is
`0x4200000000000000000000000000000000000006` (verified via `name()`, not
assumed).

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
| `lants_offers` | One row per offer (autoincrement id, many per token) — offerer, `price_wei`, the WETH token address, the signed order, `cancelled_at`/`accepted_at`. |
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
| `/api/lants/offer` | POST | `{ tokenId, order, protocolAddress }` — validates the offer's payment item is WETH and its consideration targets this token; saves it. |
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
`acceptOffer` — each building/signing the Seaport order client-side via the
connected wallet, then calling the matching `src/api.js` wrapper
(`postLantsListing`, `cancelLantsListing`, `postLantsOffer`,
`cancelLantsOffer`, `acceptLantsOffer`, `fetchLantsOrder`/`fetchLantsOffer`)
to persist or fetch from the order book.

`StakeANTS.jsx`'s market grid is paginated (10 per page, `MarketPager`),
filterable (seller, ANTS-amount range, lock-days range) and sortable
(id/amount/lock-length/time-left/price), with three tabs — **For sale**
(default), **All NFTs**, and **Mine** (shown only when a wallet is
connected, filters to the connected address). Each `LantsNftCard` shows the
real lock start/end dates as a Uniswap-LP-style diagonal range curve
(`LantsNftArt`, site-language-aware date formatting) rather than a raw
epoch range, and exposes List/Buy/Cancel-listing/Make-offer/Accept-offer/
Cancel-my-offer actions inline based on ownership and listing state — there
is no "view/buy on OpenSea" link anywhere in this flow.

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
  |-- HTTP POST /api/lants/offer  → save a signed WETH offer
  |-- HTTP GET /api/lants/offers/:tokenId, /api/lants/offer/:offerId → read offers
  |-- HTTP POST /api/lants/offer/cancel, /api/lants/offer/accept → cancel/accept an offer
  |-- HTTP POST /api/admin/sync   → triggers live network re-sync (token-gated, see README)
  |-- Direct wallet tx            → claimSellerEmissions / claimBuyerEmissions on Base
  |-- Direct wallet tx            → indexPoolRewards + claimStakerRewardsBatch / claimBuyerReward
  |-- Direct wallet tx            → AntseedChannels.requestClose / .withdraw
  |-- Direct wallet tx            → Seaport fulfillOrder() — buy a listing, or accept an offer
```
