# Plan: "Inference Market" comparison section (AntSeed vs Surplus Intelligence vs Orbio)

Owner decisions locked 2026-09-17:

1. Tab name: **Inference Market / 推理市场**
2. Orbio price: **best available liquidity tier (live `discountBps`) + 5% platform fee**,
   computed from Orbio's own homepage payload — never the hardcoded 37.5%
   marketing number. Tooltip shows available credits at the best tier so
   depth limits are visible.
3. Qualitative comparison stays **objective**: sourced facts only
   ("non-custodial" vs "marketplace-mediated" vs "custodial credits"),
   no "better/worse" framing.

## Structure

New secondary tab `market` (registered in `useTabRouter.js` TAB_PATHS).
Two parts:

### Part 1 — "How they're built" (static, curated, bilingual matrix)

| Dimension | AntSeed | Surplus Intelligence | Orbio |
|---|---|---|---|
| Model | P2P network, buyer connects directly to seller nodes | Centralized exchange/router, one API | Credits-discount relay over OpenRouter |
| Discovery | BitTorrent DHT + signed peer metadata | Central order book / registry | Central catalog (OpenRouter mirror) |
| Transport | E2E-encrypted P2P (TCP/WebRTC) | TLS to their gateway | TLS to their gateway → OpenRouter |
| Settlement | USDC on Base, non-custodial payment channels (ReserveAuth/SpendingAuth), buyer needs no gas | USDC on Base + x402/MPP/fiat rails | Fiat card → prepaid credits |
| Custody | Non-custodial on-chain contracts | Marketplace-mediated on-chain settlement | Custodial credit balance |
| Who sells | Provider nodes with differentiated services | Anyone listing an OpenAI-compatible endpoint | ORBIO holders reselling unused credits |
| Fees | 4% network fee to Protocol Reserve | Fee multiplier 1.0x (per their docs snapshot) | 5% platform fee on discounted price |
| Identity | Wallet = peer id, ERC-8004 registries | Platform accounts + provider verification | Platform accounts |

Facts sourced from: this repo / antseed.com docs (AntSeed),
surplusintelligence.ai/docs (Surplus), orbio.so (Orbio).

### Part 2 — Live metrics

Backend `GET /api/marketplace-compare` (pattern copied from
`/api/reference-prices`: in-memory cache, 6h TTL, in-flight dedup,
serve-stale-on-failure, `—` on total failure):

- **AntSeed**: local DB — services listed, distinct canonical models,
  active sellers, min/max price.
- **Surplus**: `api.surplusintelligence.ai/v1/models` → model count,
  per-1M pricing (prompt/completion × 1e6).
- **Orbio**: `api.orbio.so/api/v1/models` → catalog count, list prices;
  homepage payload → liquidity book best `discountBps` + tier credits →
  effective price = list × (1 − bps/10000) × 1.05. Parse failure → list
  price with "discount unavailable" flag.

UI:

- Headline cards: model counts per marketplace + current Orbio discount
  tier/depth.
- Shared-models price table (intersection via `canonicalModelKey`, top
  models by AntSeed seller count): cheapest AntSeed, OpenRouter
  reference, Surplus, Orbio effective — existing 1:3 blend, `—` where
  absent, highlight cheapest source.
- Methodology footnote with sources + fetchedAt.

## Files

- `backend/server.js` — `/api/marketplace-compare` + fetchers
- `src/components/MarketplaceCompare.jsx` (new)
- `src/api.js` — `fetchMarketplaceCompare()`
- `src/App.jsx`, `src/hooks/useTabRouter.js` — tab registration
- `src/i18n/en.js` + `src/i18n/zh.js` — ~40 keys, zh default
- `README.md` data-sources table, `notes/dev-plan.md`

## Verification

- `node --check backend/server.js`; curl the new endpoint
- Spot-check 3 shared models against the three live sites
- Both builds: `npm run build` **and** `BUILD_TARGET=root npm run build`
- Browser check at `5.223.54.56:8088/zh/` and antseed-zh.com
