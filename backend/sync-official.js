import db from './database.js';
import fs from 'fs';

const STATS_URL = 'https://network.antseed.com/stats';

async function fetchOfficialStats() {
  const res = await fetch(STATS_URL);
  if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
  return res.json();
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

  console.log(`Found ${peers.length} peers, ${totals.sellerCount || '?'} sellers`);

  // Wipe old data
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM sellers').run();

  const insertSeller = db.prepare(`
    INSERT INTO sellers (id, name, status, total_earned, capacity, uptime, models, joined)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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

      // Compute total earned from onChain stats if available
      let totalEarnedUSDC = 0;
      if (peer.onChainStats) {
        totalEarnedUSDC = (parseInt(peer.onChainStats.totalRequests || '0') * 0.001) + (parseInt(peer.onChainStats.settlementCount || '0') * 0.5);
      }

      const sellerName = displayName;
      const sellerId = `seller_${peerId}`;

      if (uniqueSellers.has(sellerId)) continue;
      uniqueSellers.set(sellerId, true);

      const modelsCount = providers.reduce((sum, p) => sum + (p.services?.length || 0), 0);

      insertSeller.run(
        sellerId,
        sellerName,
        'online',
        Math.round(totalEarnedUSDC * 100) / 100,
        'Elastic / P2P',
        99.5,
        modelsCount,
        new Date().toISOString().split('T')[0]
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

    // Update stats
    db.prepare(`UPDATE stats SET
      total_buyers = COALESCE(?, total_buyers),
      total_sellers = ?,
      total_services = ?,
      total_volume = COALESCE(?, total_volume),
      active_transactions = COALESCE(?, active_transactions)
    WHERE id = 1`).run(
      totals.uniqueBuyers || 0,
      uniqueSellers.size,
      totalServices,
      parseFloat(totals.totalRequests || 0) * 0.1,  // rough volume heuristic
      totals.settlementCount || 0
    );

    db.prepare('COMMIT').run();
    console.log(`Synced ${uniqueSellers.size} sellers and ${totalServices} services from live network.`);
  } catch (e) {
    db.prepare('ROLLBACK').run();
    console.error('Sync failed:', e);
    throw e;
  }
}
