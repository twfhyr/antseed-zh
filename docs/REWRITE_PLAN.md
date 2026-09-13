# antseed-zh Rewrite Plan — AntSeed Network Dashboard v2

Status: **DRAFT — awaiting review, no implementation yet**

Scope decided with the user:
- Data dashboard only (no marketing homepage, no docs/blog port)
- Bilingual UI: zh/en toggle
- Keep current stack: Vite + React (frontend), Express + better-sqlite3 (backend)
- Fix backend data-accuracy issues as part of the rewrite (no fake heuristics)
- **Curation over completeness**: the site does not try to expose every field
  available in the network-stats payload or on-chain. It features a small set
  of important protocol metrics — network overview, buyers, sellers, and the
  full service/model catalog — and nothing else competes for attention on the
  main surfaces. Secondary/raw fields (e.g. `currentLoad` per service,
  `ghostCount`, per-epoch minutiae) live in expandable detail rows or a
  secondary "Advanced" panel, not the primary cards/tables.

---

## 1. Why rewrite (problems in the current antseed-zh app)

Frontend (`src/`):
- Custom, ad-hoc CSS (`index.css`, 758 lines) with no relation to antseed.com's
  actual design tokens — different colors, fonts, radii, spacing. Looks like a
  generic crypto dashboard, not an AntSeed surface.
- Tab-based SPA (`welcome / claim / channels / sellers / services / ants`) —
  usable but not information-hierarchy-driven; no responsive/mobile pass.
- English-only; no i18n.

Backend (`backend/`):
- `sync-official.js` fabricates numbers instead of using real ones:
  - `totalEarnedUSDC` per seller = `settlementCount * 0.5 + totalRequests *
    0.001` — a made-up formula, not real settled volume.
  - `stats.total_volume` = `totalRequests * 0.1` — another made-up
    heuristic, not the real on-chain `totalVolumeUsdc`.
  - `uptime` hardcoded to `99.5` for every seller.
  - `joined` date is always "today" (sync time), not real registration time.
- Two disjoint data sources are half-wired together: `network.antseed.com
  /stats` (peer/service list, no real volume) vs on-chain reads in
  `chain-poller.js` / `emissions.ts`-style RPC calls (real volume, real
  epoch/emission data) — but the SPA mixes both inconsistently across tabs.
- `/api/admin/sync` and `/api/admin/force-chain-sync` are open with no auth.
- No real `AntseedStats`/`AntseedChannels` on-chain aggregate reads for
  network-wide settled volume — antseed.com's own `useNetworkStats.ts` sources
  this from Antscan's GraphQL (`antscan.co/graphql`, `networkSnapshot` query:
  `totalVolumeUsdc`, `totalInputTokens`, `totalOutputTokens`, `sellerCount`),
  which is the correct real source and currently unused by antseed-zh.

## 2. Reference material (already fetched to this server)

- `apps/website/src/css/custom.css` — canonical design tokens (colors, type,
  radii, motion) — "every color on the site MUST come from here."
- `apps/website/src/lib/useNetworkStats.ts` — correct pattern for real,
  cached network stats (Antscan GraphQL, sessionStorage cache, graceful
  fallback).
- `apps/website/src/pages/network.tsx` — antseed.com's own network page is
  just a redirect to `antseedstats.com/network` (a separate explorer app it
  does not embed) — confirms there's no existing "official" dashboard UI to
  copy 1:1; we design our own dashboard using antseed.com's *design system*,
  not a literal page clone.
  network browsing.
- `docs/protocol/*.md` (payments, reputation, recognized-usage,
  legacy-emissions, discovery) — ground truth for what each number *means*
  (ReserveAuth/SpendingAuth cycle, `AntseedChannels` reputation counters,
  ANTS emission buckets) so labels/tooltips are accurate.
- `network.antseed.com/stats` JSON — real shape confirmed: `peers[]` (each
  with `providers[].services`, `defaultPricing`, `servicePricing`,
  `serviceCategories`, `maxConcurrency`, `currentLoad`), `totals`
  (`totalRequests`, `totalInputTokens`, `totalOutputTokens`,
  `settlementCount`, `sellerCount`, `lastUpdatedAt`). No per-seller volume —
  confirms per-seller "earned" must either be dropped or sourced on-chain
  per seller (agentId), not fabricated.
- `apps/ants/src/service/*` — real patterns for epoch/rewards/pool-merge
  logic already implemented correctly in the monorepo (reuse logic/shape
  instead of reinventing).

## 3. New Information Architecture

Single-page app, sidebar or top-tab navigation (styled per antseed.com
tokens), zh/en toggle in the header (persisted in localStorage).

**Four primary sections carry the site.** Each gets one focused view with a
handful of headline metrics up top and one well-designed table below —
deliberately not a "show every column we have" dump:

1. **Protocol Overview** (landing view) — a small set of headline numbers
   that answer "how big/healthy is the network right now": total settled
   volume (USDC), total tokens processed (input+output), active sellers,
   active buyers, settlements per epoch. Sourced the same way antseed.com
   does (Antscan GraphQL `networkSnapshot`) — replaces the fake `stats`
   table math. This is the only place with animated `CountUp` hero numbers;
   everything else is quieter.
2. **Buyers** — network-wide buyer activity: count of active buyers,
   aggregate spend/usage where derivable from real data (buyer-side
   `AntseedStats`/channel counters), not per-wallet surveillance beyond
   what's already on-chain and public. Currently the weakest-covered area
   in the old app (`totalBuyers` was always `0`/unused) — this rewrite
   gives it a real, equal-weight section instead of an afterthought.
3. **Sellers** — live peer list from `/stats`: name/peerId, model count,
   categories, capacity, and (labeled separately) real on-chain reputation
   counters (`channelCount`, `totalVolumeUsdc`) where an agentId can be
   resolved. No fabricated `total_earned`/`uptime`. One primary table,
   sortable by the 3-4 metrics that matter (models offered, volume,
   activity) — not every raw field from the payload.
4. **Services** — the full model/service catalog: name, provider,
   input/output/cached pricing, categories, protocols. This is the one
   place where "complete" is the right call (it's a catalog buyers actually
   search), but still presented as a clean searchable/filterable table, not
   a raw JSON dump — `currentLoad`/`maxConcurrency` demoted to an expandable
   row detail rather than a default column.

Secondary sections (present, but visually de-emphasized relative to the four
above — smaller nav weight, no hero stat cards):

5. **$ANTS Token** — epoch clock, emission ceilings by bucket, supply —
   reuses `apps/ants/src/service/emissions.ts` / `chain-poller.js` logic
   (real on-chain reads), not hardcoded numbers.
6. **Claim ANTS** (wallet-gated) — five reward buckets — keep existing
   working logic from `ClaimANTS.jsx` / `/api/rewards` (already correct per
   `MEMORY.md`), restyle only.
7. **Payment Channels** (wallet-gated) — keep `ChannelsView.jsx` logic,
   restyle.
8. **This Node** — small footer/about panel for the operator's own seller
   node (peer 0x412282c4…, agentId 47218) + Telegram link.

Dropped from current app: no changes to wallet/deposit/withdraw logic
(already functional) — only visual + i18n layer added. Also dropped: the
old flat "Home/Welcome" tab is replaced by Protocol Overview as the true
landing view.

## 4. Design System Adoption

- Import antseed.com's actual CSS custom properties (`--as-*` tokens) instead
  of ad-hoc colors — either copy the `:root` token block verbatim (with
  attribution comment) or install `@fontsource-variable/geist` +
  `@fontsource-variable/geist-mono` as antseed.com does, and mirror the
  primary/gray/void/clay/risk ramps.
  - Primary emerald `#10B981`, ink `#001E12`, clay `#D79627` (ANTS/USDC
    economics only), risk red (errors only), void dark-green sections.
- Typography: General Sans / Geist Variable for UI, Geist Mono for
  numbers/data (stat cards, addresses, token amounts) — matches
  antseed.com's `--as-font-data` convention for exactly this kind of dashboard
  content.
- Radii/motion: 16px cards, pill buttons, `cubic-bezier(0.65,0,0.35,1)`
  easing for the same "AntSeed" feel as antseed.com transitions.
- Components to rebuild in this system: stat cards (`CountUp`-style animated
  numbers like antseed.com's homepage), tab/nav bar, tables (sellers,
  services, channels), modals (deposit/withdraw), badges (LIVE, on-chain vs
  cached).

## 5. i18n (zh/en toggle)

- Add `src/i18n/` with `en.json` / `zh.json` string tables + a small
  `useI18n()` hook (React context), no heavy i18n library needed for a
  single-page dashboard.
- Persist choice in `localStorage`; default to `zh` (audience is antseed_zh)
  with `en` toggle in header, mirroring antseed.com's own simplicity (no
  server-side i18n routing needed since this isn't SEO content).
- Numbers/addresses/token symbols stay locale-invariant; only labels,
  tooltips, and descriptive copy get translated.

## 6. Backend fixes (data accuracy)

- `sync-official.js`:
  - Remove the fabricated `totalEarnedUSDC` formula and `uptime: 99.5`
    per-seller stat entirely, OR replace with real on-chain reads
    (`AntseedChannels` reputation counters via `agentIdOf`) where the peer's
    EVM address/agentId can be resolved — otherwise omit the field and let
    the UI show "on-chain data unavailable" rather than a fake number.
  - Remove the `total_volume = totalRequests * 0.1` heuristic; replace
    `stats.total_volume` with the real `totalVolumeUsdc` from Antscan
    GraphQL (same source/query as antseed.com's `useNetworkStats.ts`),
    cached with the same TTL pattern (10 min) server-side so the frontend
    doesn't need CORS calls to Antscan directly (Express proxy endpoint,
    e.g. `GET /api/network-overview`).
  - Keep `joined` field only if backed by real first-seen tracking (store
    first-seen timestamp in SQLite per peerId across syncs) instead of
    "today" every sync.
- Add basic auth/token gate (env-var shared secret) on `/api/admin/sync` and
  `/api/admin/force-chain-sync` — currently open to anyone.
- Document clearly (README/ARCHITECTURE) which fields are real on-chain data,
  which are live DHT/off-chain data, and which (if any) remain estimates —
  no silent heuristics.

## 7. Deployment (unchanged infra)

- Same nginx setup: `/etc/nginx/sites-available/ants-dashboard`, `location
  /zh` proxied to `127.0.0.1:3001`, `rewrite ^/zh(.*)$ $1 break`. Vite
  `base: '/zh/'` and frontend `API_BASE = '/zh/api'` must remain (per
  MEMORY.md's three-part fix) so this doesn't regress.
- Same run command: `npm run build && nohup node backend/server.js`.
- No new ports; no ufw changes needed.

## 8. Work Breakdown (implementation phases, for after approval)

1. **Design tokens + i18n scaffold** — port `--as-*` CSS vars, fonts,
   `useI18n()` hook, string tables (en/zh skeleton with placeholder copy).
2. **Backend data-accuracy pass** — fix `sync-official.js` heuristics, add
   `first_seen` tracking migration-equivalent (SQLite `ALTER TABLE` since
   this isn't the monorepo's migration framework), add
   `/api/network-overview` Antscan-proxy endpoint with server-side cache,
   add admin-endpoint auth gate.
3. **Component rebuild** — Header/nav, Overview stat cards (animated
   CountUp — Overview only), Buyers section (new — needs a real data source,
   see below), Sellers table, Services table (searchable/filterable, catalog
   completeness only here), restyle existing Claim/Channels/Deposit/Withdraw
   modals to new tokens (logic untouched, visually secondary to the four
   primary sections).
   - **Buyers data source to confirm during implementation**: `totals`
     from `network.antseed.com/stats` doesn't currently expose a reliable
     buyer count/activity figure end-to-end; likely source is
     `AntseedStats`/`AntseedUsageAccounting` on-chain reads (buyer-side
     counters) similar to how `apps/ants` resolves seller-side usage. Will
     verify exact contract read path before wiring the UI so this section
     isn't built on a placeholder.
4. **i18n content pass** — fill in full zh/en copy for every label/tooltip.
5. **QA** — verify `/zh/` deployment end-to-end (nginx base path, API
   base path, CORS), mobile responsive check, verify all "real" numbers
   against `network.antseed.com/stats` + Antscan directly.
6. **Docs** — update `docs/README.md` / `ARCHITECTURE.md` in antseed-zh to
   reflect the new data-accuracy guarantees and i18n structure.

## 9. Explicit non-goals

- No marketing/landing content, no docs/blog port, no Docusaurus migration.
- No changes to on-chain contracts, wallet/payment logic, or reward-claim
  logic — only presentation, i18n, and off-chain data-accuracy fixes.
- No new backend framework/database — stays Express + better-sqlite3.

---

**Next step:** on approval, I'll open a branch in `antseed-zh`, implement
phase 1-2 first (tokens/i18n scaffold + backend fixes), then iterate through
the remaining phases, checking in after each phase rather than shipping the
whole rewrite in one shot.
