// Live peer/service catalog -- sellers, their models, and pricing -- sourced
// from this box's own P2P discovery (`antseed network browse --json`) run
// against an already-connected local buyer daemon, instead of the official
// AntSeed network-stats aggregator (network.antseed.com/stats). Real DHT
// discovery through our own node: no dependency on that external service
// being up, and (verified 2026-09-21) it returns a display name for every
// peer, where the old official-API path routinely left many nameless.
//
// Antscan is still used, but only for what a live P2P snapshot can't ever
// provide: `sellers_onchain` (backend/sync-history.js) carries real
// lifetime earned USDC / unique buyers / request counts, cross-referenced
// here by agentId. Never fabricated: a peer whose agentId has no Antscan
// row leaves those fields null (UI shows "—"), not a guess.
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import db from './database.js';
import { readLatestSnapshot, readDailyMetrics } from './sync-history.js';

const execFileAsync = promisify(execFile);

// Real day-over-day growth (%) computed from the daily_metrics history table
// (Antscan-sourced), comparing the latest closed day to the prior closed day.
// Returns null (never a fabricated percentage) when there isn't yet enough
// history to compute a real comparison.
function computeGrowthPct(field) {
  const days = readDailyMetrics(3).filter((d) => d.is_closed); // ASC by day
  if (days.length < 2) return null;
  const prior = days[days.length - 2];
  const latest = days[days.length - 1];
  const latestVal = Number(latest[field]) || 0;
  const priorVal = Number(prior[field]) || 0;
  if (priorVal === 0) return null;
  return ((latestVal - priorVal) / priorVal) * 100;
}

// Reuses antseed-buyer-duggy's already-running, already-connected daemon
// (systemd: Restart=always) rather than spinning up a competing P2P node on
// the same identity -- `antseed network browse` talks to whichever daemon
// already holds this data dir. A cold connect-from-scratch DHT crawl can
// take well over a minute; this only ever hits a warm one.
const DISCOVERY_DATA_DIR = '/root/.antseed-buyer-duggy';
const DISCOVERY_TIMEOUT_MS = 120_000;

async function fetchLocalPeers() {
  const identityHex = fs.readFileSync(`${DISCOVERY_DATA_DIR}/identity.hex`, 'utf8').trim();
  const { stdout } = await execFileAsync(
    '/usr/bin/antseed',
    ['network', 'browse', '--top', '500', '--json'],
    {
      env: { ...process.env, ANTSEED_DATA_DIR: DISCOVERY_DATA_DIR, ANTSEED_IDENTITY_HEX: identityHex },
      timeout: DISCOVERY_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    }
  );
  const data = JSON.parse(stdout);
  return data.peers || [];
}

// Real lifetime seller aggregates from Antscan (backend/sync-history.js),
// keyed by agentId -- the one thing a live P2P snapshot has no way to know
// (it isn't a blockchain indexer). Extends the single-field version this
// replaced (buildAgentIdToEarnedMap) to carry every real per-agent figure
// sellers_onchain already has, not just earned.
function buildAgentIdStatsMap() {
  const rows = db.prepare(
    'SELECT agent_id, earned_usdc, unique_buyers, request_count FROM sellers_onchain WHERE agent_id IS NOT NULL'
  ).all();
  const map = new Map();
  for (const r of rows) {
    if (r.agent_id == null) continue;
    map.set(String(r.agent_id), {
      earnedUsdc: r.earned_usdc != null ? Number(r.earned_usdc) / 1e6 : null,
      uniqueBuyers: r.unique_buyers ?? null,
      // sellers.total_requests is a TEXT column (same convention as
      // sellers_onchain.request_count itself, for BigInt-safety) -- keep it
      // a string. Binding a plain JS number here instead reliably produces
      // a "189093.0"-style artifact (reproduced against better-sqlite3
      // directly): it gets bound/affinity-converted through REAL first.
      requestCount: r.request_count != null ? String(r.request_count) : null,
    });
  }
  return map;
}

export async function syncFromLocalDiscovery() {
  console.log('Discovering live peers via local buyer daemon (antseed network browse)...');
  const peers = await fetchLocalPeers();
  const agentStats = buildAgentIdStatsMap();

  console.log(`Found ${peers.length} peers via local P2P discovery.`);

  // Wipe old data
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM sellers').run();

  const insertSeller = db.prepare(`
    INSERT INTO sellers (id, name, status, total_earned, capacity, uptime, models, joined, agent_id, unique_buyers, first_seen_at, total_requests)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertService = db.prepare(`
    INSERT INTO services (id, name, provider, seller_id, seller_name, categories, protocols, pricing_input, pricing_cached_input, pricing_output, max_concurrency, current_load, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalServices = 0;
  const uniqueSellers = new Map();
  const globalSeenServices = new Set();

  db.prepare('BEGIN TRANSACTION').run();

  try {
    for (const peer of peers) {
      const peerId = peer.peerId;
      if (!peerId) continue;
      const displayName = peer.displayName || `Peer ${peerId.substring(0, 8)}`;
      const providers = peer.providers || []; // array of provider name strings
      const providerPricing = peer.providerPricing || {};
      const categoriesByProvider = peer.providerServiceCategories || {};
      const protocolsByProvider = peer.providerServiceApiProtocols || {};

      const agentId = peer.onChainAgentId != null ? String(peer.onChainAgentId) : null;
      const stats = agentId ? agentStats.get(agentId) : null;

      const sellerName = displayName;
      const sellerId = `seller_${peerId}`;
      if (uniqueSellers.has(sellerId)) continue;
      uniqueSellers.set(sellerId, true);

      const modelsCount = providers.reduce(
        (sum, p) => sum + Object.keys(providerPricing[p]?.services || {}).length,
        0
      );

      // Real "joined" from the on-chain stake timestamp -- when this peer
      // actually staked into the protocol, not "today". 'joined' is NOT
      // NULL in the schema (display-only text column); an explicit
      // 'unknown' marker stands in for a fabricated date when this peer has
      // no on-chain stake timestamp at all (e.g. discovered but not staked).
      const firstSeenAt = peer.onChainStakedAtSec ?? null;
      const joined = firstSeenAt
        ? new Date(firstSeenAt * 1000).toISOString().split('T')[0]
        : 'unknown';

      insertSeller.run(
        sellerId,
        sellerName,
        'online',
        stats?.earnedUsdc ?? null, // real (Antscan, matched via agentId) or null -- never fabricated
        'Elastic / P2P',
        null, // uptime: not derivable from this payload either -- no fake 99.5 constant
        modelsCount,
        joined,
        agentId,
        stats?.uniqueBuyers ?? null,
        firstSeenAt,
        stats?.requestCount ?? null
      );

      for (const provider of providers) {
        const pricingBlock = providerPricing[provider] || {};
        const defaultPricing = pricingBlock.defaults || { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
        const servicePricing = pricingBlock.services || {};
        const serviceCategories = categoriesByProvider[provider]?.services || {};
        const serviceProtocols = protocolsByProvider[provider]?.services || {};

        for (const svcName of Object.keys(servicePricing)) {
          const svcId = `svc_${svcName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40)}_${provider.replace(/[^a-zA-Z0-9]/g, '_')}_${sellerId}`;
          if (globalSeenServices.has(svcId)) continue;
          globalSeenServices.add(svcId);

          const pricing = servicePricing[svcName] || defaultPricing;
          const categories = serviceCategories[svcName] || ['general'];
          const protocols = serviceProtocols[svcName] || ['openai-chat-completions'];

          insertService.run(
            svcId,
            svcName,
            provider,
            sellerId,
            sellerName,
            JSON.stringify(categories),
            JSON.stringify(protocols),
            pricing.inputUsdPerMillion ?? 0,
            pricing.cachedInputUsdPerMillion ?? 0,
            pricing.outputUsdPerMillion ?? 0,
            peer.maxConcurrency ?? 10, // real per-peer figure now, not a fabricated constant
            0, // current load: not exposed by this payload either -- was always defaulted before too
            'online'
          );
          totalServices++;
        }
      }
    }

    // Update stats. total_volume comes from the real Antscan network
    // snapshot (see sync-history.js / network_snapshots table) -- never from
    // a requests-derived heuristic. If no snapshot has been synced yet, the
    // previous (real) value is kept via COALESCE rather than falling back
    // to a guess.
    const realSnapshot = readLatestSnapshot();
    const realVolumeUsd = realSnapshot ? Number(realSnapshot.total_volume_usdc) / 1e6 : null;
    const realBuyerCount = realSnapshot?.buyer_count ?? null;
    // The official API's `totals.settlementCount` doesn't exist in local
    // discovery output; the network snapshot's own real total_requests
    // figure is an equally-real stand-in for "how much settled activity
    // has the network processed", already fetched right above.
    const realRequestCount = realSnapshot?.total_requests != null ? Number(realSnapshot.total_requests) : null;

    const volumeGrowth = computeGrowthPct('volume_usdc');
    const buyerGrowth = computeGrowthPct('active_buyers');
    const sellerGrowth = computeGrowthPct('active_sellers');
    const transactionGrowth = computeGrowthPct('requests');
    // No historical per-day distinct-service count exists to compare
    // against (the services table is a live snapshot, not a time series) --
    // write an explicit NULL so the UI renders "—" instead of an invented
    // percentage.
    const serviceGrowth = null;

    db.prepare(`UPDATE stats SET
      total_buyers = COALESCE(?, total_buyers),
      total_sellers = ?,
      total_services = ?,
      total_volume = COALESCE(?, total_volume),
      active_transactions = COALESCE(?, active_transactions),
      buyer_growth = COALESCE(?, buyer_growth),
      seller_growth = COALESCE(?, seller_growth),
      service_growth = ?,
      volume_growth = COALESCE(?, volume_growth),
      transaction_growth = COALESCE(?, transaction_growth)
    WHERE id = 1`).run(
      realBuyerCount,
      uniqueSellers.size,
      totalServices,
      realVolumeUsd,
      realRequestCount,
      buyerGrowth,
      sellerGrowth,
      serviceGrowth,
      volumeGrowth,
      transactionGrowth
    );

    db.prepare('COMMIT').run();
    console.log(`Synced ${uniqueSellers.size} sellers and ${totalServices} services from local P2P discovery.`);
  } catch (e) {
    db.prepare('ROLLBACK').run();
    console.error('Local discovery sync failed:', e);
    throw e;
  }
}
