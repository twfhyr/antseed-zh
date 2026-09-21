// Historical/real data sync — replaces on-demand live refetching (and the
// fabricated heuristics that used to live in the network-catalog sync) with a local
// SQLite cache of real Antscan-sourced numbers.
//
// Design: on-chain history does not change once finalized, so we store it
// locally instead of re-fetching it on every page load. Only:
//   - the latest network snapshot (small, cheap, refreshed periodically)
//   - today's (still-open) daily_metrics row
//   - buyer/seller aggregate rows (these are live cumulative counters, so
//     they're refreshed periodically too, but each refresh is a local
//     upsert, not a page-load-triggered fetch)
// are ever re-fetched. Any daily_metrics row whose UTC day has fully elapsed
// is marked is_closed=1 and is never overwritten again.
import db from './database.js';
import {
  fetchNetworkSnapshot, fetchBuyers, fetchSellers, fetchDailyMetrics,
  fetchEpochMetrics, fetchSellerEpochCount, fetchBuyerEpochCount,
} from './antscan.js';
import { readChainMetrics } from './chain-poller.js';


function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

export async function syncNetworkSnapshot() {
  const snap = await fetchNetworkSnapshot();
  if (!snap) return null;
  db.prepare(`
    INSERT INTO network_snapshots (
      fetched_at, total_volume_usdc, total_platform_fees_usdc, total_deposited_usdc,
      total_withdrawn_usdc, total_staked_usdc, total_requests, total_input_tokens,
      total_output_tokens, channel_count, active_channel_count, settled_channel_count,
      buyer_count, seller_count, last_event_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Date.now(), snap.totalVolumeUsdc, snap.totalPlatformFeesUsdc, snap.totalDepositedUsdc,
    snap.totalWithdrawnUsdc, snap.totalStakedUsdc, snap.totalRequests, snap.totalInputTokens,
    snap.totalOutputTokens, snap.channelCount, snap.activeChannelCount, snap.settledChannelCount,
    snap.buyerCount, snap.sellerCount, snap.lastEventAt
  );
  // Keep only the last 500 snapshots (this table is a short rolling history
  // for trend display, not the source of historical truth — daily_metrics is).
  db.prepare(`
    DELETE FROM network_snapshots WHERE fetched_at NOT IN (
      SELECT fetched_at FROM network_snapshots ORDER BY fetched_at DESC LIMIT 500
    )
  `).run();
  return snap;
}

export async function syncBuyersOnchain() {
  const result = await fetchBuyers(2000);
  const items = result?.items ?? [];
  const upsert = db.prepare(`
    INSERT INTO buyers_onchain (
      address, spent_usdc, deposited_usdc, withdrawn_usdc, request_count,
      input_tokens, output_tokens, channel_count, unique_sellers,
      first_seen_at, last_seen_at, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      spent_usdc = excluded.spent_usdc, deposited_usdc = excluded.deposited_usdc,
      withdrawn_usdc = excluded.withdrawn_usdc, request_count = excluded.request_count,
      input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
      channel_count = excluded.channel_count, unique_sellers = excluded.unique_sellers,
      first_seen_at = excluded.first_seen_at, last_seen_at = excluded.last_seen_at,
      fetched_at = excluded.fetched_at
  `);
  const now = Date.now();
  const tx = db.transaction((rows) => {
    for (const b of rows) {
      upsert.run(
        b.address, b.spentUsdc, b.depositedUsdc, b.withdrawnUsdc, b.requestCount,
        b.inputTokens, b.outputTokens, b.channelCount, b.uniqueSellers,
        b.firstSeenAt, b.lastSeenAt, now
      );
    }
  });
  tx(items);
  return { count: items.length, totalCount: result?.totalCount ?? items.length };
}

export async function syncSellersOnchain() {
  const result = await fetchSellers(2000);
  const items = result?.items ?? [];
  const upsert = db.prepare(`
    INSERT INTO sellers_onchain (
      address, agent_id, stake_usdc, earned_usdc, request_count,
      input_tokens, output_tokens, unique_buyers, channel_count,
      first_seen_at, last_seen_at, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      agent_id = excluded.agent_id, stake_usdc = excluded.stake_usdc,
      earned_usdc = excluded.earned_usdc, request_count = excluded.request_count,
      input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
      unique_buyers = excluded.unique_buyers, channel_count = excluded.channel_count,
      first_seen_at = excluded.first_seen_at, last_seen_at = excluded.last_seen_at,
      fetched_at = excluded.fetched_at
  `);
  const now = Date.now();
  const tx = db.transaction((rows) => {
    for (const s of rows) {
      upsert.run(
        s.address, s.agentId, s.stakeUsdc, s.earnedUsdc, s.requestCount,
        s.inputTokens, s.outputTokens, s.uniqueBuyers, s.channelCount,
        s.firstSeenAt, s.lastSeenAt, now
      );
    }
  });
  tx(items);
  return { count: items.length, totalCount: result?.totalCount ?? items.length };
}

/** Daily time series — only overwrites rows that aren't closed yet. */
export async function syncDailyMetrics() {
  const items = await fetchDailyMetrics(120);
  const today = todayUtc();
  const now = Date.now();
  const getExisting = db.prepare('SELECT is_closed FROM daily_metrics WHERE day = ?');
  const upsert = db.prepare(`
    INSERT INTO daily_metrics (
      day, day_start, volume_usdc, platform_fees_usdc, deposits_usdc, withdrawals_usdc,
      requests, input_tokens, output_tokens, opened_channels, settled_events,
      closed_channels, active_buyers, active_sellers, is_closed, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET
      volume_usdc = excluded.volume_usdc, platform_fees_usdc = excluded.platform_fees_usdc,
      deposits_usdc = excluded.deposits_usdc, withdrawals_usdc = excluded.withdrawals_usdc,
      requests = excluded.requests, input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens, opened_channels = excluded.opened_channels,
      settled_events = excluded.settled_events, closed_channels = excluded.closed_channels,
      -- COALESCE so a transient count-fetch failure (which yields NULL)
      -- cannot erase a participant count we already resolved successfully.
      active_buyers = COALESCE(excluded.active_buyers, daily_metrics.active_buyers),
      active_sellers = COALESCE(excluded.active_sellers, daily_metrics.active_sellers),
      is_closed = excluded.is_closed, fetched_at = excluded.fetched_at
  `);
  let written = 0;
  const tx = db.transaction((rows) => {
    for (const d of rows) {
      const existing = getExisting.get(d.day);
      // Never rewrite a day we've already marked closed — that data is final.
      if (existing?.is_closed) continue;
      const isClosed = d.day < today ? 1 : 0;
      upsert.run(
        d.day, d.dayStart, d.volumeUsdc, d.platformFeesUsdc, d.depositsUsdc, d.withdrawalsUsdc,
        d.requests, d.inputTokens, d.outputTokens, d.openedChannels, d.settledEvents,
        d.closedChannels, d.activeBuyers, d.activeSellers, isClosed, now
      );
      written++;
    }
  });
  tx(items);
  return { written, total: items.length };
}

/** Per-epoch time series — like syncDailyMetrics, only overwrites the
 *  currently-open epoch (and any epoch we haven't stored yet). Buyer/seller
 *  counts require one extra GraphQL call per epoch each (no aggregate
 *  support on Antscan's API), so this only fetches counts for epochs we
 *  don't already have a closed row for. */
export async function syncEpochMetrics() {
  const items = await fetchEpochMetrics(30);
  const chain = readChainMetrics();
  const currentEpoch = chain?.emissions?.currentEpoch != null ? Number(chain.emissions.currentEpoch) : null;
  const now = Date.now();
  const getExisting = db.prepare('SELECT is_closed FROM epoch_metrics WHERE epoch = ?');
  const getCounts = db.prepare('SELECT active_buyers, active_sellers FROM epoch_metrics WHERE epoch = ?');
  const upsert = db.prepare(`
    INSERT INTO epoch_metrics (
      epoch, volume_usdc, requests, input_tokens, output_tokens,
      active_buyers, active_sellers, is_closed, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(epoch) DO UPDATE SET
      volume_usdc = excluded.volume_usdc, requests = excluded.requests,
      input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
      -- COALESCE so a transient count-fetch failure (which yields NULL)
      -- cannot erase a participant count we already resolved successfully.
      active_buyers = COALESCE(excluded.active_buyers, epoch_metrics.active_buyers),
      active_sellers = COALESCE(excluded.active_sellers, epoch_metrics.active_sellers),
      is_closed = excluded.is_closed, fetched_at = excluded.fetched_at
  `);
  let written = 0;
  for (const e of items) {
    const epochNum = Number(e.epoch);
    const existing = getExisting.get(epochNum);
    // Never rewrite an epoch we've already marked closed — that data is final.
    if (existing?.is_closed) continue;
    let activeBuyers = null;
    let activeSellers = null;
    try { activeSellers = await fetchSellerEpochCount(e.epoch); } catch (_) { /* leave null, retry next cycle */ }
    try { activeBuyers = await fetchBuyerEpochCount(e.epoch); } catch (_) { /* leave null, retry next cycle */ }
    // Only seal an epoch as closed once we actually have its counts (or the
    // row already has them). Sealing while a count fetch was failing would
    // freeze the NULL forever, since closed rows are never re-fetched.
    const resolved = getCounts.get(epochNum);
    const haveCounts = (activeSellers ?? resolved?.active_sellers) != null
      && (activeBuyers ?? resolved?.active_buyers) != null;
    const isClosed = currentEpoch != null && epochNum < currentEpoch && haveCounts ? 1 : 0;
    upsert.run(
      epochNum, e.volumeUsdc, e.requests, e.inputTokens, e.outputTokens,
      activeBuyers, activeSellers, isClosed, now
    );
    written++;
  }
  return { written, total: items.length };
}

let intervalId = null;

export async function runHistorySync() {
  const results = {};
  try { results.snapshot = await syncNetworkSnapshot(); } catch (e) { console.error('[history-sync] snapshot failed:', e.message); }
  try { results.buyers = await syncBuyersOnchain(); } catch (e) { console.error('[history-sync] buyers failed:', e.message); }
  try { results.sellers = await syncSellersOnchain(); } catch (e) { console.error('[history-sync] sellers failed:', e.message); }
  try { results.daily = await syncDailyMetrics(); } catch (e) { console.error('[history-sync] daily failed:', e.message); }
  try { results.epochs = await syncEpochMetrics(); } catch (e) { console.error('[history-sync] epochs failed:', e.message); }
  db.prepare('INSERT OR REPLACE INTO sync_meta (key, value, updated_at) VALUES (?, ?, ?)')
    .run('last_history_sync', JSON.stringify({ ok: true }), Date.now());
  return results;
}

/** Starts the periodic sync interval. Pass `runImmediately: false` when the
 *  caller has already run a sync once (e.g. during startup sequencing). */
export function startHistorySync(seconds = 300, { runImmediately = true } = {}) {
  if (intervalId) clearInterval(intervalId);
  intervalId = setInterval(() => {
    runHistorySync().catch((e) => console.error('[history-sync] cycle failed:', e.message));
  }, seconds * 1000);
  if (runImmediately) {
    runHistorySync().catch((e) => console.error('[history-sync] initial run failed:', e.message));
  }
}

export function readLatestSnapshot() {
  return db.prepare('SELECT * FROM network_snapshots ORDER BY fetched_at DESC LIMIT 1').get() ?? null;
}

/** One page of buyers, highest spend first. `q` filters by address substring
 *  server-side — doing it client-side would only ever search the pages that
 *  happen to be loaded, silently hiding matches.
 *  The `address ASC` tiebreaker is required for stable paging: hundreds of
 *  buyers share spent_usdc = 0, and without it rows could repeat or be
 *  skipped across pages. */
export function readBuyersOnchain(limit = 2000, offset = 0, q = '') {
  const where = q ? 'WHERE address LIKE ?' : '';
  const args = q ? [`%${String(q).toLowerCase()}%`, limit, offset] : [limit, offset];
  return db.prepare(
    `SELECT * FROM buyers_onchain ${where} ORDER BY CAST(spent_usdc AS INTEGER) DESC, address ASC LIMIT ? OFFSET ?`
  ).all(...args);
}

/** One buyer's full real activity row (spend, deposits/withdrawals, request
 *  count, input/output tokens, channel count, unique sellers, first/last
 *  seen) -- the "bills + tokens used" detail behind a click on the Buyers
 *  tab. Same table `readBuyersOnchain` already lists from; this is just a
 *  single-row lookup by address instead of a page. */
export function readBuyerOnchain(address) {
  return db.prepare('SELECT * FROM buyers_onchain WHERE address = ?')
    .get(String(address).toLowerCase()) ?? null;
}

/** Total indexed buyers (matching `q`, if given), for pagination. */
export function countBuyersOnchain(q = '') {
  if (q) {
    return db.prepare('SELECT COUNT(*) AS c FROM buyers_onchain WHERE address LIKE ?')
      .get(`%${String(q).toLowerCase()}%`).c;
  }
  return db.prepare('SELECT COUNT(*) AS c FROM buyers_onchain').get().c;
}

export function readSellersOnchain(limit = 2000) {
  return db.prepare('SELECT * FROM sellers_onchain ORDER BY CAST(earned_usdc AS INTEGER) DESC LIMIT ?').all(limit);
}

export function readDailyMetrics(days = 90) {
  return db.prepare('SELECT * FROM daily_metrics ORDER BY day_start DESC LIMIT ?').all(days).reverse();
}

export function readEpochMetrics(limit = 30) {
  // ASC + LIMIT would return the OLDEST epochs once more than `limit` rows
  // accumulate (i.e. the chart would freeze on epochs 0-29 forever). Take the
  // newest N, then reverse for chronological display — same as daily above.
  return db.prepare('SELECT * FROM epoch_metrics ORDER BY epoch DESC LIMIT ?').all(limit).reverse();
}
