# AntSeed Dashboard — Implementation Docs

A peer-to-peer AI inference marketplace dashboard that displays real live network data from the AntSeed protocol.

## Quick Start

```bash
npm install
npm run dev # starts backend + frontend concurrently (interactive, for local dev)
npm run server # backend only
npm run build # production build
```

### Running in Background / Production

`npm run dev` is for interactive local development (it runs Vite + Express via `concurrently`). For persistent or headless environments, run the backend directly — it serves the built frontend from `dist/` on a single port:

```bash
npm run build                # ensure dist/ is up to date
nohup node backend/server.js > /tmp/server.log 2>&1 &
```

This keeps the process alive after the terminal exits. Verify with:

```bash
curl -s http://localhost:3001/api/stats   # should return JSON
curl -s http://localhost:3001/             # should return HTML
```

## What's In This Repo

- `src/` — React frontend (Vite, hooks, fetch-based)
- `backend/` — Express API server with SQLite persistence
- `dist/` — production frontend build (served by Express)
- `docs/` — this documentation

---

## Architecture Overview

```
Browser                                                  
http://localhost:3001/                            
            |                                           
            v                                           
Express Server (PORT 3001)
  |-- /api/*       → REST endpoints (SQLite)            
  |-- /api/admin/sync → Trigger live network resync     
  |-- /*           → static dist/index.html (SPA)       
           |                                           
           | reads from → backend/database.sqlite        
           |                                           
           | syncs from → https://network.antseed.com/stats
                           (official live network API)  
```

---

## Data Flow

1. Server boots
2. Fetches https://network.antseed.com/stats
3. Parses peers → sellers, providers → services
4. Writes into SQLite (backend/database.sqlite)
5. Frontend loads via /api/* endpoints
6. Dashboard renders real peers, pricing, categories, protocols

---

## Files & Responsibilities

| Path | What it does |
|---|---|
| backend/server.js | Express app: routes, static file serving, start-up sync, rewards endpoints |
| backend/database.js | SQLite schema + seed (buyers, sellers, services, stats) |
| backend/chain-poller.js | On-chain metrics poller (supply, epoch clock, gate allocation, USDC balances) |
| backend/sync-official.js | Fetches live AntSeed network data and writes to DB |
| src/App.jsx | Root component: fetches data, manages tabs |
| src/api.js | Thin fetch wrapper for /api/* endpoints |
| src/components/StatsCards.jsx | Overview stat cards with growth rates |
| src/components/BuyersList.jsx | Searchable buyers table |
| src/components/SellersList.jsx | Searchable sellers table |
| src/components/ServicesList.jsx | Searchable/filterable services table |
| src/components/ClaimANTS.jsx | Five-bucket rewards view + wallet claim flows |
| src/components/ANTSInfo.jsx | On-chain ANTS data, contracts, allocation, reward mechanics |
| vite.config.js | Vite config with host: true for public access |
| package.json | dev script uses concurrently to run both servers |

---

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| PORT | 3001 | Express server port |

No .env file is required out of the box.

---

## Emissions Contract Migration (legacy era)

The emissions contract was migrated during epoch 4. Points must be read from **both** contracts:

| Contract | Address | Epochs |
|---|---|---|
| V1 (legacy) | `0x36877fBa8Fa333aa46a1c57b66D132E4995C86b5` | Epochs 0–3 (all points), Epoch 4 (partial) |
| V2 (current) | `0xF13bE52c4A3afC6AE29536f073588d01A0564088` | Epoch 4 (partial), Epoch 5+ (all points) |

- For epochs 0–3: only the V1 contract has points. Claim from V1.
- For epoch 4: both contracts have partial points. Add them together for totals. Claim from both contracts.
- For epoch 5+: only the V2 contract has points. Claim from V2.

The backend (`/api/emissions/pending`) merges both contracts automatically. The frontend (`ClaimANTS.jsx`) routes claim transactions to the correct contract based on epoch.

---

## Recognized Usage Era (epoch 22+, since September 10, 2026)

Since epoch 22 the protocol connects ANTS rewards to paid service delivery and
seller-pool stake (the "recognized usage" M001 deployment). Rewards now come in
**five buckets**, all viewable on the Claim ANTS tab via `GET /api/rewards?address=0x…`:

| Bucket | Earned via | Read from | Claimed via |
|---|---|---|---|
| Staker | Locked ANTS (lANTS) positions in seller pools | `AntseedSellerPools` + `AntseedSellerPoolsRewards` | `indexPoolRewards` (prep) then `claimStakerRewardsBatch(positionIds, recipient)` |
| Seller usage | Recognized seller points × pool power | `AntseedUsageAccounting`, `AntseedUsageRewards` | `UsageAccounting.claimSellerEmissions(epochs)` |
| Buyer usage | Recognized buyer points (settled USDC volume) | `AntseedUsageRewards` | `UsageRewards.claimBuyerReward(buyer, epoch)` — paid to the deposits operator |
| Legacy | Pre-epoch-22 buyer/seller emissions | Legacy Emissions V1/V2 | `claimSellerEmissions(epochs)` / `claimBuyerEmissions(buyer, epochs)` (V1 for epochs < 4) |
| Locked (M002) | 10% releases of cumulative locked legacy seller ANTS | `SellerRewardsPool` (resolved from legacy Emissions) | `claim(recipient)` |

Key facts:

- **Epoch clock**: weekly epochs, 104-epoch halving, gate genesis April 9, 2026.
- **Allocation ceilings** (live from the gate via `/api/chain-stats` `allocation`):
  40% seller-pools / 20% usage / 15% team / 15% reserve / 10% verification —
  the seller-pool and usage shares are dynamic (scale with active stake and
  recognized volume).
- **Max supply**: 1.04B ANTS, read live from the token contract
  (`ANTSToken.maxSupply()`), no longer hardcoded.
- Legacy endpoints (`/api/emissions/pending`, `/api/emissions/claimed`) still
  serve the legacy epoch breakdown table (epochs 0–21 in the recognized era).
  Epoch 4 has partial points in both the V1 and V2 contracts; the pending
  response includes a per-contract breakdown, and claims are routed to each
  contract that still has pending.

Core M001 contracts (Base mainnet): EmissionsGate `0xe60a31e6cd2f8455503ca0b3f6545dd3ddf543bd`,
SellerPools `0x8bf4d39aa13f3cb03f87d9500767fbc4d0940652`, SellerRegistry `0x99c533bcc6ca646e543dba835fdbb9c2ee02cb60`,
UsageAccounting `0xadd2d85316153d7bfaf7921ee9bf1bb6c7a1cbc9`, UsageRewards `0x78330bf154172f1137219bb559d4f3a270b3201f`,
SellerPoolsRewards `0x83cc5b9aa0c8cb8683f35462c385a5baaa755ee5`. The full list
(including legacy contracts) is served by `/api/chain-stats` → `contracts`.

---

## Tech Stack

- Frontend: React 19, Vite 6, Lucide React (icons)
- Backend: Express 5, CORS, better-sqlite3
- Database: SQLite (WAL mode enabled)
- Data Source: AntSeed official network stats API (network.antseed.com/stats)
- Deployment: Single-port Express serves API + static SPA
