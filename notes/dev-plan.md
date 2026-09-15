# Dev Plan — Live Backlog

Last reviewed: 2026-09-15. Keep this current — mark items done and remove
them (git history is the record of what was done and when; this file is
only for what's still open).

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
  wallet-gated tabs without removing the components). Added a compact
  RainbowKit `<ConnectButton>` to `Header.jsx` since Claim/Channels need a
  connect entry point and the header previously had none (removed
  deliberately in an earlier pass when the dashboard was public-read-only
  only). Registered the three new tab paths in
  `src/hooks/useTabRouter.js`'s `TAB_PATHS`/`VALID_TABS` — a new tab added
  to `App.jsx` without a matching entry there silently falls back to
  `overview` on direct navigation/reload.

## Open items

### Verify in a real browser (couldn't be done headlessly this session)

No browser tool was available when the Claim ANTS / Channels / $ANTS Info
tabs were re-wired. Build succeeded, the new tab strings are present in the
built bundle, and the API endpoints they depend on (`/api/deposits/config`,
`/api/channels`, `/api/rewards`) respond correctly — but nobody has actually
clicked through these tabs since the rewiring. Check for:
- Console errors on mount (especially wagmi/RainbowKit — `ConnectButton`
  render, `useAccount`/`useReadContracts` behavior with no wallet connected)
- Visual fit of `ConnectButton` in the header at both `zh` and `en` widths
- Mobile layout for all three re-wired tabs specifically (mobile responsive
  pass was a `REWRITE_PLAN.md` action item and its general completion
  hasn't been re-verified since these tabs came back)

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
