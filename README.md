# antseed-zh

A live dashboard for the [AntSeed](https://antseed.com) peer-to-peer AI inference
network — protocol-wide stats, the buyer/seller/service catalog, $ANTS
tokenomics, and wallet-gated reward claims / payment-channel management.
Deployed at antseed-zh.com and as a `/zh` sub-path on a shared box.

**Core rule for anyone working on this codebase: never fabricate a number.**
If a real value can't be read from the network or the chain, the UI shows
`—`, not a guess, a placeholder constant, or a `requests * 0.1`-style
heuristic. See [Data Sources & Calculations](#data-sources--how-every-number-is-calculated)
below for what backs every figure on screen, and `AGENTS.md` for the full
workflow this rule implies.

## Quick Start

```bash
npm install
npm run dev      # frontend (Vite, :5173) + backend (Express, :3001), concurrently
npm run server   # backend only
npm run build    # production build -> dist/ (or dist-root/, see Deployment)
```

### Running in the background / production

```bash
npm run build
nohup node backend/server.js > /tmp/server.log 2>&1 &
```

`backend/server.js` serves both the API and the built frontend from `dist/`
on a single port — verify with:

```bash
curl -s http://localhost:3001/api/stats   # JSON
curl -s http://localhost:3001/            # HTML
```

**After changing anything under `backend/`, restart the process** (it holds
the route table in memory). After changing anything under `src/`, **rebuild**
(`npm run build`) — the running server reads `dist/` from disk on every
request, so a stale `dist/` silently keeps serving old JS even though the
source changed.

## Architecture

```
Browser
  |
  v
Express (backend/server.js), single port (default 3001)
  |-- /api/*            REST endpoints, reading from SQLite (fast) or
  |                     live chain/GraphQL reads (cached, see below)
  |-- /api/admin/*       Manual re-sync triggers (token-gated, see below)
  |-- /*                 Static dist/ build + SPA catch-all (client routing)
  |
  |-- reads/writes -> backend/database.sqlite (better-sqlite3, WAL mode)
  |
  |-- syncs from --> https://network.antseed.com/stats   (live peer/service DHT snapshot)
  |-- syncs from --> https://antscan.co/graphql            (real settled on-chain totals)
  |-- reads from  --> Base mainnet RPC via @antseed/node   (ANTS supply, epochs, rewards)
```

Three independent data sources feed the dashboard, each read by a dedicated
backend module, each cached in SQLite so the frontend never makes a raw RPC
or GraphQL call itself:

| Source | Module | What it's good for | What it can't tell you |
|---|---|---|---|
| `network.antseed.com/stats` (live DHT snapshot) | `backend/sync-official.js` | The current peer/provider/service catalog: names, pricing, categories, protocols, `onChainStats.agentId` | Historical or aggregate USDC volume — it's a live snapshot, not a ledger |
| Antscan GraphQL (`antscan.co/graphql`) | `backend/antscan.js` + `backend/sync-history.js` | Real settled volume, requests, tokens, buyer/seller counts — network-wide, per-address, per-day, per-epoch | Live peer metadata (pricing, categories) — it only indexes on-chain events |
| Base mainnet RPC via `@antseed/node` | `backend/chain-poller.js` + inline reads in `backend/server.js` | ANTS supply, epoch clock, emission allocation, reward buckets, contract addresses — all read live from the contracts themselves | Off-chain/DHT-only data like service pricing |

Frontend components never fabricate a fallback: every fetch hook either
renders the real value or an explicit "unavailable" state. See
`docs/ARCHITECTURE.md` for the full sync lifecycle, endpoint list, and
per-tab data binding, and `docs/DEMAND.md` for the original functional spec.

## Data Sources & How Every Number Is Calculated

This is the part that matters most for trust in the dashboard. Every
headline figure maps to exactly one of the three sources above — no
client-side math that invents a percentage, and no seed/mock data left in
any code path that ships.

| UI section | Number | Source | How it's computed |
|---|---|---|---|
| Overview | Total buyers / sellers / services / volume | `/api/stats` | `buyer_count`/`total_volume_usdc` from the latest Antscan `network_snapshots` row; seller/service counts from the live DHT sync. `null` (rendered `—`) until the first successful sync of each source — never a hardcoded seed. |
| Overview | Day-over-day growth % | `/api/stats` (`*_growth` fields) | Real `(latest - prior) / prior` over the last two **closed** UTC days in `daily_metrics` (Antscan-sourced). `null` if fewer than 2 closed days exist yet. Currently computed but not rendered in `StatsCards.jsx` — see `notes/dev-plan.md`. |
| Overview | Daily / epoch history charts | `/api/history/daily`, `/api/history/epochs` | `daily_metrics` / `epoch_metrics` tables, backfilled from Antscan. A day/epoch is written once and then frozen (`is_closed = 1`) the moment its UTC window fully elapses — historical rows are never silently rewritten on a later sync. |
| Sellers | Peer list, model count, categories | `/api/sellers` | Live DHT snapshot (`network.antseed.com/stats`), rebuilt on every sync cycle. |
| Sellers | Total earned (USDC) | `/api/sellers` | Matched by `agentId` to Antscan's real `earnedUsdc` per seller. `null` ("—") when no agentId can be resolved for that peer — **never** a `settlementCount * 0.5`-style estimate (that formula existed in an earlier version and was removed; see `backend/sync-official.js` comments). |
| Sellers | Uptime | — | Not shown. There is no real per-peer uptime signal in either data source; a prior version hardcoded `99.5` for every row, which was deleted rather than replaced with another guess. |
| Services | Pricing, categories, protocols, load | `/api/services` | Verbatim from the live DHT snapshot's per-provider `servicePricing`/`serviceCategories`/`currentLoad`, deduplicated globally by `(service, provider, seller)` since the same provider can list a service more than once in real peer metadata. |
| Buyers | Address, spend, requests, unique sellers | `/api/history/buyers` | Antscan's real `buyers` entity, paginated and cached in `buyers_onchain`. |
| $ANTS Info / Tokenomics | Supply, epoch, emission rate, halving | `/api/chain-stats`, `/api/tokenomics` | Live reads via `@antseed/node` (`ANTSTokenClient.totalSupply/maxSupply`, `EmissionsGateClient.currentEpoch/genesis/halvingInterval`), refreshed by `chain-poller.js` every 5 minutes and cached in `chain_metrics`. |
| $ANTS Info / Tokenomics | Allocation ceilings (40/20/15/15/10%) | `/api/chain-stats` `allocation` | Read live from `EmissionsGateClient.minter()` per bucket, **not** a hardcoded percentage — these are mutable on-chain via `setShares`. |
| $ANTS Info / Tokenomics | Dynamic staker/usage share | `/api/tokenomics` | `share = minimum + (maximum − minimum) × input / (input + target)`, computed server-side from live `totalActiveStake` / recognized USDC volume against the on-chain target parameters — see `docs/ARCHITECTURE.md` for the full formula and inputs. |
| Claim ANTS | Five reward buckets (staker / seller usage / buyer usage / legacy / locked) | `/api/rewards?address=` | Each bucket is a direct read against its own contract (`SellerPoolsRewards`, `UsageAccounting`/`UsageRewards`, legacy `Emissions` V1/V2, `SellerRewardsPool`) — no aggregation or estimation. Claims are sent directly from the browser via wagmi; the backend never proxies or signs a transaction. |
| Payment Channels | Channel list, reserved/used/status | `/api/channels` + on-chain `channels()` read | The buyer proxy (`_antseed/channels`) supplies the channel list; balances/status are read live from `AntseedChannels` via wagmi, using the contract address served by `/api/deposits/config` (`emissionsCfg.channelsContractAddress`, resolved live via `@antseed/node`) — **not** a value hardcoded in the component, because `AntseedChannels` is the one swappable contract in the protocol and does get redeployed (see `CLAUDE.md` in the main AntSeed monorepo). |
| lANTS (`/lants`) | lANTS NFT positions, floor per ANT, listings/offers | `/api/lants-market` | Merges Antscan/on-chain position metadata with antseed-zh's own Seaport order book (`lants_listings`/`lants_offers` tables) and a best-effort OpenSea scrape; floor per ANT = cheapest live listing price ÷ ANTS locked in that NFT, never an assumed token price. Listing/buying/cancelling/offering/accepting all send real Seaport orders directly from the browser; split/merge/move (Mine sub-tab) send direct `AntseedSellerPools` transactions instead — none of the six actions need an OpenSea API or key. See `docs/ARCHITECTURE.md`'s "lANTS Marketplace" section for the full mechanics, including exactly which positions are eligible to merge/move and why. |
| Stakers (`/stakers`) | Staker address, amount staked, lock length | `/api/stakers` | Same underlying positions as lANTS above, grouped server-side by staker address + identical lock length instead of shown NFT-by-NFT; reads a local `stake_positions` table synced every 5 minutes (not a live call per request — see `docs/ARCHITECTURE.md`'s "Stakers tab" comparison table). Public, no wallet needed. |

If you're adding a new number to the UI: find which of the three sources
above actually has it, wire a real read, and let it render `—` on failure.
Do not add a formula that turns one real number into an invented one (that
includes multiplying by an assumed price, an assumed uptime, or an assumed
growth rate).

## Tech Stack

- **Frontend**: React 19, Vite 6, plain CSS (design tokens ported from
  antseed.com — see `src/index.css`), Recharts, i18n via `src/i18n/`
  (zh default, en toggle, persisted in `localStorage`)
- **Backend**: Express 5, `better-sqlite3` (WAL mode), CORS
- **Web3**: wagmi v2, viem v2, RainbowKit v2, `@tanstack/react-query` v5
- **On-chain SDK**: `@antseed/node` (live contract reads/writes, chain config resolution)
- **Chain**: Base mainnet only (chain ID 8453)

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Express server port |
| `PROVIDER_BASE_URL` | `http://localhost:8377/v1` | Local antseed node/buyer proxy, used for `/api/provider/models`, `/api/channels`, `/api/buyer-usage` |
| `ADMIN_SYNC_TOKEN` | *(unset)* | Shared-secret required on `x-admin-token` header or `?token=` for `/api/admin/*`. **Unset means those routes only accept genuinely local (loopback) callers** — they fail closed, not open, when no token is configured. |
| `ANTSEED_IDENTITY_HEX` | *(reads `~/.antseed/identity.key`)* | Hex-encoded buyer identity key, used to resolve the buyer's EVM address for deposit/withdraw/channel reads server-side |
| `BUILD_TARGET` | *(unset = `/zh/` build)* | Set to `root` for the dedicated-domain build (`dist-root/`, base path `/`); unset/anything else builds the `/zh/` sub-path build (`dist/`) — see `vite.config.js` |

No `.env` file is required for local development.

## Deployment

Two build targets share one codebase (`vite.config.js`):

- `npm run build` (default) → `dist/`, base path `/zh/` — proxied by nginx at
  `/zh` on the shared box (`rewrite ^/zh(.*)$ $1 break`).
- `BUILD_TARGET=root npm run build` → `dist-root/`, base path `/` — served
  directly at antseed-zh.com.

Both builds point at the same backend (`backend/server.js`, single process,
single port); only the static asset base path differs. `src/api.js` derives
its API base from `import.meta.env.BASE_URL` automatically, so this doesn't
need a separate env var per build.

## Project Structure

```
backend/
  server.js          Express app: all /api/* routes, static serving, admin auth
  database.js         SQLite schema (idempotent migrations via ALTER TABLE)
  sync-official.js    Live DHT snapshot -> sellers/services tables
  antscan.js           Antscan GraphQL client (real settled on-chain data)
  sync-history.js      Antscan sync orchestration -> network_snapshots/buyers_onchain/
                        sellers_onchain/daily_metrics/epoch_metrics tables
  chain-poller.js      Direct Base RPC reads (via @antseed/node) -> chain_metrics
src/
  App.jsx              Root: tab routing, top-level data fetch
  api.js                Thin fetch wrapper for /api/*, base-path-aware
  hooks/useTabRouter.js URL-driven tab state (shareable/bookmarkable links)
  i18n/                 zh/en string tables + useI18n() context
  context/AuthorizedWalletContext.jsx  Operator-wallet gating for buyer actions
  components/          One component per tab/section (see docs/ARCHITECTURE.md
                        for the full data-binding map)
docs/                  Deep-dive architecture, original product spec, and
                        historical planning docs (see below)
notes/                 Forward-looking dev plan + agent workflow notes
```

## Further Reading

- `docs/ARCHITECTURE.md` — full sync lifecycle, every backend endpoint, the
  claim-flow contract calls, and the emission-share formulas in detail.
- `docs/DEMAND.md` — the original functional/product spec (mostly implemented
  at this point; treat it as historical context, not a live backlog).
- `notes/dev-plan.md` — **the live backlog**: known gaps, open questions, and
  what to pick up next.
- `AGENTS.md` — workflow rules for anyone (human or agent) developing here.
