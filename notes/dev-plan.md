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

## Offer/accept txHash gap closed, dist rebuilt again (same session, follow-up)

Closed the dedup-fallback gap flagged in the indexer-wiring round above:
`/api/lants/offer/accept` now accepts an optional `txHash` and passes it
through to `recordTrade()` (was hardcoded `null`). `acceptLantsOffer()` in
`src/api.js` now takes and sends it; `acceptOffer()` in `src/lib/listLants.js`
now extracts the accept tx's hash the same way `fulfillListing()` already
does (`receipt?.hash || tx?.hash || null`) and passes it through, instead of
discarding `executeAllActions()`'s result entirely.

Rebuilt and shipped both targets again (`npm run build` +
`BUILD_TARGET=root npm run build`, both clean). Note: `build-id.json` still
reports commit `4d4a4d9` since this fix isn't committed yet (build id is
git-hash based, not content-hash based) — only its timestamp component
changed. Verified the fix is actually in the shipped bundle (`grep -l
acceptLantsOffer dist-root/assets/*.js` matches). Not committed or pushed —
only a rebuild was asked for this round.

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

## Buyer activity detail on click (new, 2026-09-21 session)

User asked to show a buyer's bills + tokens used when clicking a row on the
Buyers tab. Zero new data needed: `buyers_onchain` (synced from Antscan by
`syncBuyersOnchain()`) already had `spent_usdc`/`deposited_usdc`/
`withdrawn_usdc`/`request_count`/`input_tokens`/`output_tokens`/
`channel_count`/`unique_sellers`/`first_seen_at`/`last_seen_at` per address
— the Buyers tab's Total-mode row was just only ever rendering a curated
few of those columns (per `REWRITE_PLAN.md`'s curation-over-completeness
principle for the *list*), never exposing the rest anywhere.

- New `GET /api/history/buyer/:address` (`readBuyerOnchain()` in
  `backend/sync-history.js`) — single-row lookup, 404 (not an empty
  object) for an address Antscan has never indexed, so the UI can
  distinguish "no data yet" from "real zeros".
- `BuyersList.jsx`: rows are now clickable (either sub-tab — this is
  lifetime activity, not epoch-scoped) and open a `BuyerActivityModal`
  (reuses the existing `.modal-overlay`/`.modal-content` shell from
  `StakeANTS.jsx`'s list/offer/split modals) showing all ten fields, real
  data only, `—` for anything null.
- New i18n keys in both `en.js`/`zh.js` (`buyerActivity.*` + `table.lastSeen`).
- **Forgot to restart `antseed-zh-dashboard.service` after editing
  `backend/server.js`/`sync-history.js`** — the new route silently fell
  through to the SPA catch-all (served `index.html`, 200, for every
  request including a nonexistent address) until the restart. Caught by
  actually testing against the real domain, not just checking the build
  succeeded — worth remembering: backend changes need a process restart,
  unlike a frontend rebuild which the running server picks up from disk
  with no restart at all. Verified working after restarting: a real
  address returns its real numbers, a nonexistent one 404s.
- Rebuilt and shipped both `dist`/`dist-root` targets for this (running
  `npm run build` to sanity-check the frontend change already went live
  for the `/zh/` target before dist-root was rebuilt to match — both
  targets are consistent now).

## seed-pinned-peer.py dead reference removed (same session)

Confirmed (again, `find /`) this file referenced by `antseed-buyer-110/
heal/luck`'s `start-buyer.sh` scripts doesn't exist anywhere on the host —
always silently failed via `|| true`, never actually seeded anything.
Removed the whole `if [ "$PINNED_PEER" = apex ]; then python3
seed-pinned-peer.py ...; fi` block from all three scripts (this lived
outside the antseed-zh git repo, in each buyer's own `/root/.antseed-buyer-*`
data dir — not something `git status` here would show). Verified via a real
`systemctl restart antseed-buyer-heal` that the buyer still comes up
correctly pinned and serving real requests without it.

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

## Sellers/services catalog now sourced from local P2P discovery, not network.antseed.com (2026-09-21)

User asked, after a discussion about why epoch #23 only showed 18 sellers
and Apex being absent from the live catalog: is there a local-buyer-API way
to discover sellers instead of relying on an external service, and do
sellers get real names that way. Investigated with the actual `antseed`
CLI (updated 0.1.158 -> 0.1.162 first, then restarted every buyer/seller
service to pick it up) and found `antseed network browse --json` — real
P2P/DHT discovery through an already-connected local buyer daemon. Tested
it live: 53-57/57 peers back with a real `displayName` every time (100%),
vs `network.antseed.com/stats` (the *actual* prior dependency — this was
never Antscan; Antscan is a separate, still-used dependency for on-chain
settlement history that no P2P crawl could ever provide) leaving several
nameless. Also turned out to carry real `onChainAgentId`/
`onChainStakedAtSec`/`maxConcurrency`/per-service category+protocol data
inline — richer than the old payload for several fields.

Built the swap:
- New `backend/sync-local-discovery.js` replaces the deleted
  `backend/sync-official.js`. `fetchLocalPeers()` shells out to
  `antseed network browse --top 500 --json` via `execFile`, with
  `ANTSEED_DATA_DIR`/`ANTSEED_IDENTITY_HEX` pointed at
  `antseed-buyer-duggy`'s data dir -- reuses that already-running systemd
  daemon's live P2P connection rather than spinning up a competing node on
  the same identity (confirmed: a cold connect-from-scratch crawl can take
  well over a minute; a warm daemon answers faster).
- Same DB tables (`sellers`, `services`, `stats`), same column names, so
  the frontend (SellersList/ServicesList, both driven by camelize()'d
  passthrough) needed zero changes.
- Antscan cross-reference for `total_earned`/`unique_buyers`/
  `total_requests` (by `agent_id`) is unchanged in spirit —
  `buildAgentIdStatsMap()` replaces the old single-field
  `buildAgentIdToEarnedMap()`, same never-fabricate-on-a-miss behavior.
- **Real bug found and fixed while testing**: binding a plain JS `number`
  into `sellers.total_requests` (a TEXT column, same BigInt-safety
  convention as `sellers_onchain.request_count`) reliably produces a
  `"189093.0"`-style artifact via better-sqlite3/SQLite's affinity
  conversion -- reproduced it in isolation before fixing. The old code
  never hit this because Antscan's own GraphQL responses arrive as strings
  already; this is the first write path here to compute a number and bind
  it straight into a TEXT column. Fixed by keeping it a string.
- Added a periodic re-sync (`startLocalDiscoveryPoller`, 10 min) — the old
  code only ever ran this at startup or via the admin endpoint; local
  discovery is now cheap enough that keeping the catalog actually fresh is
  reasonable. Both the initial and periodic call are wrapped in `.catch()`
  (a lesson from earlier today with the Apex monitor and the offer/accept
  bug: never let a best-effort external/subprocess dependency crash or
  silently break the request path).
- Verified end-to-end on the real domain: `/api/sellers` 57/57 named
  (Apex included), `/api/services` shows real per-service categories
  (e.g. `["chat", "confidential", "reasoning"]`, not the generic
  `["general"]` fallback) and a real `maxConcurrency` (e.g. `2`), not the
  old hardcoded default of `10`.
- Not done: `joined`/`first_seen_at` show "unknown"/null for peers whose
  on-chain stats duggy's daemon hasn't cached yet (`onChainStakedAtSec`
  wasn't present for Apex on one test run, was on another via a different
  buyer's identity) — this should fill in on its own as duggy's daemon
  runs and its peer cache warms up; not something to chase further unless
  it's still empty after it's been running a while.

## Epoch Sellers tab: full catalog, not just epoch earners (2026-09-21 follow-up)

User pushed back correctly on the "18 sellers" explanation: the Epoch tab
existing as a pure filter on `seller_epoch_rewards` means a seller with
zero current buyers can never appear there, and can never earn its way in
either -- no points without buyers, no buyers without visibility. The
"Total" tab already avoided this (it's driven by `/api/sellers`, the full
local-discovery catalog, unfiltered by earnings) but Epoch wasn't.

Restructured `GET /api/epoch/sellers` to LEFT JOIN from `sellers` (the full
catalog) instead of starting from `seller_epoch_rewards` and only
optionally joining a name. Real epoch numbers where they exist, real `null`
(not a fabricated 0) where a seller has no epoch-23 activity at all --
`usd()`/`fmtAnts()` on the frontend already render both correctly with zero
changes needed there. Verified live: 57 sellers now (was 18),
`antseed-aggregator` present and findable by name search, real earners
(Apex Ant etc.) still sort first.

## lANTS renamed from "Staking"; new Staking tab for checking pool rewards (2026-09-21)

Followed a long back-and-forth about how staking/pool rewards actually work
(see backend/server.js's epoch-rewards fix above). User asked to:
1. Rename the "Staking" tab to reflect what it actually is — a marketplace
   for trading/managing lANTS position NFTs — since a genuinely separate
   staking section was about to exist and the two would otherwise collide
   on the name.
2. Add that separate section: a place for stakers to check (and claim)
   their pool rewards specifically.

**Renamed** (label only, not the tab key/URL — `stake` stays `stake` so
existing `/stake` links don't break): `nav.stake`/`stake.title` "Staking" →
"lANTS" (en + zh). `stake.blurb` already described it accurately as an
lANTS NFT marketplace; only the title was stale.

**New "Staking" tab** (`nav.staking`, new tab key `staking`, registered in
`useTabRouter.js`): `src/components/Staking.jsx`. Zero new backend work —
`GET /api/rewards?address=` already returns `staker.positions[]` /
`staker.total`, computed server-side via `@antseed/node`'s
`previewPoolRewards()` (a real on-chain preview, the same mechanism behind
the Epoch Sellers tab's Staking Reward column). The claim side (an on-chain
write, must be signed by the connected browser wallet, so it can't be a
backend call) reuses the exact index-then-batch-claim sequence
`ClaimANTS.jsx`'s already-proven (but unmounted/hidden) `claimStaker()`
already implements: `indexPoolRewards` loop to catch up a pool's lazy
reward index, then `pendingIndexedStakerReward` per position, then
`claimStakerRewardsBatch`. Did not un-hide `ClaimANTS.jsx` itself (it
bundles legacy + usage-reward claims too, which `RewardsANTS.jsx` already
covers on its own tab — surfacing the whole thing would duplicate that).

Verified: both build targets succeed, `/staking` route serves the app
shell (200), the new component/strings are present in the shipped bundle.
**Not verified in an actual browser** — no browser tool has been available
in any session today; the wallet-connect flow, live position rendering,
and the real claim transaction are unverified beyond static
build/route/bundle checks.

## /iants URL rename + Stakers redefined as a public list (2026-09-21, same day)

User follow-up after seeing the "Staking" tab plan: rename the lANTS
marketplace's URL from `/stake` to `/iants` (and all its sub-tabs), rename
the just-built personal reward-checker to "Stakers", move it next to
Sellers, and redefine it entirely -- not a wallet-connected rewards
dashboard, but a **public list**: address, amount staked, lock length, with
positions from the same address at the same lock length combined into one
row (since one lANTS NFT = one staking position, and this view is meant to
show the staker-level picture "better" than one row per NFT).

**URL rename** (`useTabRouter.js`): `TAB_PATHS.stake` 'stake' -> 'iants'
(tab *key* unchanged, just its path, so no `activeTab === 'stake'` checks
needed touching). `MARKET_TAB_PATHS`'s parent-segment check and
`marketTabHref()` updated to `iants` too. Also renamed the "All NFTs"
sub-tab's own URL segment from `iants` to `all` -- once the parent itself
is `/iants`, keeping the sub-tab's segment as `iants` would have produced
a literal `/iants/iants`; the sub-tab's internal key (`all`) is untouched,
only its URL segment moved, so StakeANTS.jsx needed zero changes. Verified
live: `/iants`, `/iants/sales`, `/iants/all` all 200. The old `/stake`
URL still resolves (200) since the server always serves the app shell for
any path) but silently falls back to Overview now -- anyone with a
bookmarked `/stake` loses that specific deep link.

**Stakers redefined, replacing the personal reward-checker built minutes
earlier same session**: deleted `src/components/Staking.jsx` (the
wallet-connected pending-reward/claim UI) and wrote
`src/components/Stakers.jsx` instead -- a plain public, paginated,
searchable table matching BuyersList.jsx's pattern, no wallet needed.
New backend `GET /api/stakers` (`computeStakers()` in server.js): reuses
`fetchOpenStakePositions()` (already used by the epoch-rewards sync,
no new external calls), excludes `closedAtEpoch != 0` positions (a
split/merge/move burn -- the exact filter `computeLantsMarket()` already
applies, and the exact gap noted as still-open in the epoch-rewards
`positionsByOwner` code a few rounds back in this same file) and the
mandatory 1-ANT provider-activation stake (`isProviderActivationStake()`,
same helper the lANTS marketplace's "For sale" view already uses to hide
it), then groups by `(owner, lockDays)` summing amount in wei (BigInt, no
float-accumulation error across combined positions) before converting to
ANTS once. `lockDays` uses the exact same real-epochDuration formula
`computeLantsMarket()` already uses for the marketplace's own lock-length
display, not a new guess. 90s in-memory cache, same TTL convention as
other computed-list endpoints.

Verified live against real data: 8 staker rows total right now; at least
two genuinely combine multiple positions (`positionCount: 2`) at the same
lock length, confirming the merge rule works, not just that it compiles.
Nav moved next to Sellers per the ask. Both builds succeed, `/stakers`
serves 200, `/api/stakers` returns real combined rows on the live domain.
**Not verified in an actual browser** -- same caveat as everything today,
no browser tool available.

## English now the default, zh/en switcher hidden (2026-09-21)

Site owner relayed the founder's decision: hide the language toggle, make
English the default (was zh), and stop translating new copy going forward.
This directly reverses `AGENTS.md`'s own written rule ("zh is the default
locale... new strings need both en.js and zh.js") -- updated that file to
match, so it stops giving stale instructions to whoever/whatever reads it
next.

- `src/i18n/index.jsx`: default `lang` 'zh' -> 'en' (both the context's
  default value and `getInitialLang()`'s fallback). Left the
  `localStorage`-preference path alone -- a returning visitor with `zh`
  already saved still gets zh, just can't pick it going forward since the
  switcher's gone. Not a risk either way: `t()` already falls back to
  `en.js` for any key missing from `zh.js`, so `zh.js` can now go stale
  without ever breaking a page (confirmed this is genuinely how it already
  worked, not something added for this change).
- `src/components/Header.jsx`: removed the switcher button entirely (was
  toggling `lang` between 'zh'/'en'). `setLang` stays exported from the
  context (cheap, unused, harmless) in case something needs to flip it
  later without another data-flow change.
- `index.html`: `<html lang="zh">` -> `lang="en"`; fixed a stale comment
  above the og/twitter tags that used to explain why they're English
  ("the app UI defaults to zh") -- that reasoning no longer applies now
  that English is the default everywhere, though the tags themselves
  didn't need to change (they were already English).
- `antseed-zh/AGENTS.md`: rewrote the i18n bullet -- new strings only need
  `en.js` now; explicitly says not to add new `zh.js` entries and not to
  delete the existing ones either.

Verified on the real domain, not just the build: `curl` of the live page
shows `lang="en"`, and the actual served JS bundle (not just what got
built locally) has no "Switch language" string in it.

## Loading speed pass: /iants and Stakers (2026-09-21, user made this a core design principle)

User asked why /iants (the lANTS marketplace) was slow, guessed it might be
the per-card generated SVG art, and separately asked whether Stakers could
be backed by a local DB or the indexer instead of live calls.

**Ruled out the SVG theory with evidence, not just assertion**: checked
`nftPalette()` (a few modulo ops) and the `<svg>` markup itself -- trivial,
deterministic, no filters/blur, negligible even across the whole page.
Added temporary timing instrumentation to `/api/lants-market` instead of
guessing, and found the real cause:

**Real bug, root cause of every /iants load being slow**: `ensureIds`
parsing did `String(req.query.ensureIds || '').split(',').map(Number)
.filter(Number.isFinite)`. `''.split(',')` is `['']` (one element, not
zero), and `Number('')` is `0` -- a *finite* number, not `NaN` -- so an
absent/empty `ensureIds` query param produced `[0]`, not `[]`. That made
`ensureIds.length > 0` true on every single request with no `ensureIds` at
all, which made `forceFresh` true unconditionally, which bypassed the
already-correctly-implemented 90s cache *entirely* -- every page load was
a full blocking Antscan + on-chain refresh (1.8-6s observed live) instead
of an instant cache hit. Fixed by filtering out empty segments before
mapping to `Number`. Verified on the live domain: 2000-2300ms -> 40-70ms,
a ~30-40x improvement, confirmed with real requests before and after, not
just reasoning about the fix.

**Stakers**: was calling `fetchOpenStakePositions()` (Antscan) live behind
a 90s in-memory cache, so every cache-miss request (up to once per 90s,
plus always right after a restart) blocked on a real GraphQL round-trip
(70ms-545ms observed). User asked to check feasibility of a local DB or
the indexer instead:
- **Indexer route, evaluated and technically feasible but not done**:
  `AntseedSellerPools.sol` emits `StakeCreated`/`StakeMoved`/`StakeSplit`/
  `StakesMerged`/`StakeWithdrawn`/`LockExtended` events that carry
  everything a Stakers row needs (owner, amount, lock epochs) directly --
  no extra on-chain reads needed, unlike the lANTS trade-price decoding
  work earlier this session. Would fully remove the Antscan dependency for
  this specific feature and give real-time-accurate data instead of a
  5-min-stale snapshot. Not built: given the position count is tiny and
  the DB-cache option below already gets this to near-zero latency, adding
  five new event handlers to the indexer for a small remaining freshness
  gain wasn't judged worth the risk today, on top of everything else this
  session already changed there.
- **Built instead**: new local `stake_positions` table (`database.js`),
  populated by `syncStakePositions()` (`sync-history.js`), piggybacking on
  the *existing* 5-minute `runHistorySync()` cadence -- no new poller, no
  extra Antscan load. `computeStakers()`/`GET /api/stakers` now reads this
  table directly (synchronous, no cache needed at all, nothing to go
  stale-then-refresh). Verified on the live domain: 70ms-545ms -> 2-11ms,
  same real data (identical 8 rows, same combined-position counts) both
  before and after.

Neither fix touched any frontend file -- both are backend-only, so nothing
needed rebuilding, just the dashboard restart to load the new backend code.

## 2026-09-21: IANTS tab moved next to Stakers; Merge + Move added to Mine

Three-part ask: (1) move the lANTS marketplace nav tab to sit next to
Stakers instead of after $ANTS Info, (2) relabel it "IANTS" (uppercase I)
since it and Stakers are now presented as a pair, (3) read the real
`AntseedSellerPools.sol` contract functions for combining positions into
one NFT or moving a position to a different seller, and add "Merge" and
"Move" actions to the Mine sub-tab, matching the existing Split feature's
pattern end to end.

**Contract research first** (`/root/tian/antseed/packages/contracts/sellers/
AntseedSellerPools.sol`), verified against the live contract on Base
(`0x8bf4...0652`), not just the source:
- `mergeStakes(uint256[] positionIds)`: needs 2+ positions, all owned by
  the caller, all the same `agentId`, and — critically — all must resolve
  to the *exact same* restructured start/end epoch once each is closed
  (`_closePositionForRestructure`), or the whole call reverts
  (`InvalidValue`). In practice this only holds for positions that already
  share both `stakeStartEpoch` and `stakeEndEpoch`, so the frontend gates
  merge candidates on "same seller + identical lock window" rather than
  trying to replicate the restructure math client-side — the same
  same-locked-time grouping the Stakers page already uses. Burns all
  sources, mints one new position, emits `StakesMerged(positionIds,
  newPositionId, staker, amount, weightAmount)`.
- `moveStake(positionId, toAgentId)` / `moveStakes(ids[], toAgentId)`:
  needs ownership and a registered target seller agent
  (`_requireRegisteredSellerAgent`). Keeps principal and unlock date
  unchanged; only the seller it backs changes. Can apply a protocol-wide
  `moveWeightPenaltyBps` to the position's future reward weight — read
  live on-chain before writing the UI copy: currently **0** (default,
  unchanged since deploy), so the Move modal states "0% currently" rather
  than promising no penalty ever, since it's an admin-settable value.
  Burns the old NFT, mints a new one, emits `StakeMoved(oldPositionId,
  newPositionId, staker, fromAgentId, toAgentId)`.

**Built, following the existing Split feature's exact pattern**
(`splitPosition()` in `src/lib/listLants.js` was the template throughout):
- `src/lib/listLants.js`: added `SELLER_POOLS_MERGE_MOVE_ABI` (minimal ABI
  for `mergeStakes`/`moveStake` + their events), `mergePositions()` and
  `movePosition()` — same BrowserProvider+signer+wait+parse-logs shape as
  `splitPosition()`, returning the new position id(s) parsed straight out
  of the transaction receipt's `StakesMerged`/`StakeMoved` log.
- `src/components/StakeANTS.jsx`:
  - New `myPositions` state: the caller's full position list (uncapped by
    the active tab/page/filter, `pageSize=100`), refetched on wallet
    change and after a successful merge/move. Needed because merge
    siblings can live outside whatever page of "Mine" happens to be open.
  - `mergeCandidates(myPositions, p)`: pure filter implementing the
    same-agent + same-lock-window rule above, excluding listed positions
    and 1-ANT provider-activation stakes (same exclusions as Split).
  - `doMerge`/`doMove` handlers: identical shape to `doSplit` — validate
    wallet/pool address, validate the form, call the lib function, walk
    through `phase` states (`merging`/`moving` → `done`/`error`), then
    force a fresh on-chain read of every touched id via `ensureIds` (the
    new position(s) won't be in Antscan's cache yet — same reasoning as
    Split's own comment) and refresh `myPositions`.
  - `canMerge`/`canMove` gating added to the `LantsNftCard` call site,
    computed the same way as the existing `canSplit`/`canList`/`canOffer`
    props (ownership + not listed + not an activation stake; merge
    additionally requires at least one real candidate).
  - Two new buttons on `LantsNftCard` next to the existing Split button,
    and two new modals, `MergeModal` (checkbox list of eligible sibling
    positions, running combined-total preview) and `MoveModal` (a
    `<select>` of registered sellers excluding the position's current
    one, reusing the `sellers` state already loaded for the seller-filter
    dropdown) — both modeled directly on `SplitModal`.
  - Mounted `<MergeModal>`/`<MoveModal>` next to the existing
    `<SplitModal>` at the bottom of the component.
- `src/i18n/en.js` (zh.js untouched, per the English-default/no-new-
  translations policy above): added `stake.merge*`/`stake.move*` keys.
  The two pre-existing `nav.stake`/`stake.title` keys were *changed*
  (`'lANTS'` → `'IANTS'`), not added, so both en.js and zh.js were updated
  for that one — it's a label edit, not a new translation.
- `src/App.jsx`: moved the `stake` tab's `<a>`/render block to sit
  immediately after `stakers` (previously it came after `$ANTS Info`), and
  updated its neighboring comment block to describe Merge/Move and the
  new position next to Stakers.

**Verified live, no backend restart needed** (frontend-only change; the
Express static handler in `server.js` (`staticDirFor`/`express.static`)
reads `dist`/`dist-root` off disk per-request, so a rebuild alone is
enough): ran `npm run build` and `BUILD_TARGET=root npm run build`, then
confirmed the live site (`antseed-zh.com`) was already serving the new
bundle hash (`index-Cb4amrVZ.js`) and that it contains both `IANTS` and
the new `stake.merge*` i18n keys.

## 2026-09-21: Merge redesigned to a grouped list after live testing; a real Move/Merge race fixed

User tested Move live ("works pretty well") and gave direct feedback on
Merge before testing it further:

> for the merge i would suggest put all nfts which are eligible for
> merging in a group and owners could choose any of them to merge. also
> don't use the button list here but list. another thing to notice that i
> have two nfts which can be merged but after move one of them to another
> provider it should be not aviable to merge so no meaning to show merge
> of the other one. the newly minted nft not show the merge button.
> actually just use a group to put the same items together while once
> move out it becomes a new group.

Two changes, both in `src/components/StakeANTS.jsx`:

**1. Merge UX rebuilt as a grouped list, not a per-card button+modal.**
The old flow put a "Merge" button on every eligible card, opening a modal
anchored on that one card with checkboxes for its siblings — implying a
"base" position that doesn't actually exist in `mergeStakes()`, which just
takes an unordered array. New flow: `groupMyPositions()` clusters the
Mine tab's positions by `mergeGroupKey()` (same seller + identical lock
window); any cluster of 2+ renders as one `MergeGroup` block — every
member card shown together with a checkbox on it, plus a single "Merge
selected (n)" button for the whole group. Any 2+ checked can be merged,
with no fixed anchor. A position with no eligible partner renders as a
plain card with no merge affordance at all — matching "the newly minted
nft [should] not show the merge button" once it no longer shares a lock
window with anything. Also dropped the modal entirely: merge needs no
extra input beyond "which ones," which the checkboxes already are, so
`doMergeSelected` fires directly off the group's button (same directness
as Cancel/Buy elsewhere on this page) instead of adding a confirmation
step that would just repeat the same list.

**2. Real bug, not just a UX gap:** after Move, the sibling position kept
showing as merge-eligible for a few seconds against a partner that had
just moved away. Root cause was a race: `doMove` (and the old `doMerge`)
fired `refreshMyPositions()` *alongside* the action's own `wait=1` market
refresh instead of after it, so the myPositions refetch could return
first with pre-move data. Fixed by chaining `refreshMyPositions()` in a
`.then()` after the market refresh resolves — no extra `force`/`wait`
needed on that second call either, since the first call's `wait=1` already
forced a full recompute into the *shared* (not owner-scoped)
`lantsMarketCache`, and that write completes before the response is even
sent, so the very next request lands well inside the 90s freshness window
regardless. `refreshMyPositions({ force: true })` is kept only for the
`.catch()` fallback path, where that recompute may not have happened at
all. Since groups are recomputed fresh from `myPositions` on every
render, fixing the staleness automatically fixed the stated symptom too —
"once move out it becomes a new group" now just falls out of
`groupMyPositions()` re-running on correct data, no separate "disband the
group" logic needed.

New CSS: `.lants-merge-group`/`.lants-merge-group__header`/
`.lants-merge-group__actions` (a dashed-border cluster spanning the full
grid row) and `.lants-nft__mergecheck` (the per-card checkbox) in
`src/index.css`. i18n: replaced the old per-card-modal keys
(`mergePosition`, `mergeConfirm`, `mergeCandidateRow`, `mergeNoCandidates`,
`mergePickAtLeastOne`) with group-oriented ones (`mergeGroupLabel`,
`mergeGroupTotal`, `mergeSelect`, `mergeSelectedConfirm`) in `en.js` only,
keeping `merging`/`mergeOk`/`mergeHint`/`mergeResult` since those still
apply. `docs/ARCHITECTURE.md`'s Merge subsection rewritten to describe the
grouped UI and the race fix instead of the retired modal.

Verified live the same way as every other frontend-only round this
session: `npm run build` + `BUILD_TARGET=root npm run build`, then
confirmed `antseed-zh.com` was serving the new bundle hash and that it
contains the new `mergeGroupLabel`/`mergeSelectedConfirm`/`mergeSelect`
i18n keys. Pushed as a follow-up commit on the open PR
(`feat/iants-stakers-and-perf`, #13) rather than a new one, since it's
addressing review feedback on work already under review there.

## 2026-09-21: lANTS trading rebuilt BRC-20-style -- per-ANT USDC pricing, no ETH shown, no duplicate offers, offers ranked by price

User: "iants feel more like brc20 so its trading should use similar ways
like brc20" -- five concrete asks, all shipped, referencing unisat.io's
BRC-20 market UI as the model:

1. **Per-ANT price input, total shown.** List/Offer forms now collect a
   price *per ANT* (`stake.listPrice`/`stake.offerPrice` relabelled),
   compute the flat total Seaport actually needs
   (`perAnt * position.amount`), and show that computed total inline in
   both modals (`stake.totalPrice`) -- the same way a BRC-20 market prices
   by unit and shows the total. `doList`/`doMakeOffer` in `StakeANTS.jsx`
   do the multiplication; `createAndPostListing`/`makeOffer` in
   `listLants.js` still just take one flat total, since Seaport orders
   have no "per unit" concept.

2. **USDC only, no ETH shown anywhere.** This was the biggest change:
   listings switched from a native-ETH Seaport consideration to an ERC20
   USDC one, and offers switched from WETH to USDC. Verified zero active
   listings existed at the moment of the switch (`lants_listings` query),
   so there was no live ETH-priced listing to break.
   - `src/lib/listLants.js`: added `USDC_BASE`
     (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, same address already
     used in `DepositModal.jsx`) and `USDC_DECIMALS = 6`. Removed
     `ensureWeth()`/`WETH_ABI` (the wrap-ETH-into-WETH step) entirely --
     confirmed by reading seaport-js's own `createOrder()`/`fulfillOrder()`
     source that `executeAllActions()` already auto-generates an
     `approve()` action for whatever ERC20 an order's offer/consideration
     needs, the same generic mechanism that used to cover WETH's approval
     step, so USDC needs zero new approval-handling code -- no
     wrap-first step either, since USDC (unlike ETH) is already a token
     people hold directly. `fulfillListing`/`acceptOffer` needed **no
     changes at all**, being fully generic already.
   - **Real bug caught before shipping**: `parseUnits(String(priceUsdc), 6)`
     throws `NUMERIC_FAULT: too many decimals` on almost any real
     `perAnt * amount` result, since JS float multiplication routinely
     produces things like `0.30000000000000004`. Fixed with
     `Number(priceUsdc).toFixed(6)` before `parseUnits` in both
     `createAndPostListing` and `makeOffer`. Caught by actually running
     the multiplication through `parseUnits` in a throwaway `node -e`
     before trusting the code, not just reading it.
   - Backend (`server.js`): removed `ethUsdPrice()`/the Coinbase spot-price
     cache entirely -- USDC's own peg means no conversion is needed for our
     own listings any more. `computeLantsMarket()`'s local-listing branch
     now reads `price_wei` as USDC (÷1e6) instead of ETH (÷1e18).
     `/api/lants/list` and `/api/lants/offer` both now reject any order
     whose consideration/offer token isn't
     `emissionsCfg.usdcContractAddress` (live-resolved, not hardcoded).
   - Frontend display: `formatListing()` simplified to always show the USD
     total, never a raw ETH/token unit -- covers OpenSea-scraped listings
     too, which can still carry an ETH `unit`/`symbol` from the scraper.
     Offer rows and the trade-history table now decimal-aware
     (`formatTradeAmount()`/`CURRENCY_DECIMALS`) rather than hardcoded
     ÷1e18, since 3 real WETH offers (18 decimals) were already open on
     token 36 in production at the time of this change and are kept
     working, not hidden or migrated.

3. **No duplicate offers, and an explicit message for every action.**
   Real production data caught the exact bug being described: the same
   address had 3 open WETH offers already sitting on token 36 (from
   earlier live testing this session, before this fix existed) --
   confirmed by querying `database.sqlite` directly before writing the
   fix. Added `openOfferModal()` in `StakeANTS.jsx`: before showing the
   offer form, it fetches the token's current offers and blocks (disabled
   form, `stake.offerAlreadyExists` message) if the connected address
   already has one open, rather than letting a second submission through
   silently. Backed by a **server-side check too**
   (`/api/lants/offer` now 409s on a duplicate `(offerer, tokenId)`) as a
   backstop against a stale tab or race bypassing the client-side check --
   verified live with a raw `curl` POST reproducing exactly that address's
   real duplicate. Audited every action's existing inline message
   (list/offer/buy/cancel/split/merge/move all already had one) rather
   than adding a new toast system; the one genuine gap was the new
   duplicate-offer case, now covered.

4. **Offers ranked highest to lowest.** `offersForToken()`
   (`backend/lants-offers.js`) used to `ORDER BY created_at DESC`
   (newest first) -- changed to sort by price descending, done in JS with
   `BigInt` comparison rather than SQL `ORDER BY` on the TEXT `price_wei`
   column (a lexicographic string sort gets differing-digit-length
   amounts wrong). Noted as a known approximation for the rare token that
   mixes an old 18-decimal WETH offer in with new 6-decimal USDC ones,
   since their raw base-unit amounts aren't directly comparable -- not
   worth solving given all new offers are USDC-only going forward.

5. **Rank listings by per-ANT price, not per-NFT total.** Already true
   server-side (`paginateMarketItems`'s `price` sorter already keyed off
   `listing.perAntUsd`) -- the actual gap was the frontend's *default*
   sort being `id`, not `price`. Changed `marketSort`'s default state to
   `'price'` (ascending, cheapest-per-ANT first), matching a BRC-20
   market's own default view.

Verified live: rebuilt both targets, restarted the dashboard backend
(server.js logic changed this time, not just the frontend), confirmed the
live bundle hash matches and contains the USDC address + new copy, and
ran real `curl` requests against the live `/api/lants/offer` endpoint
confirming both the USDC-only validation and the duplicate-offer 409 fire
correctly against real production data (that same address's 3 existing
offers on token 36).

## 2026-09-21: real listing test caught a Mine-tab staleness bug across five actions

User tested List live in the browser and hit two things: the confirm
modal stayed open after a successful listing instead of returning to the
Mine tab, and the card still showed "List here" afterward instead of
switching to "Cancel listing".

**Root cause, not a display glitch**: the Mine tab was redesigned earlier
this session (the Merge grouping work) to render from `myPositions` (a
separate, uncapped fetch) instead of the paginated `market` state. Every
mutation handler that predates that redesign — `doList`, `doBuy`,
`doCancel`, `doSplit`, `doAcceptOffer` — only ever refreshed `market`
after finishing, never `myPositions`. `doMergeSelected`/`doMove` (written
*during* the redesign) already got this right; the five older handlers
never got the same treatment. So a real listing succeeded on-chain and in
the DB, `market` refreshed fine, and the Mine tab kept reading the old,
now-stale `myPositions` snapshot regardless. Audited all seven mutation
handlers systematically once the pattern was clear, not just the one the
user hit:

| Handler | Needed `refreshMyPositions`? | Why |
|---|---|---|
| `doList` | yes (was missing) | listing changes `p.listed`/`fulfillableHere` on the caller's own position |
| `doCancel` | yes (was missing) | same, in reverse |
| `doBuy` | yes (was missing) | buyer's own `myPositions` gains the bought position |
| `doSplit` | yes (was missing) | source position disappears, two new ones appear |
| `doAcceptOffer` | yes (was missing) | seller's position leaves their own `myPositions` |
| `doMakeOffer` | no | `canOffer` already excludes the Mine tab and the position's own owner — never affects the offerer's own positions |
| `doCancelOffer` | no | only retracts an offer, never touches position ownership |

All five fixed the same way as `doMergeSelected`/`doMove`: chain
`refreshMyPositions()` in a `.then()` after the market refresh resolves
(not fired alongside it), with `refreshMyPositions({ force: true })` only
in the `.catch()` fallback.

**Second fix**: `ListModal`/`OfferModal` used to stay open on a `'done'`
phase after success, requiring a manual close — now `doList`/
`doMakeOffer` call `setListForm(null)`/`setOfferForm(null)` directly on
success instead. The updated card (price appears, button switches to
"Cancel listing"/offer count increments) is the confirmation, the same
way Cancel/Buy's inline (non-modal) messages already worked. Left
`SplitModal`/`MoveModal` open on success on purpose — they show a new
position id the card doesn't otherwise surface, so closing them would
lose real information; `MergeGroup` was already built this way with no
modal at all.

Frontend-only change, no backend restart needed. Verified both builds and
confirmed the live site is serving the new bundle; couldn't re-verify the
actual "button switches to Cancel listing" behavior against a real owned
position (no funded/owning test wallet available, same limitation noted
in the previous round's live-test writeup) — this one is a code-review-
level fix, not a live-verified one.

## 2026-09-21: For-sale page implied MC/FDV, "ANTS" not "ANT", trimmed blurbs

Three small requests, all shipped:

1. **Implied MC/FDV based on the floor price, at the top level.** Every
   per-listing card already computed `mcUsd`/`fdvUsd` from that listing's
   own `perAntUsd` (`computeLantsMarket()` in `server.js`) -- by
   definition, the floor listing's own values already *are* "implied MC/
   FDV at the floor price," just never surfaced outside that one card.
   Added `floorImpliedMcUsd`/`floorImpliedFdvUsd` to the market response
   (the floor item's own already-computed values, no new math) and two
   more `StatCard`s next to "ANTS Price" on the For-sale page.

2. **"ANTS" is the token name, not "ANT."** Audited every standalone
   `ANT` (not part of `ANTS`/`lANTS`) across `en.js`, `zh.js`,
   `StakeANTS.jsx`, and `listLants.js` and fixed all of them --
   "Floor per ANT" → "ANTS Price" (also simplified per point 3 below),
   "Price per ANT (USDC)" → "Price per ANTS (USDC)", "1 ANT provider-
   activation" → "1 ANTS," etc., including in code comments. `zh.js` got
   the same mechanical `ANT`→`ANTS` symbol fix (a factual correction, not
   new translation) but its blurb *sentences* were deliberately left
   otherwise untouched — rewriting trimmed English content into Chinese
   would be new translation work, against this session's standing "no new
   zh.js translations" rule, and the switcher stays hidden regardless.

3. **Trimmed the blurbs.** "remove unecessary words like no api key
   needed or 1 nat [ANT] provider is filtered. no one cares" --
   `stake.blurb`/`stake.marketBlurb`/`stake.noneListed` cut down to their
   load-bearing sentences (what this page is, not a running list of
   caveats about how it was built). `stake.floorPerAnt`'s value changed
   from "Floor per ANT" to "ANTS Price" per the explicit ask to stop
   calling it a "floor" stat, even though the underlying number is still
   the cheapest live listing's per-ANTS price -- only the label changed.

Backend field added (`server.js`), so the dashboard was restarted this
round, not just rebuilt. Verified live: forced a fresh `/api/lants-market`
recompute and confirmed `floorImpliedMcUsd`/`floorImpliedFdvUsd` are
present (both `null` right now since there are zero active listings to
compute a floor from -- same real state confirmed in the last few rounds'
live tests); confirmed the live bundle contains "ANTS Price" and no longer
contains the removed filler phrases.

## 2026-09-21: marketplace fee -- planned, deliberately not implemented yet

User asked whether the marketplace's own Seaport orders could carry a fee
(after I confirmed, checking the real deployed Seaport 1.6 contract
source, that it currently charges 0% to anyone, including OpenSea --
OpenSea's cut only exists because their own tooling opts into it as an
extra consideration item, which this site's order-building code never
does). Answer given: yes, straightforward, same `fees` param seaport-js
already supports. User's call: "add the fee to a plan but not implement
it now since the marketplace is just finished and I need more users to
test." Written up as `docs/ARCHITECTURE.md`'s new "Planned: a marketplace
fee (not yet implemented)" section under lANTS Marketplace -- mechanism,
and the open decisions (rate, recipient, list/offer/both, backend
validation changes, backward compatibility, display honesty) for
whoever picks this up once there's real trading volume to justify it.
No code changed. Not committed -- doc-only, and this session's standing
rule is explicit-ask-only for commits regardless.

## 2026-09-21: IANTS reverted to lANTS on founder feedback -- label and URL

Founder: "the character should be lants which means locked ants rather
than iants." The rename to "IANTS" (capital I) earlier this same session
was wrong -- the real name is "lANTS" (lowercase L, for *locked* ANTS),
which this codebase already used correctly everywhere else (the NFT
itself, `AntseedSellerPools`, every other mention of "lANTS NFT").
Reverted both the displayed label and the URL:

- `nav.stake`/`stake.title` i18n keys: `'IANTS'` -> `'lANTS'` in both
  `en.js` and `zh.js` (a label correction, not a new translation --
  same exception this session has used for every prior rename).
- URL: `TAB_PATHS.stake` and the market sub-tab's base segment
  (`src/hooks/useTabRouter.js`) both changed `'iants'` -> `'lants'`
  (`/lants`, `/lants/sales|all|mine|history`).
- Added a **legacy alias**: `PATH_TABS.iants = 'stake'` and
  `marketTabFromLocation()` now accepts either `lants` or `iants` as the
  first path segment. `/iants` was only the canonical URL for a few
  hours today, but a live site can already have that link shared
  somewhere -- the alias means an old `/iants` (or `/iants/mine` etc.)
  link still lands on the right tab instead of 404ing or silently
  falling back to Overview. `tabHref`/`marketTabHref` (the functions that
  *generate* links) only ever emit the canonical `lants` now, so the
  alias never leaks back out into a newly-created link.
- Updated every other "IANTS"/`/iants` mention across live code comments
  and docs (`App.jsx`, `docs/ARCHITECTURE.md`, `docs/README.md`,
  `README.md`) to `lANTS`/`/lants`, leaving only clearly-marked
  historical notes ("briefly relabelled IANTS, reverted the same day")
  where the old name is referenced as history, not current fact.

Verified live: rebuilt both targets, confirmed the live bundle contains
"lANTS" and the live site's `/lants` and legacy `/iants` both return 200
and resolve to the right tab. Frontend-only, no backend restart needed.

## Portfolio tab (2026-09-22)

User asked: add a portfolio section showing the connected wallet's
activity as a buyer and seller, plus its lANTS holdings. New tab,
`/portfolio`, placed right after Stakers and before lANTS.

**Reused existing data sources rather than building new ones where
possible:**
- Buyer activity: `fetchBuyerActivity` (existing, from the Buyers tab's
  detail modal) -- unchanged.
- lANTS holdings: `fetchLantsMarket({owner: address})` -- the exact same
  call StakeANTS.jsx's Mine sub-tab already makes. Read-only summary here
  (amount, lock days remaining, seller name, listed status); actual
  management (list/split/merge/move) stays on the lANTS tab, linked to via
  `marketTabHref('mine')`.

**New, since no seller-side equivalent existed:**
- `readSellerOnchain(address)` in `backend/sync-history.js`, mirroring
  `readBuyerOnchain` exactly (`sellers_onchain` is keyed by `address`
  already, same as `buyers_onchain`).
- `GET /api/history/seller/:address` in `backend/server.js`, mirroring
  `/api/history/buyer/:address` -- 404 (not an empty object) when Antscan
  has never indexed the address, same "no data yet" vs "zero activity"
  distinction.
- `fetchSellerActivity(address)` in `src/api.js`.

Not connected: same "search any address" fallback as ClaimANTS.jsx's "Look
Up Any Address", so the tab stays useful without a wallet too.

**Real bug caught while shipping**: rebuilding the frontend (`npm run
build`) ships live immediately from disk (no restart), but the new
*backend* route needed an actual `systemctl restart
antseed-zh-dashboard` to take effect -- without it, the new endpoint
200'd the SPA-fallback HTML instead of JSON (the exact same class of bug
noted in the buyer-activity-detail round). Caught by curling the live
endpoint before and after the restart, not assumed.

Verified against the real live backend, not just that it builds: seller
endpoint returns real data for a known seller (agent #47218, real
earned/stake/request figures); buyer endpoint correctly 404s for a
seller-only address; lANTS holdings correctly show 0 positions for that
same seller wallet and a real position (19,795.3 ANTS, 728-day lock, 730
days remaining, seller "Open Forge") for a known staker address. No
browser tool available in this environment, so the actual rendered page
was not visually clicked through -- only the data layer (all three
API calls, all success/empty/not-found branches) was exercised for real.

## Open questions (no obvious right answer — flag to the user, don't guess)

- Should the admin routes (`/api/admin/sync`, `/api/admin/force-*-sync`)
  have `ADMIN_SYNC_TOKEN` actually set in the production environment right
  now, or are they intentionally relying on the loopback-only fallback?
  Worth a one-time check (`ps`/`systemd` env, not committed anywhere) next
  time someone has shell access to the deployment host.
