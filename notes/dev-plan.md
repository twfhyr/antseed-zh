# Dev Plan — Live Backlog

Last reviewed: 2026-09-17. Keep this current — mark items done and remove
them (git history is the record of what was done and when; this file is
only for what's still open).

## Recently fixed (2026-09-17 session)

- New **"Inference Market"** tab (`/market`, `MarketplaceCompare.jsx` +
  `/api/marketplace-compare`) comparing AntSeed with Surplus Intelligence
  and Orbio (orbio.so — note: NOT orbio.io, which is a parked domain).
  Two parts: a static, sourced mechanism matrix (architecture, discovery,
  transport, settlement, custody, sellers, fees, identity — objective
  facts only, no better/worse framing, per the owner) and live metrics
  (per-marketplace catalog stats + a shared-models price table, 3:1
  blended, cheapest source highlighted). Orbio effective price = its API
  list price × (1 − best live `discountBps` tier from the liquidity book
  embedded in its homepage) × 1.05 platform fee; the 37.5% marketing
  figure is never hardcoded, and a parse failure falls back to the
  undiscounted list price, labeled. Plan: `notes/plans/marketplace-compare.md`.
  Caveat for future edits: the Orbio discount parse is regex-over-Next.js-
  payload — brittle by nature; treat `discount: null` as the normal
  failure mode, not a bug.
- Services tab gained a **"By model — cheapest first"** view (now the
  default; the flat catalog is the second toggle). Groups the same
  `/api/services` rows by model name and shows the 5 cheapest sellers per
  model, ranked by a 3:1 output:input weighted blended price — a sort key
  only, the table always shows the real unblended input/output figures, and
  services missing either price are excluded rather than defaulted to zero.
  Deliberately a view inside Services, not its own nav tab (same dataset,
  different grouping — see "curation over completeness").
- That view now groups by **canonical model identity**, not raw name
  (`canonicalKey()` in `src/lib/modelTaxonomy.js`). Sellers spell the same
  model differently, so grouping on the raw string was splitting one model
  into several rows — `claude-opus-4.8` was **4 rows, 3 of which named the
  wrong cheapest seller**, because each row only ranked the sellers who used
  that exact spelling. Now one row per model with a **"Provider's model
  name"** column showing the exact string each seller advertises (the one
  you pass as the model id), a badge when a model has multiple spellings,
  and search that matches either the canonical label or any seller's
  spelling. Only formatting is merged (separators, org prefixes, release
  datestamps); `-fast`/`-mini`/`-pro`/`-edit` variants stay distinct — there
  is a regression guard list for this in the canonicalization tests, since
  over-merging would put two different products in one price comparison.
  Also dedupes a seller that lists one model under several aliases so it
  can't take multiple slots in a top-5 of sellers. 398 raw names → 235
  models.
- **Catalog source switched from the hosted snapshot to the LOCAL buyer node.**
  Per the founder, `network.antseed.com/stats` is outdated and clients should
  read their own buyer node. Measured here: `/stats` 176 min stale vs local
  70 min; 400 vs 412 advertised services; same 53 peers. New primary source is
  `GET /_antseed/peers` on the buyer proxy (`backend/sync-local-buyer.js`),
  which the node answers from its own DHT cache without contacting a seller.
  `/stats` → on-disk cache remain as ordered fallbacks; `/api/catalog-source`
  reports which one actually answered plus how old the observations were.
  Live result: 956 service rows / 263 canonical models (was 911 / 255).
  Non-obvious things that had to be handled — do not "simplify" these away:
  - **Shape differs.** `/stats` nests `providers[{provider, services[],
    servicePricing{}, …}]`; the local node returns `providers: ["openai"]`
    plus parallel `providerPricing` / `providerServiceCategories` /
    `providerServiceApiProtocols` maps. `sync-local-buyer.js` normalizes the
    local shape into the `/stats` shape so the DB write path is untouched.
  - **7 of 53 peers publish an empty `providers[]`** while still advertising
    priced services, so provider names must be the UNION of `providers[]` and
    the `providerPricing` keys. Trusting `providers[]` alone dropped 6 peers'
    entire catalogs.
  - **The local node has no `onChainStats`/`verifications`.** Switching source
    silently zeroed `agent_id`, `total_earned`, `total_requests`,
    `first_seen_at` for all 53 sellers. Fixed by joining `sellers_onchain` on
    **address** (a peerId IS the seller's EVM address) — restores 52/53. It is
    keyed by address, not agentId, precisely so this works without the indexer.
  - **`totals` is indexer-only**, so `totals.settlementCount || 0` overwrote
    `active_transactions` with 0 (COALESCE can't rescue it — 0 isn't null).
    Now passes null to preserve the last real value.
  - **`maxConcurrency || 10` was fabricating capacity** for every service;
    now `?? null` so the UI shows "—".
  - Buyer base URL: honours `BUYER_BASE_URL`/`PROVIDER_BASE_URL` if set,
    otherwise probes 8377 then 8378 (this server runs 8378; defaulting to
    8377 alone would have silently fallen back to the stale snapshot).
- **Model identity now comes from the protocol SDK, not a local heuristic.**
  Where the names come from: `network.antseed.com/stats` →
  `peers[].providers[].services[]` → `backend/sync-official.js` inserts each
  string **verbatim** → `/api/services`. There is no normalization in that
  path, and the payload really is unnormalized — live check found 6 spellings
  of Opus 4.8 (`claude-opus-4-8`, `claude-opus-4.8`, `opus-4.8`, `opus-4-8`,
  …), with one seller publishing three of them at once. The buyer node's
  normalization is real but happens at *request routing* time, not in the
  discovery payload this site reads.
  So the dashboard must canonicalize for display — but it now does so with
  `canonicalModelKey()` / `preferredModelDisplayName()` from `@antseed/node`
  (already a dependency; computed in `parseService()` and exposed as
  `canonicalKey` / `displayName` per row), i.e. the same functions routing
  uses. The local `canonicalKey()`/`pickCanonicalLabel()` in
  `src/lib/modelTaxonomy.js` were **deleted**: compared on live data they
  disagreed on 42 pairs, always by over-merging things the protocol keeps
  distinct (`deepseek-v4-flash` vs `-0731`, `e2ee-` TEE builds — different
  prices, different products). `name` is still the seller's exact advertised
  string, since that is the routing id a buyer passes. Don't reintroduce a
  local canonicalizer; fix `packages/node/src/model-identity.ts` instead.
  Live: 911 rows → 255 models; `-fast` stays separate; OpenRouter reference
  match 117/255. NOTE `/api/reference-prices` caches 6h, so after changing
  its shape you must restart the backend or the old cache serves rows
  missing the new field (this briefly showed 0% match).
- About gained a **"What's New"** changelog section (`src/data/changelog.js`,
  rendered last in About, i18n'd in both locales). Scope is *this dashboard*,
  not the protocol — protocol behavior belongs in the Protocol tab. Entry
  dates were taken from the commit that shipped each change
  (`git log --date=short`), not from memory; when adding entries, do the
  same rather than rounding to a plausible-looking date. Entries are written
  for a visitor (what changed and why it matters), not as commit subjects.
- Overview > Epoch tab gained an **"Epoch ends in"** countdown card, ticking
  once a second (`5h 1m 46s`, switching to `2d 3h 40m` when over a day out)
  with the absolute end time underneath. Driven by wall-clock time against
  the epoch's real `endTs` from `/api/stats` (epoch start + on-chain epoch
  duration; cross-checked against genesis + `epochDuration` from
  `/api/emissions/epoch-info` — they agree exactly). Not a locally
  decremented counter, which would drift and would resume from a stale value
  after the tab sleeps. Missing `endTs` renders `—` and an elapsed epoch
  renders "Ending…", never a fabricated or negative time.
- Price columns in that view condensed to one **Input / Output** cell, plus
  a **OpenRouter list** reference price and a **vs list** delta, backed by a
  new cached `GET /api/reference-prices` (6h TTL, stale-on-error, proxies
  `openrouter.ai/api/v1/models` — public, no API key). Sellers only publish
  their own price, so a comparison needs an outside rate; nothing is
  hardcoded and a failed fetch renders `—` rather than a stale guess.
  Deliberate calls, don't "fix" these without reading first:
  - It is labelled **OpenRouter list price, not "official vendor price"** —
    OpenRouter is itself a marketplace. Calling it official would be a claim
    we can't back.
  - **Both directions are shown as-is.** 17 models are *more expensive* than
    the list rate and ~34 show ≥90% off. Hiding either would flatter AntSeed
    by cherry-picking. The footnote states plainly that a huge discount is
    the seller's own published price, not a verified-identical service.
  - `:batch`/`:free` tier ids are skipped, so a discount tier can't be
    mistaken for the standard rate.
  - Coverage is ~116/233 models; the rest render `—`.
- Two-level **company → model filter** for that view
  (`src/lib/modelTaxonomy.js`): pick "OpenAI", then narrow to "GPT-5.6".
  ~400 raw model names are unusable as a flat filter list. The taxonomy is
  pattern-matched because sellers don't normalize names (`gpt-5.2`,
  `gpt-52`, `openai-gpt-52` are all live), and is used **only** to decide
  which rows are visible under a chip — it never merges price rows, alters
  a displayed number, or invents a model no seller listed. Unrecognized
  names fall to "Other" (16 of 398, all genuinely one-off services) rather
  than being guessed into a brand. Verified against live data, including
  that date-stamped names like `claude-sonnet-4-20250514` read as v4, not
  v4.2.
- Protocol tab: added an AntSeed vs Venice vs Orbio comparison table with
  a sourced footnote (sources + check date named; no ORBIO price/market-cap
  figures baked in, since those move constantly).

## Recently fixed (2026-09-16 session)

- Added a new **Protocol** tab (`src/components/Protocol.jsx`) — a single
  focused page: a short ant-colony-framed intro plus one animated diagram
  of the whole request workflow (`src/components/ProtocolAnimation.jsx`).
  Discovery/request/response/payment/reputation each get their own step;
  request and response travel on two visually distinct lanes (own color,
  own arrowhead) instead of one path reused both directions; Buyer/Seller
  are hand-built SVG ants, the DHT a small mound, and a settled USDC
  payment travels as a seed instead of a plain dot. Plain SVG/CSS/SMIL —
  no image asset, no new dependency. (This went through a Mermaid-diagrams
  version first — see `docs/PROTOCOL_SECTION_PLAN.md` for that original
  plan — before becoming the single animation described here; `mermaid`
  was added then removed again, so it's not a dependency of this repo.)
- Merged `TokenomicsTab.jsx` + `ANTSInfo.jsx` into
  `src/components/AntsTokenomics.jsx` — one "ANTS & Tokenomics" nav item
  with two sub-tabs (Supply & Allocation / Rewards & How It Works),
  closing the overlap this file used to flag below. `ANTSInfo`'s own
  supply/epoch stat cards and flat allocation list were dropped (fully
  redundant with the pies `TokenomicsTab` already had); its unique content
  (contract list, dynamic-share explainer, the four "how rewards are
  earned" blocks, "how to earn" cards) survived and got full `en.js`/
  `zh.js` i18n treatment for the first time. `/tokenomics` and `/ants-info`
  both still resolve (no dead links), defaulting to the Supply and Rewards
  sub-tab respectively.

## Recently fixed (2026-09-15 session)

Context for whoever picks this up next — these are done, not open items,
listed so the reasoning doesn't get lost:

- Removed `src/data/mockData.js` (fully unused — the fabricated
  buyers/sellers/services/stats it held were never imported anywhere) and
  `reset_db.cjs` (a one-off migration script hardcoding a path from a
  different project directory — `/home/ubuntu/antseed/opencode/...` — and
  superseded by the idempotent `ALTER TABLE` migrations already in
  `backend/database.js`/`backend/chain-poller.js`).
- Removed three orphaned `src/api.js` wrapper functions with zero callers
  anywhere in `src/` (`fetchComputedStats`, `fetchNetworkStats`,
  `fetchHistoryOverview`). The corresponding backend routes
  (`/api/computed-stats`, `/api/network-stats`, `/api/history/overview`)
  were **not** touched — see "Orphaned backend endpoints" below.
- **Fixed a real accuracy bug**: `ChannelsView.jsx` hardcoded
  `CHANNELS_ADDRESS = '0x4d9bB6e20A0a2842CB1C4C22c4b3bEB2f03776E9'`, which
  does not match the live `AntseedChannels` address
  (`0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d`, confirmed via
  `resolveChainConfig('base-mainnet')` and matching `docs/ARCHITECTURE.md`'s
  contract table). `AntseedChannels` is the one swappable contract in the
  protocol (see the main AntSeed monorepo's `CLAUDE.md`) — it gets
  redeployed by re-pointing the stable contracts, which is almost certainly
  what happened here. Fixed by fetching the address live from
  `/api/deposits/config` instead of hardcoding it. **`DepositModal.jsx` and
  `WithdrawModal.jsx` still hardcode `DEPOSITS_ADDRESS`/`USDC_ADDRESS`** —
  currently correct (verified against the same live config), but the same
  failure mode is latent there. Worth the same fix next time either file is
  touched.
- Re-wired `ClaimANTS.jsx`, `ChannelsView.jsx`, and `ANTSInfo.jsx` as nav
  tabs in `App.jsx` (they were fully built but unreachable — no tab
  rendered them, a regression from the dashboard rewrite that dropped the
  wallet-gated tabs without removing the components), plus a header
  `<ConnectButton>`. **Reversed later the same day** (see the epoch-features
  round below): Claim ANTS / Channels and the connect button were hidden
  again — wallet-adjacent UI is sensitive to surface by default on a
  public dashboard. `ANTSInfo.jsx` (no wallet needed) stayed. Registered
  the new tab paths in `src/hooks/useTabRouter.js`'s `TAB_PATHS` when
  adding tabs — a tab in `App.jsx` without a matching entry there silently
  falls back to `overview` on direct navigation/reload; this cuts both
  ways when removing a tab too, remember to remove the entry there as well
  (done for `claim`/`channels`).

### Epoch-features round (same day, follow-up review)

- Overview's Epoch/Total distinction was unclear when both stat-card rows
  rendered stacked at once. Restructured to match the Buyers/Sellers
  pattern: two top-level tabs (Epoch #N first, Total second), each
  rendering its own stat cards + chart, not both simultaneously.
- Clarified what the "epoch" chart view actually means: **not** an
  all-epochs aggregate (bars per epoch, 0 through current) — that stayed
  under Total as `HistoryCharts.jsx`'s existing "By Epoch" toggle, label
  reverted to static. The Overview Epoch tab instead gets a new
  `EpochDailyChart.jsx`: a day-by-day breakdown filtered to just the
  current epoch's ~7-day window (`[startTs, endTs)`, computed
  server-side in `currentEpochOverview()` from the live
  genesis/epochDuration/currentEpoch — added to `/api/stats`
  `currentEpoch.startTs`/`.endTs`), reusing `HistoryCharts.jsx`'s exported
  `BreakdownChart`/`ChartState` instead of duplicating the chart JSX.
- Hid Claim ANTS, Channels, and the header connect button again (see
  above) — components and backend endpoints untouched, same "kept for
  later, not surfaced" pattern `Header.jsx` used before this round
  re-added them.

## Open items

### Verify in a real browser (couldn't be done headlessly this session)

No browser tool was available in any of this day's sessions. Build
succeeded each time, new strings are present in the built bundle, and the
API endpoints involved respond correctly with real data (verified via
curl/node scripts against the live chain and Antscan) — but nobody has
actually clicked through the Overview Epoch/Total tabs, the Buyers/Sellers
Epoch/Total sub-tabs, or `ANTSInfo.jsx` in an actual browser since these
changes landed. Check for:
- Console errors on mount
- Visual fit/spacing of the new tab rows (Overview, Buyers, Sellers) and
  the info-icon tooltips on the new epoch table columns
- Mobile layout for the above (mobile responsive pass was a
  `REWRITE_PLAN.md` action item and its general completion hasn't been
  re-verified since these tabs came back)

### Orphaned backend endpoints

`/api/computed-stats`, `/api/network-stats`, and `/api/history/overview` in
`backend/server.js` have no frontend caller anymore (confirmed via grep
across `src/`). They're not wrong — no fabricated data, just superseded by
`/api/stats` + `/api/chain-stats` + `/api/history/daily`/`/epochs`, which
cover the same ground with real numbers. Left in place this session because
removing backend routes needs confirming nothing external (a script, a
saved bookmark, manual `curl` monitoring) depends on them, which wasn't
verifiable from the code alone. If you're touching `server.js` anyway and
can confirm that, removing them is a straightforward simplification.

### Growth percentages computed but not displayed

`backend/sync-official.js`'s `computeGrowthPct()` computes real
day-over-day growth (`buyer_growth`, `seller_growth`, `volume_growth`,
`transaction_growth`, all real — no fabricated fallback) and `/api/stats`
returns them, but `StatsCards.jsx` (the only consumer of `/api/stats` in the
UI) doesn't render them — a regression from before the rewrite, when the
old `StatsCards.jsx` did show growth rates. Two ways to close this: wire
the numbers back into the UI, or — if growth rates aren't wanted in the
new curated IA — drop the computation and the columns instead of leaving
real-but-invisible numbers around. Needs a product call, not just an
engineering one.

### Re-wired tabs are English-only (no i18n)

`ClaimANTS.jsx` and `ChannelsView.jsx` don't import `useI18n()` at all —
every string in both is hardcoded English. This predates this session (the
i18n pass that added `src/i18n/` apparently covered only the tabs that were
reachable at the time) but is now a real, user-facing gap since these are
reachable tabs again in a zh-default app. Not fixed this session —
translating the mixed prose/labels/error messages accurately needs either a
native reviewer or a dedicated pass, not a rushed mechanical one. Worth
doing as its own piece of work, following the existing `t('namespace.key')`
/ `en.js`+`zh.js` pattern the rest of the app uses. (`ANTSInfo.jsx` used to
be in this same boat — it's been merged into `AntsTokenomics.jsx` and fully
i18n'd, see "Recently fixed" below.)

### Payments P1 items (from `docs/PAYMENTS_DEMAND.md`)

Not built: DIEM Staking Rewards tab (`DiemRewardsTab.jsx`, claim via a DIEM
staking proxy contract), dedicated `WalletDrawer.jsx` slide-out panel. Low
priority unless a user asks for them specifically — confirm the DIEM
staking proxy is still a real, current AntSeed feature before building
against it (this note predates the current session and wasn't
re-verified).

### Bundle size

The production build warns on several chunks over 500kB, and the main
bundle grew to ~1.45MB (gzip ~434kB) after `ClaimANTS`/`ChannelsView`/
`ANTSInfo` were wired back in as always-mounted tabs instead of lazy ones.
Worth revisiting with `React.lazy()` / dynamic `import()` per tab if load
time on a slow connection becomes a real complaint — not urgent for a
dashboard, but noting it since it got measurably worse this session.

## Open questions (no obvious right answer — flag to the user, don't guess)

- Should the admin routes (`/api/admin/sync`, `/api/admin/force-*-sync`)
  have `ADMIN_SYNC_TOKEN` actually set in the production environment right
  now, or are they intentionally relying on the loopback-only fallback?
  Worth a one-time check (`ps`/`systemd` env, not committed anywhere) next
  time someone has shell access to the deployment host.
