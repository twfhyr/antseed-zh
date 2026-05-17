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
| backend/server.js | Express app: routes, static file serving, start-up sync |
| backend/database.js | SQLite schema + seed (buyers, sellers, services, stats) |
| backend/sync-official.js | Fetches live AntSeed network data and writes to DB |
| src/App.jsx | Root component: fetches data, manages tabs |
| src/api.js | Thin fetch wrapper for /api/* endpoints |
| src/components/StatsCards.jsx | Overview stat cards with growth rates |
| src/components/BuyersList.jsx | Searchable buyers table |
| src/components/SellersList.jsx | Searchable sellers table |
| src/components/ServicesList.jsx | Searchable/filterable services table |
| vite.config.js | Vite config with host: true for public access |
| package.json | dev script uses concurrently to run both servers |

---

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| PORT | 3001 | Express server port |

No .env file is required out of the box.

---

## Emissions Contract Migration

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

## Tech Stack

- Frontend: React 19, Vite 6, Lucide React (icons)
- Backend: Express 5, CORS, better-sqlite3
- Database: SQLite (WAL mode enabled)
- Data Source: AntSeed official network stats API (network.antseed.com/stats)
- Deployment: Single-port Express serves API + static SPA
