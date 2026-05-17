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
- Tabs (Buyers / Sellers / Services) conditionally render child list components
- No state management library; plain React `useState` is sufficient for this scope

### Data Binding

```
App.jsx (useEffect → fetch)
  ├─ StatsCards ← stats object
  ├─ BuyersList ← buyers array + search
  ├─ SellersList ← sellers array + search
  └─ ServicesList ← services array + search + category filter
```

---

## ANTS Claim System

### Overview

The Claim tab lets users connect their EVM wallet (MetaMask, Coinbase Wallet, etc.) on Base mainnet and claim accumulated ANTS emissions from past epochs.

### Smart Contract

The **Emissions contract** (`0xF13bE52c4A3afC6AE29536f073588d01A0564088` on Base) handles all claim logic.

#### Key Functions (from ABI)

**Write (claim):**
- `claimSellerEmissions(uint256[] epochs)` — Seller claims their ANTS for given epochs
- `claimBuyerEmissions(address buyer, uint256[] epochs)` — Claim buyer ANTS for given epochs

**Read (eligibility):**
- `pendingEmissions(address account, uint256[] epochs)` → `(uint256 seller, uint256 buyer)` — Pending ANTS for an address across epochs
- `sellerEpochClaimed(address account, uint256 epoch)` → `bool` — Whether seller already claimed an epoch
- `buyerEpochClaimed(address account, uint256 epoch)` → `bool` — Whether buyer already claimed an epoch
- `userSellerPoints(address account, uint256 epoch)` → `uint256` — Seller points earned in an epoch
- `userBuyerPoints(address account, uint256 epoch)` → `uint256` — Buyer points earned in an epoch
- `currentEpoch()` → `uint256` — Current epoch number
- `EPOCH_DURATION()` → `uint256` — Seconds per epoch (604,800 = 1 week)
- `INITIAL_EMISSION()` → `uint256` — First epoch budget (5,000,000 ANTS)
- `HALVING_INTERVAL()` → `uint256` — Epochs between halvings (104)
- `SELLER_SHARE_PCT()` → `uint256` — Seller share (50)
- `BUYER_SHARE_PCT()` → `uint256` — Buyer share (20)
- `RESERVE_SHARE_PCT()` → `uint256` — Reserve share (15)
- `TEAM_SHARE_PCT()` → `uint256` — Team share (15)

### Emission Schedule

| Parameter | Value |
|---|---|
| Max supply | 1,040,000,000 ANTS |
| Epoch duration | 1 week (604,800 seconds) |
| First epoch budget | 5,000,000 ANTS |
| Halving interval | Every 104 epochs (~2 years) |
| Seller share | 50% (currently locked in Provider Pool) |
| Buyer share | 20% (eligible for claiming) |
| Reserve share | 15% |
| Team share | 15% (vested) |

### Claim Flow (Frontend)

```
1. User clicks "Connect Wallet"
   → window.ethereum.request({ method: 'eth_requestAccounts' })
   → Get connected address

2. Fetch epoch info from backend
   → GET /api/emissions/epoch-info
   → Returns currentEpoch, epochDuration, genesis, halvingInterval

3. Fetch user's pending emissions
   → GET /api/emissions/pending?address=0x...&epochs=0,1,2,...,currentEpoch-1
   → Returns { sellerPending, buyerPending } per epoch + totals

4. Filter to unclaimed epochs only
   → GET /api/emissions/claimed?address=0x...&epochs=0,1,2,...
   → Filters out epochs where sellerEpochClaimed/buyerEpochClaimed is true

5. User clicks "Claim"
   → Direct contract interaction from browser via ethers.js + window.ethereum
   → claimBuyerEmissions(address, [unclaimedEpochs]) or claimSellerEmissions([unclaimedEpochs])
   → Wait for tx receipt, show success

6. Refresh pending emissions after claim
```

### Backend Endpoints (read-only, proxy to chain)

| Endpoint | Method | Description |
|---|---|---|
| `/api/emissions/epoch-info` | GET | Current epoch, emission rate, epoch duration |
| `/api/emissions/pending` | GET | `?address=0x...&epochs=0,1,2` → pending seller/buyer ANTS |
| `/api/emissions/claimed` | GET | `?address=0x...&epochs=0,1,2` → which epochs already claimed |
| `/api/emissions/points` | GET | `?address=0x...&epochs=0,1,2` → user points per epoch |

Claims are **not** proxied through the backend — the user's browser sends the transaction directly to Base mainnet via their wallet provider. This keeps private keys in the wallet and avoids the server needing any signing capability.

### SDK Usage (@antseed/node)

```javascript
import { EmissionsClient, resolveChainConfig } from '@antseed/node';

const cfg = resolveChainConfig('base-mainnet');

const client = new EmissionsClient({
  rpcUrl: cfg.rpcUrl,
  fallbackRpcUrls: cfg.fallbackRpcUrls,
  contractAddress: cfg.emissionsContractAddress, // 0xF13bE52c4A3afC6AE29536f073588d01A0564088
  evmChainId: cfg.evmChainId,                    // 8453
});

// Read pending emissions (no signer needed)
const { seller, buyer } = await client.pendingEmissions(address, [1, 2, 3]);

// Check if claimed
const claimed = await client.buyerEpochClaimed(address, 1);

// Claim (requires ethers Signer from browser wallet)
const txHash = await client.claimBuyerEmissions(signer, address, [1, 2, 3]);
const txHash2 = await client.claimSellerEmissions(signer, [1, 2, 3]);
```

### Contract Addresses (Base Mainnet, Chain ID 8453)

| Contract | Address |
|---|---|
| ANTS Token | `0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263` |
| Emissions | `0xF13bE52c4A3afC6AE29536f073588d01A0564088` |
| Deposits | `0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2` |
| Channels | `0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d` |
| Staking | `0x3652E6B22919bd322A25723B94BB207602E5c8e6` |
| Stats | `0x15649ff076BFa5e37e24EE3154a00503149954Fd` |
| Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

### Eligibility Notes

- **Buyer emissions**: Eligible after epoch finalization. Subject to caps and anti-abuse checks. Buyer must have deposited USDC and paid for AI services.
- **Seller emissions**: Currently locked in a Provider Pool. The `claimSellerEmissions` function exists but emissions are routed to the locked pool while stronger validation is introduced.
- **Anti-abuse**: Farming, fake volume, sybil behavior, spam, or value extraction may be capped, excluded, delayed, locked, or subject to future slashing.

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
  |-- HTTP GET /api/stats         → SQLite stats row
  |-- HTTP GET /api/services      → all services from SQLite
  |-- HTTP GET /api/emissions/*   → read emissions data from Base mainnet
  |-- HTTP POST /api/admin/sync   → triggers live network re-sync
  |-- Direct wallet tx            → claimSellerEmissions / claimBuyerEmissions on Base
```
