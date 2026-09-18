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
  |-- syncs from --> http://localhost:8377/_antseed/peers  (LOCAL buyer node, live DHT view)
  |     fallback  --> https://network.antseed.com/stats    (hosted snapshot; lags, see below)
  |-- syncs from --> https://antscan.co/graphql            (real settled on-chain totals)
  |-- reads from  --> Base mainnet RPC via @antseed/node   (ANTS supply, epochs, rewards)
```

Four data sources feed the dashboard, each read by a dedicated
backend module, each cached in SQLite so the frontend never makes a raw RPC
or GraphQL call itself:

| Source | Module | What it's good for | What it can't tell you |
|---|---|---|---|
| **Local buyer node** `/_antseed/peers` (primary) | `backend/sync-local-buyer.js` -> `backend/sync-official.js` | The live peer/provider/service catalog: names, pricing, categories, protocols, per-service capabilities. Served from the buyer's own DHT cache — no seller is contacted | `onChainStats` / `verifications` / network-wide `totals` — it only knows what peers advertise over DHT |
| `network.antseed.com/stats` (fallback only) | `backend/sync-official.js` | Same catalog shape, plus `onChainStats` and network-wide `totals` | **Staleness**: measured 176 min behind while the local node was 70 min, and 400 services vs 412. Used only when no buyer node answers |
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
| Sellers | Peer list, model count, categories | `/api/sellers` | Local buyer node's live DHT view (`/_antseed/peers`), rebuilt on every sync cycle; hosted snapshot only as fallback. `/api/catalog-source` reports which one answered. |
| Sellers | Total earned (USDC) | `/api/sellers` | Matched by `agentId` to Antscan's real `earnedUsdc` per seller. `null` ("—") when no agentId can be resolved for that peer — **never** a `settlementCount * 0.5`-style estimate (that formula existed in an earlier version and was removed; see `backend/sync-official.js` comments). |
| Sellers | Uptime | — | Not shown. There is no real per-peer uptime signal in either data source; a prior version hardcoded `99.5` for every row, which was deleted rather than replaced with another guess. |
| Services | Pricing, categories, protocols, load | `/api/services` | Verbatim from the live DHT snapshot's per-provider `servicePricing`/`serviceCategories`/`currentLoad`, deduplicated globally by `(service, provider, seller)` since the same provider can list a service more than once in real peer metadata. |
| Services (By model) | Cheapest sellers per model | `/api/services` | Same rows as the flat catalog, grouped by canonical model identity (`src/lib/modelTaxonomy.js`) because sellers spell one model several ways (`claude-opus-4-8` vs `claude-opus-4.8`); grouping on the raw string produced several rows each naming a different "cheapest" seller. Ranked by a 3:1 output-weighted blend of the seller's own input/output prices — a sort key only; displayed prices are the real unblended figures. Sellers missing either price are excluded, never defaulted to 0. |
| Services (By model) | "OpenRouter list" price + "Discount" % | `/api/reference-prices` → `openrouter.ai/api/v1/models` | Live public list price for the same model, fetched server-side and cached 6h (stale copy served if upstream fails; `{}` → UI renders `—`). Matched to AntSeed models by the same canonical key; `:batch`/`:free` tier ids and zero/non-numeric prices are skipped so a discount tier can't masquerade as the standard rate. `Discount` = seller blend ÷ reference blend − 1, same 3:1 weighting on both sides, shown in **both** directions (some sellers are more expensive). **This is a marketplace reference rate, not the model vendor's official price**, and a same-named model is not a verified-identical service — currently ~116 of 233 models match; the rest render `—`. |
| Overview (Epoch) | "Epoch ends in" countdown | `/api/stats` (`currentEpoch.endTs`) | Wall-clock time against the epoch's real end timestamp (epoch start + on-chain epoch duration), re-evaluated every second — not a locally decremented timer, so it can't drift or resume from a stale value after the tab sleeps. `—` if `endTs` is missing; "Ending…" once elapsed. |
| Buyers | Address, spend, requests, unique sellers | `/api/history/buyers` | Antscan's real `buyers` entity, paginated and cached in `buyers_onchain`. |
| $ANTS Info / Tokenomics | Supply, epoch, emission rate, halving | `/api/chain-stats`, `/api/tokenomics` | Live reads via `@antseed/node` (`ANTSTokenClient.totalSupply/maxSupply`, `EmissionsGateClient.currentEpoch/genesis/halvingInterval`), refreshed by `chain-poller.js` every 5 minutes and cached in `chain_metrics`. |
| $ANTS Info / Tokenomics | Allocation ceilings (40/20/15/15/10%) | `/api/chain-stats` `allocation` | Read live from `EmissionsGateClient.minter()` per bucket, **not** a hardcoded percentage — these are mutable on-chain via `setShares`. |
| $ANTS Info / Tokenomics | Dynamic staker/usage share | `/api/tokenomics` | `share = minimum + (maximum − minimum) × input / (input + target)`, computed server-side from live `totalActiveStake` / recognized USDC volume against the on-chain target parameters — see `docs/ARCHITECTURE.md` for the full formula and inputs. |
| Claim ANTS | Five reward buckets (staker / seller usage / buyer usage / legacy / locked) | `/api/rewards?address=` | Each bucket is a direct read against its own contract (`SellerPoolsRewards`, `UsageAccounting`/`UsageRewards`, legacy `Emissions` V1/V2, `SellerRewardsPool`) — no aggregation or estimation. Claims are sent directly from the browser via wagmi; the backend never proxies or signs a transaction. |
| Payment Channels | Channel list, reserved/used/status | `/api/channels` + on-chain `channels()` read | The buyer proxy (`_antseed/channels`) supplies the channel list; balances/status are read live from `AntseedChannels` via wagmi, using the contract address served by `/api/deposits/config` (`emissionsCfg.channelsContractAddress`, resolved live via `@antseed/node`) — **not** a value hardcoded in the component, because `AntseedChannels` is the one swappable contract in the protocol and does get redeployed (see `CLAUDE.md` in the main AntSeed monorepo). |
| Inference Market | AntSeed seller/model/listing counts | `/api/marketplace-compare` | Aggregates over the live local `services` table (same rows as the Services tab), grouped by `canonicalModelKey`. |
| Inference Market | Surplus Intelligence model count + prices | `/api/marketplace-compare` → `api.surplusintelligence.ai/v1/models` | Public unauthenticated catalog; per-token `pricing.prompt/completion` × 1e6 → per-1M. Zero/non-numeric prices skipped. |
| Inference Market | Orbio catalog prices + effective discount | `/api/marketplace-compare` → `api.orbio.so/api/v1/models` + `orbio.so` homepage | Orbio's API prices are **list prices** (verified to match its homepage "before" figures). The effective price applies the **best live credit tier** from the liquidity book embedded in the homepage's Next.js payload (`discountBps`/`microUsd` tiers) plus Orbio's 5% platform fee: `list × (1 − bps/10000) × 1.05`. If the book can't be parsed, `discount: null` and the UI shows the undiscounted list price, labeled — the "37.5%" marketing headline is never hardcoded. |
| Inference Market | Shared-models price table | `/api/marketplace-compare` + `/api/reference-prices` + `/api/services` | Top AntSeed models (by seller count) also listed on at least one other source, matched by `canonicalModelKey`. All prices shown as the same 3:1 output:input blend per 1M tokens; cheapest source per row highlighted; `—` where a source has no real number. Cached 6h server-side, stale copy served on upstream failure. |

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
