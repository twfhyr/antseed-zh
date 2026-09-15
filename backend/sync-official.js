import db from './database.js';
import fs from 'fs';
import { readLatestSnapshot, readDailyMetrics } from './sync-history.js';

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

const STATS_URL = 'https://network.antseed.com/stats';

async function fetchOfficialStats() {
  const res = await fetch(STATS_URL);
  if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
  return res.json();
}

// Real on-chain "earned" lookup: matches a peer's onChainStats.agentId to the
// sellers_onchain table (populated from Antscan's real earnedUsdc) by agentId.
// Returns null (never a fabricated number) when no match is found, so the UI
// can show "on-chain data unavailable" instead of a guessed figure.
function buildAgentIdToEarnedMap() {
  const rows = db.prepare('SELECT agent_id, earned_usdc FROM sellers_onchain WHERE agent_id IS NOT NULL').all();
  const map = new Map();
  for (const r of rows) {
    if (r.agent_id != null) map.set(String(r.agent_id), Number(r.earned_usdc) / 1e6);
  }
  return map;
}

export async function syncFromOfficialNetwork() {
  console.log('Fetching official AntSeed network data...');
  let data;
  try {
    data = await fetchOfficialStats();
  } catch (e) {
    console.error('Network fetch failed, trying local cache...');
    const local = fs.readFileSync('/tmp/antseed_stats.json', 'utf8');
    data = JSON.parse(local);
  }

  const peers = data.peers || [];
  const totals = data.totals || {};
  const agentEarnedMap = buildAgentIdToEarnedMap();

  console.log(`Found ${peers.length} peers, ${totals.sellerCount || '?'} sellers`);

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
  let uniqueSellers = new Map();
  let globalSeenServices = new Set();

  db.prepare('BEGIN TRANSACTION').run();

  try {
    for (const peer of peers) {
      const peerId = peer.peerId || peer.displayName?.toLowerCase().replace(/\s+/g, '-');
      const displayName = peer.displayName || `Peer ${peerId?.substring(0, 8)}`;
      const providers = peer.providers || [];
      const onChainStats = peer.onChainStats || null;

      // Real on-chain earned USDC, matched by agentId to Antscan's sellers
      // table (see sync-history.js). No fabricated formula: if we can't
      // resolve an agentId match, totalEarned stays null (UI shows "—"),
      // never a guessed number.
      const agentId = onChainStats?.agentId != null ? String(onChainStats.agentId) : null;
      const totalEarnedUSDC = agentId && agentEarnedMap.has(agentId) ? agentEarnedMap.get(agentId) : null;

      const sellerName = displayName;
      const sellerId = `seller_${peerId}`;

      if (uniqueSellers.has(sellerId)) continue;
      uniqueSellers.set(sellerId, true);

      const modelsCount = providers.reduce((sum, p) => sum + (p.services?.length || 0), 0);

      // Real first-seen from on-chain stats (first settlement), not "today".
      // 'joined' is NOT NULL in schema (display-only text column); use an
      // explicit 'unknown' marker instead of a fabricated date when we have
      // no real on-chain first-seen timestamp for this peer.
      const firstSeenAt = onChainStats?.firstSeenAt ?? null;
      const joined = firstSeenAt
        ? new Date(firstSeenAt * 1000).toISOString().split('T')[0]
        : 'unknown';

      insertSeller.run(
        sellerId,
        sellerName,
        'online',
        totalEarnedUSDC, // real (matched via agentId) or null — never fabricated
        'Elastic / P2P',
        null, // uptime: not derivable from this payload — no fake 99.5 constant
        modelsCount,
        joined,
        agentId,
        onChainStats?.uniqueBuyers ?? null,
        firstSeenAt,
        onChainStats?.totalRequests ?? null
      );

      for (const provider of providers) {
        const providerName = provider.provider || 'unknown';
        const services = provider.services || [];
        const defaultPricing = provider.defaultPricing || { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
        const servicePricing = provider.servicePricing || {};
        const serviceCategories = provider.serviceCategories || {};
        const serviceProtocols = provider.serviceApiProtocols || {};
        const maxConcurrency = provider.maxConcurrency || 10;
        const currentLoad = provider.currentLoad || 0;

        for (const svcName of services) {
          const svcId = `svc_${svcName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40)}_${providerName.replace(/[^a-zA-Z0-9]/g, '_')}_${sellerId}`;
          if (globalSeenServices.has(svcId)) continue;
          globalSeenServices.add(svcId);

          const pricing = servicePricing[svcName] || defaultPricing;
          const categories = serviceCategories[svcName] || ['general'];
          const protocols = serviceProtocols[svcName] || ['openai-chat-completions'];

          insertService.run(
            svcId,
            svcName,
            providerName,
            sellerId,
            sellerName,
            JSON.stringify(categories),
            JSON.stringify(protocols),
            pricing.inputUsdPerMillion ?? 0,
            pricing.cachedInputUsdPerMillion ?? 0,
            pricing.outputUsdPerMillion ?? 0,
            maxConcurrency,
            currentLoad,
            'online'
          );
          totalServices++;
        }
      }
    }

    // Update stats. total_volume comes from the real Antscan network
    // snapshot (see sync-history.js / network_snapshots table) — never from
    // a requests-derived heuristic. If no snapshot has been synced yet, the
    // previous (real) value is kept via COALESCE rather than falling back
    // to a guess.
    const realSnapshot = readLatestSnapshot();
    const realVolumeUsd = realSnapshot ? Number(realSnapshot.total_volume_usdc) / 1e6 : null;
    const realBuyerCount = realSnapshot?.buyer_count ?? null;

    // Real day-over-day growth from the daily_metrics history table, not the
    // hardcoded seed values (12.5/8.3/18.7/23.7/15.2) this row was created
    // with. null values leave the previous (real) figure via COALESCE rather
    // than reverting to a guess.
    const volumeGrowth = computeGrowthPct('volume_usdc');
    const buyerGrowth = computeGrowthPct('active_buyers');
    const sellerGrowth = computeGrowthPct('active_sellers');
    const transactionGrowth = computeGrowthPct('requests');
    // There is no historical services time series to compare against — the
    // services table is a live DHT snapshot, and Antscan exposes no
    // per-day/per-epoch distinct-service count (this is the same data gap
    // that kept services out of the Overview breakdown charts). This column
    // previously kept the fabricated seed value 18.7 forever, because it was
    // simply omitted from the UPDATE below. Write an explicit NULL so the UI
    // renders "—" instead of an invented percentage.
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
      totals.settlementCount || 0,
      buyerGrowth,
      sellerGrowth,
      serviceGrowth,
      volumeGrowth,
      transactionGrowth
    );

    db.prepare('COMMIT').run();
    console.log(`Synced ${uniqueSellers.size} sellers and ${totalServices} services from live network.`);
  } catch (e) {
    db.prepare('ROLLBACK').run();
    console.error('Sync failed:', e);
    throw e;
  }
}
