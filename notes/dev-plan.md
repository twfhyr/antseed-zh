# Dev Plan — Live Backlog

Last reviewed: 2026-09-20. Keep this current — mark items done and remove
them (git history is the record of what was done and when; this file is
only for what's still open).

## lANTS indexer (new, 2026-09-20 session, not yet integrated or committed)

A previous session scaffolded a Ponder project at `indexer/` (untracked,
`npm install` never run) but a session drop left it as unconfigured
boilerplate (`ExampleContract` on Ethereum mainnet chain id 1, empty RPC
url). This session configured it for real:

- Chain: Base mainnet (8453), RPC is the same public multi-endpoint list
  the antseed monorepo's `chain-config.ts` uses (tenderly primary + drpc/
  nodies/mainnet.base.org fallbacks) — no API key required, set
  `PONDER_RPC_URL_8453` in `indexer/.env.local` to override with a private
  one.
- Indexes `AntseedSellerPools` (the lANTS NFT, `0x8bf4d3...0652`) `Transfer`
  events from its real deploy block (`50955029`, found by binary-searching
  `eth_getCode` against live Base mainnet, not guessed) into a
  `lants_position` table — ground truth for current ownership, meant to
  eventually replace the `latestOwners()` workaround in
  `backend/lants-trades.js` (Antscan's own indexer can lag behind a real
  sale).
- On every non-mint Transfer, also looks up that transaction's receipt and
  decodes any Seaport `OrderFulfilled` log in the same tx (Seaport itself is
  NOT indexed globally — it's a shared contract used by unrelated
  collections across all of Base with no per-collection topic to filter by,
  so backfilling all of it just to find our own tokens would be enormous;
  looking up receipts only for txs that already moved one of our tokenIds
  is the cheap version) to record a real sale price into `lants_trade` —
  `priceWei`/`currency` stay null (never guessed) when consideration
  doesn't resolve to a single currency, or when there's no Seaport log at
  all (a split/merge/internal move, not a sale).
- **Ran a full backfill to chain tip** (same session, follow-up round).
  Found and fixed a real bug on the way: `base-public.nodies.app`'s free
  tier hard-caps `eth_getLogs` at 50 blocks and returns a plain
  "resource not found" for a wider range (not a retryable rate-limit
  shape) — ponder treated that as an unhandled rejection and crashed the
  whole process at 93.4% backfill. Fixed with `ethGetLogsBlockRange: 40`
  on the chain config so every request stays under that cap regardless of
  which fallback RPC serves it; `ponder dev` resumed from its cached sync
  progress (not from scratch) and finished cleanly.
- **Found a second real bug via the first real trade the fixed backfill
  turned up**: the Seaport-decoding path summed every `consideration`
  item's `amount` as if it were a wei price without checking `itemType`.
  A same-day round-trip on tokenId 46 (bought for real ETH, then moved
  back) has an `OrderFulfilled` log whose consideration is an ERC-721
  item (the position NFT itself, itemType 2), not a currency — the buggy
  code recorded that as `priceWei: "1"`, `currency: <the NFT contract
  address>`, which is nonsense. Fixed by filtering consideration to
  itemType 0 (native) / 1 (ERC20) before resolving a price; anything else
  (a swap, or the position moving back with no currency leg) now
  correctly leaves `priceWei`/`currency` null instead of reporting a
  fabricated number. Re-verified after the fix: that reverse transfer now
  shows null/null as it should.
- **Confirmed one real sale end-to-end**, independently decoded straight
  from a fresh `eth_getTransactionReceipt` call (not just trusting the
  indexer's own output): tx `0xff518f11...ccd3c3` (block `51560107`,
  2026-09-20 13:06 UTC), Seaport `fulfillOrder` called directly (not
  through antseed-zh's app or OpenSea — exactly the kind of channel this
  indexer exists to catch), tokenId 46 offered by
  `0x114e1e37...01b6e6`, consideration 0.001 native ETH paid to that same
  address. Matches the indexer's `lants_trade` row exactly.
- Backfill on the free public RPCs took a while (many minutes with
  frequent 429/range-limit retries even after the fix) — fine for
  correctness, but a paid RPC key would be needed for a fast full backfill
  or production use.
- **Found a third real bug re-decoding the trade above's same-day
  round-trip** (tokenId 46 moved back via a WETH offer accept, tx
  `0xb66ba8d7...`): the price-resolution code only looked at
  `consideration` for a currency leg. In a bid/offer flow the buyer is the
  order's `offerer`, so the WETH they're paying is on the `offer` side and
  `consideration` holds only the NFT going back to them — the opposite
  layout from a listing sale. That whole 0.0011 WETH payment was on
  `offer`, so the old code found no currency in `consideration` and
  (correctly, given the bug) left the price null. Fixed by scanning
  `[...offer, ...consideration]` together for itemType 0/1 items, since the
  currency leg can land on either side depending on who created the order.
  Re-verified: both real trades on tokenId 46 now resolve a price, and
  cross-check exactly against the app's own self-reported `lants_trades`
  rows for the same two events (same tokenId/seller/buyer/priceWei).

## lANTS indexer wired into the backend (same 2026-09-20 session, follow-up)

Wired the indexer into `backend/lants-trades.js` (new
`backend/lants-indexer.js` is the GraphQL client, same throw-on-failure
style as `backend/antscan.js`; env var `LANTS_INDEXER_URL`, defaults to
`http://localhost:42069`):

- `latestOwners()` now layers the indexer's on-chain ownership over the
  self-reported trade log (indexer wins when it has data) before
  `computeLantsMarket()`'s existing Antscan-correction step runs.
- `listTrades()` now merges in indexer-decoded sales the app never heard
  about (a raw Seaport `fulfillOrder()` call, bypassing this UI entirely)
  in addition to the self-reported log.
- **Found a fourth real bug while testing the merge against the live local
  DB**: dedup can't rely on `tx_hash` — checked the actual production
  `lants_trades` rows and *both* trade types have `tx_hash IS NULL` in
  practice (not just the offer-accept endpoint, which never asks for one
  by design; the listing-buy endpoint accepts a txHash but isn't always
  sent one). Pure txHash dedup would have shown every real trade twice
  once the indexer went live. Fixed with a fallback match on
  `(tokenId, seller, buyer, priceWei)` when txHash is missing — the
  indexer's version wins on a match (it has a real txHash/currency, ours
  doesn't). Documented the residual, narrow risk in `lants-trades.js`: two
  real trades between the same pair, on the same tokenId, at the exact
  same price, would collapse into one row.
- Verified end-to-end against a real local run of `backend/server.js` +
  `ponder dev`: `/api/lants-market` correctly reports tokenId 46's current
  owner as the winner of the *second* (most recent) real trade, and
  `/api/lants/trades` returns exactly 2 trades (not 4) with the indexer's
  fuller data replacing the self-reported rows. Also verified graceful
  degradation with the indexer not running at all (the original state):
  both endpoints work exactly as before, logging
  `[lants-indexer] ... failed, continuing with self-reported trades only`
  instead of erroring.
- Not done: giving `/api/lants/offer/accept` a real txHash from the caller,
  which would close the dedup gap above properly instead of relying on the
  tuple-match fallback.

## lANTS indexer deployed as a persistent service (same 2026-09-20 session, follow-up)

Confirmed this host (not just a dev sandbox) is the real antseed-zh.com
production box — nginx has a live `antseed-zh-com` site proxying 443 to
`127.0.0.1:3001`, and this host already runs the user's other AntSeed
buyer/seller processes as systemd services. **Found along the way**:
antseed-zh.com is currently returning 502 — nothing is listening on 3001
right now (confirmed via `ps`/`ss` before touching anything, so this
session didn't cause it). `backend/server.js` isn't managed by a systemd
unit like the buyer/seller processes are; whatever normally keeps it
running isn't running right now. Flagged to the user, not fixed here — a
decision on how that process should be managed is a separate call.

Deployed `indexer/` itself as a systemd service:
- `/etc/systemd/system/antseed-zh-lants-indexer.service` — `ponder start
  --schema production --hostname 127.0.0.1` (production mode, not `dev`;
  binds loopback-only — port 42069 isn't in this host's ufw allowlist
  either, so this is defense in depth, not the only thing stopping outside
  access). `Restart=always`, enabled for boot, logs to
  `indexer/indexer.log` (gitignored).
- `ponder start` needs `--schema`/`DATABASE_SCHEMA` (an error without it);
  used the CLI flag. Storage is PGlite (embedded Postgres, not SQLite as
  assumed earlier) at `indexer/.ponder/pglite` — DATABASE_URL is still
  unset, so this is entirely self-contained on disk, no external DB needed.
- Verified: backfilled fully within seconds (raw RPC log/block data was
  already warm in the sync-store from this session's earlier `ponder dev`
  runs — a cold-start deploy elsewhere would take the many-minutes backfill
  seen earlier), GraphQL API at `127.0.0.1:42069/graphql` serves the same
  two real tokenId-46 trades verified earlier. Tested `systemctl restart`:
  it briefly logs `Schema is locked by a different Ponder app` for ~15s
  after a restart (PGlite's own lock taking a moment to clear, not a bug)
  then recovers on its own without systemd needing to intervene a second
  time; data survived the restart intact.
- `backend/lants-trades.js`'s `LANTS_INDEXER_URL` already defaults to
  `http://localhost:42069`, so no config change needed there once
  `backend/server.js` is actually running on this same host again.

## Dashboard deployed as a persistent service too — site is back up (same 2026-09-20 session)

The 502 above wasn't just the indexer's problem to fix around — the user
asked to bring `backend/server.js` back up as a systemd service, matching
the buyer/seller pattern:

- `/etc/systemd/system/antseed-zh-dashboard.service` — `node
  backend/server.js` from `/root/tian/antseed-zh`, `Restart=always`,
  enabled for boot, logs to `backend/server.log` (already gitignored via
  the existing `backend/*.log` rule). Ordered `After=` the indexer service
  (soft ordering only, no hard dependency — `latestOwners()`/`listTrades()`
  already degrade gracefully if the indexer isn't up yet).
- Did **not** run `npm run build` first — `dist/`/`dist-root/` (both from
  the same Sep 20 16:00 build) are stale relative to some newer `src/`
  edits (i18n, `listLants.js`, `StakeANTS.jsx`, `useTabRouter.js` from the
  Sep 15 session), but shipping a rebuild is its own deploy decision
  (AGENTS.md: `npm run build` here is a production deploy, not a
  formality) — starting the service with the existing build just restores
  the site to its last actually-deployed state, which is what "bring it
  back up" means. Rebuilding to ship the newer frontend changes is a
  separate call for the user to make.
- Verified end-to-end on the **real domain**, not just localhost:
  `https://antseed-zh.com` returns 200, `/api/lants-market` reports
  tokenId 46's owner correctly via the indexer merge, and
  `/api/lants/trades` returns exactly the 2 real trades (not 4) — the
  whole chain (nginx → dashboard → indexer, all three now systemd
  services) is confirmed working live in production, not just locally.
  Also verified `systemctl restart antseed-zh-dashboard` recovers cleanly.

## Frontend rebuilt and deployed to close the staleness gap above (same session, follow-up)

User asked to rebuild and ship it. `dist`/`dist-root` were stale because
they were never rebuilt, not because of any uncommitted work — checked
`git status` first: everything under `src/` was already committed (last
touch: `8427968`, part of PR #12/master, ahead of the live build's
`935088b`). Ran both build targets (`npm run build` then `BUILD_TARGET=root
npm run build` — both write `public/build-id.json` before their own `vite
build`, so it ends up holding the second run's id; each `dist`/`dist-root`
still has its own correct id baked into its JS bundle from its own build,
this is just a pre-existing quirk of sharing one id file across two output
dirs, not something this session introduced or fixed). Both builds
succeeded clean. The backend serves `dist`/`dist-root` straight from disk
on every request (no restart needed), and the server was already running
as a systemd service from the round above, so this went live immediately.
Verified on the real domain: `https://antseed-zh.com/build-id.json` now
reports `c004367` (current HEAD) instead of the stale `935088b`, site still
200.

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

`ClaimANTS.jsx`, `ChannelsView.jsx`, and `ANTSInfo.jsx` don't import
`useI18n()` at all — every string in all three is hardcoded English. This
predates this session (the i18n pass that added `src/i18n/` apparently
covered only the tabs that were reachable at the time) but is now a real,
user-facing gap since these three are reachable tabs again in a
zh-default app. Not fixed this session — translating ~1,700 lines of
mixed prose/labels/error messages accurately needs either a native
reviewer or a dedicated pass, not a rushed mechanical one. Worth doing as
its own piece of work, following the existing `t('namespace.key')` /
`en.js`+`zh.js` pattern the rest of the app uses.

### `ANTSInfo.jsx` vs `TokenomicsTab.jsx` overlap

Both show ANTS supply and emission allocation; `ANTSInfo` additionally has
the full contract-address list and the "how rewards are earned"/"how to
earn" explainers that `TokenomicsTab` doesn't. Now that both are reachable
tabs (see "Recently fixed" above), worth deciding whether to keep both or
merge `ANTSInfo`'s unique sections (contracts, explainers) into
`TokenomicsTab` and retire the separate tab, per the "curation over
completeness" principle from `docs/REWRITE_PLAN.md`.

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
