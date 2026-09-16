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
  ├─ Protocol     ← static protocol-mechanics copy + live Mermaid diagrams
  │                 (no backend calls — see docs/PROTOCOL_SECTION_PLAN.md)
  ├─ AntsTokenomics ← /api/tokenomics (Supply & Allocation sub-tab: supply,
  │                 allocation pies, dynamic shares) + /api/chain-stats
  │                 (Rewards & How It Works sub-tab: epoch clock, contract
  │                 map, reward-mechanics explainer)
  ├─ ClaimANTS    ← /api/rewards (five buckets) + wagmi wallet claims
  ├─ ChannelsView ← /api/channels (buyer proxy) + live channels() reads via
  │                 the address from /api/deposits/config (never hardcoded —
  │                 AntseedChannels is swappable and does get redeployed)
  └─ About        ← this node's own peer info + connection guide
```

`AntsTokenomics` (`src/components/AntsTokenomics.jsx`) merges what used to
be two separate tabs — `TokenomicsTab` and `ANTSInfo` — which both read
chain-level ANTS data and overlapped (supply/allocation appeared in both,
styled differently — pie charts vs. a flat list). The pies stayed once, in
the Supply & Allocation sub-tab; `ANTSInfo`'s unique content (contract
address list, "how rewards are earned" / "how to earn" explainers) moved
into the Rewards & How It Works sub-tab. `/tokenomics` and `/ants-info`
both still resolve as URLs, defaulting to Supply and Rewards respectively.

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
  |-- HTTP POST /api/admin/sync   → triggers live network re-sync (token-gated, see README)
  |-- Direct wallet tx            → claimSellerEmissions / claimBuyerEmissions on Base
  |-- Direct wallet tx            → indexPoolRewards + claimStakerRewardsBatch / claimBuyerReward
  |-- Direct wallet tx            → AntseedChannels.requestClose / .withdraw
```
