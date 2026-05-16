# AntSeed Dashboard — Implementation Docs

A peer-to-peer AI inference marketplace dashboard that displays real live network data from the AntSeed protocol.

## Quick Start

```bash
npm install
npm run dev        # starts backend + frontend concurrently
npm run server     # backend only
npm run build      # production build
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

## Tech Stack

- Frontend: React 19, Vite 6, Lucide React (icons)
- Backend: Express 5, CORS, better-sqlite3
- Database: SQLite (WAL mode enabled)
- Data Source: AntSeed official network stats API (network.antseed.com/stats)
- Deployment: Single-port Express serves API + static SPA
