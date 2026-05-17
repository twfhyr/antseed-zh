import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './database.js';
import { syncFromOfficialNetwork } from './sync-official.js';
import { readChainMetrics, updateChainMetrics, startChainPoller } from './chain-poller.js';
import { EmissionsClient, ANTSTokenClient, DepositsClient, resolveChainConfig } from '@antseed/node';

const PROVIDER_BASE = process.env.PROVIDER_BASE_URL || 'http://localhost:8377/v1';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ─── Snake-case to camelCase helpers ───
function toCamelCase(str) {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function camelize(obj) {
  const result = {};
  for (const key of Object.keys(obj)) {
    result[toCamelCase(key)] = obj[key];
  }
  return result;
}

function parseService(row) {
  const r = camelize(row);
  return {
    ...r,
    categories: JSON.parse(row.categories),
    protocols: JSON.parse(row.protocols),
    pricing: {
      inputUsdPerMillion: row.pricing_input,
      cachedInputUsdPerMillion: row.pricing_cached_input,
      outputUsdPerMillion: row.pricing_output,
    },
  };
}

// ─── Stats ───
app.get('/api/provider/models', async (_req, res) => {
  try {
    const r = await fetch(`${PROVIDER_BASE}/models`);
    if (!r.ok) throw new Error(`Provider returned ${r.status}`);
    const json = await r.json();
    res.json(json.data || []);
  } catch (e) {
    res.status(502).json({ error: `Failed to fetch models from provider: ${e.message}` });
  }
});

// ─── Stats ───
app.get('/api/stats', (_req, res) => {
  const row = db.prepare('SELECT * FROM stats WHERE id = 1').get();
  if (!row) return res.status(404).json({ error: 'Stats not found' });
  res.json({
    totalBuyers: row.total_buyers,
    totalSellers: row.total_sellers,
    totalServices: row.total_services,
    totalVolume: row.total_volume,
    activeTransactions: row.active_transactions,
    buyerGrowth: row.buyer_growth,
    sellerGrowth: row.seller_growth,
    serviceGrowth: row.service_growth,
    volumeGrowth: row.volume_growth,
    transactionGrowth: row.transaction_growth,
  });
});

app.put('/api/stats', (req, res) => {
  const {
    totalBuyers, totalSellers, totalServices, totalVolume,
    activeTransactions, buyerGrowth, sellerGrowth, serviceGrowth,
    volumeGrowth, transactionGrowth,
  } = req.body;

  const result = db.prepare(`
    UPDATE stats SET
      total_buyers = COALESCE(?, total_buyers),
      total_sellers = COALESCE(?, total_sellers),
      total_services = COALESCE(?, total_services),
      total_volume = COALESCE(?, total_volume),
      active_transactions = COALESCE(?, active_transactions),
      buyer_growth = COALESCE(?, buyer_growth),
      seller_growth = COALESCE(?, seller_growth),
      service_growth = COALESCE(?, service_growth),
      volume_growth = COALESCE(?, volume_growth),
      transaction_growth = COALESCE(?, transaction_growth)
    WHERE id = 1
  `).run(
    totalBuyers, totalSellers, totalServices, totalVolume,
    activeTransactions, buyerGrowth, sellerGrowth, serviceGrowth,
    volumeGrowth, transactionGrowth
  );

  res.json({ updated: result.changes });
});

// ─── Buyers ───
app.get('/api/buyers', (_req, res) => {
  const rows = db.prepare('SELECT * FROM buyers').all();
  res.json(rows.map(camelize));
});

app.get('/api/buyers/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM buyers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Buyer not found' });
  res.json(camelize(row));
});

app.post('/api/buyers', (req, res) => {
  const { id, name, status, totalSpent, requests, avgLatency, joined } = req.body;
  const result = db.prepare(`
    INSERT INTO buyers (id, name, status, total_spent, requests, avg_latency, joined)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, status, totalSpent ?? 0, requests ?? 0, avgLatency ?? 0, joined);
  res.status(201).json({ id: result.lastInsertRowid });
});

app.put('/api/buyers/:id', (req, res) => {
  const { name, status, totalSpent, requests, avgLatency, joined } = req.body;
  const result = db.prepare(`
    UPDATE buyers SET
      name = COALESCE(?, name),
      status = COALESCE(?, status),
      total_spent = COALESCE(?, total_spent),
      requests = COALESCE(?, requests),
      avg_latency = COALESCE(?, avg_latency),
      joined = COALESCE(?, joined)
    WHERE id = ?
  `).run(name, status, totalSpent, requests, avgLatency, joined, req.params.id);
  res.json({ updated: result.changes });
});

app.delete('/api/buyers/:id', (req, res) => {
  const result = db.prepare('DELETE FROM buyers WHERE id = ?').run(req.params.id);
  res.json({ deleted: result.changes });
});

// ─── Sellers ───
app.get('/api/sellers', (_req, res) => {
  const rows = db.prepare('SELECT * FROM sellers').all();
  res.json(rows.map(camelize));
});

app.get('/api/sellers/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM sellers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Seller not found' });
  res.json(camelize(row));
});

app.post('/api/sellers', (req, res) => {
  const { id, name, status, totalEarned, capacity, uptime, models, joined } = req.body;
  const result = db.prepare(`
    INSERT INTO sellers (id, name, status, total_earned, capacity, uptime, models, joined)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, status, totalEarned ?? 0, capacity, uptime ?? 0, models ?? 0, joined);
  res.status(201).json({ id: result.lastInsertRowid });
});

app.put('/api/sellers/:id', (req, res) => {
  const { name, status, totalEarned, capacity, uptime, models, joined } = req.body;
  const result = db.prepare(`
    UPDATE sellers SET
      name = COALESCE(?, name),
      status = COALESCE(?, status),
      total_earned = COALESCE(?, total_earned),
      capacity = COALESCE(?, capacity),
      uptime = COALESCE(?, uptime),
      models = COALESCE(?, models),
      joined = COALESCE(?, joined)
    WHERE id = ?
  `).run(name, status, totalEarned, capacity, uptime, models, joined, req.params.id);
  res.json({ updated: result.changes });
});

app.delete('/api/sellers/:id', (req, res) => {
  const result = db.prepare('DELETE FROM sellers WHERE id = ?').run(req.params.id);
  res.json({ deleted: result.changes });
});

// ─── Services ───
app.get('/api/services', (_req, res) => {
  const rows = db.prepare('SELECT * FROM services').all();
  res.json(rows.map(parseService));
});

app.get('/api/services/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Service not found' });
  res.json(parseService(row));
});

app.post('/api/services', (req, res) => {
  const {
    id, name, provider, sellerId, sellerName,
    categories, protocols,
    pricing, maxConcurrency, currentLoad, status,
  } = req.body;
  const result = db.prepare(`
    INSERT INTO services (id, name, provider, seller_id, seller_name, categories, protocols, pricing_input, pricing_cached_input, pricing_output, max_concurrency, current_load, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, name, provider, sellerId, sellerName,
    JSON.stringify(categories), JSON.stringify(protocols),
    pricing?.inputUsdPerMillion ?? 0,
    pricing?.cachedInputUsdPerMillion ?? 0,
    pricing?.outputUsdPerMillion ?? 0,
    maxConcurrency ?? 0, currentLoad ?? 0, status
  );
  res.status(201).json({ id: result.lastInsertRowid });
});

app.put('/api/services/:id', (req, res) => {
  const {
    name, provider, sellerId, sellerName,
    categories, protocols,
    pricing, maxConcurrency, currentLoad, status,
  } = req.body;
  const result = db.prepare(`
    UPDATE services SET
      name = COALESCE(?, name),
      provider = COALESCE(?, provider),
      seller_id = COALESCE(?, seller_id),
      seller_name = COALESCE(?, seller_name),
      categories = COALESCE(?, categories),
      protocols = COALESCE(?, protocols),
      pricing_input = COALESCE(?, pricing_input),
      pricing_cached_input = COALESCE(?, pricing_cached_input),
      pricing_output = COALESCE(?, pricing_output),
      max_concurrency = COALESCE(?, max_concurrency),
      current_load = COALESCE(?, current_load),
      status = COALESCE(?, status)
    WHERE id = ?
  `).run(
    name, provider, sellerId, sellerName,
    categories ? JSON.stringify(categories) : null,
    protocols ? JSON.stringify(protocols) : null,
    pricing?.inputUsdPerMillion ?? null,
    pricing?.cachedInputUsdPerMillion ?? null,
    pricing?.outputUsdPerMillion ?? null,
    maxConcurrency, currentLoad, status,
    req.params.id
  );
  res.json({ updated: result.changes });
});

app.delete('/api/services/:id', (req, res) => {
  const result = db.prepare('DELETE FROM services WHERE id = ?').run(req.params.id);
  res.json({ deleted: result.changes });
});

// ─── Computed stats for live updates ───
app.get('/api/computed-stats', (_req, res) => {
  const buyerCount = db.prepare('SELECT COUNT(*) as c FROM buyers').get().c;
  const sellerCount = db.prepare('SELECT COUNT(*) as c FROM sellers').get().c;
  const serviceCount = db.prepare('SELECT COUNT(*) as c FROM services').get().c;
  const totalVolume = db.prepare('SELECT SUM(total_spent) as s FROM buyers').get().s ?? 0;
  res.json({
    totalBuyers: buyerCount,
    totalSellers: sellerCount,
    totalServices: serviceCount,
    totalVolume,
  });
});

app.get('/api/chain-stats', (_req, res) => {
  const data = readChainMetrics();
  if (!data) {
    return res.status(503).json({ error: 'Chain metrics not yet available. Wait for the next poller cycle.' });
  }
  res.json(data);
});

app.post('/api/admin/force-chain-sync', async (_req, res) => {
  try {
    const data = await updateChainMetrics();
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/sync', async (_req, res) => {
  try {
    await syncFromOfficialNetwork();
    res.json({ success: true, message: 'Synced from official network' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

const EMISSIONS_V1_ADDRESS = '0x36877fBa8Fa333aa46a1c57b66D132E4995C86b5';
const MIGRATION_EPOCH = 4;

const emissionsCfg = resolveChainConfig('base-mainnet');
const emissionsClient = new EmissionsClient({
  rpcUrl: emissionsCfg.rpcUrl,
  fallbackRpcUrls: emissionsCfg.fallbackRpcUrls,
  contractAddress: emissionsCfg.emissionsContractAddress,
  evmChainId: emissionsCfg.evmChainId,
});

const emissionsV1Client = new EmissionsClient({
  rpcUrl: emissionsCfg.rpcUrl,
  fallbackRpcUrls: emissionsCfg.fallbackRpcUrls,
  contractAddress: EMISSIONS_V1_ADDRESS,
  evmChainId: emissionsCfg.evmChainId,
});

const antsTokenClient = new ANTSTokenClient({
rpcUrl: emissionsCfg.rpcUrl,
fallbackRpcUrls: emissionsCfg.fallbackRpcUrls,
contractAddress: emissionsCfg.antsTokenAddress,
evmChainId: emissionsCfg.evmChainId,
});

const depositsClient = new DepositsClient({
rpcUrl: emissionsCfg.rpcUrl,
fallbackRpcUrls: emissionsCfg.fallbackRpcUrls,
contractAddress: emissionsCfg.depositsContractAddress,
evmChainId: emissionsCfg.evmChainId,
});

app.get('/api/deposits/config', (_req, res) => {
res.json({
chainId: 'base-mainnet',
evmChainId: emissionsCfg.evmChainId,
rpcUrl: emissionsCfg.rpcUrl,
depositsContractAddress: emissionsCfg.depositsContractAddress,
channelsContractAddress: emissionsCfg.channelsContractAddress,
usdcContractAddress: emissionsCfg.usdcContractAddress,
emissionsContractAddress: emissionsCfg.emissionsContractAddress,
antsTokenAddress: emissionsCfg.antsTokenAddress,
});
});

app.get('/api/deposits/balance', async (req, res) => {
try {
const address = req.query.address;
if (!address) return res.status(400).json({ error: 'address query param required' });
const bal = await depositsClient.getBuyerBalance(address);
const creditLimit = await depositsClient.getBuyerCreditLimit(address);
const available = Number(bal.available) / 1e6;
const reserved = Number(bal.reserved) / 1e6;
res.json({
evmAddress: address,
available: available.toFixed(2),
reserved: reserved.toFixed(2),
total: (available + reserved).toFixed(2),
creditLimit: (Number(creditLimit) / 1e6).toFixed(2),
});
} catch (e) {
res.status(500).json({ error: e.message });
}
});

app.get('/api/deposits/operator', async (req, res) => {
try {
const address = req.query.address;
if (!address) return res.status(400).json({ error: 'address query param required' });
const operator = await depositsClient.getOperator(address);
res.json({ operator });
} catch (e) {
res.status(500).json({ error: e.message });
}
});

app.get('/api/channels', async (_req, res) => {
try {
const url = `${PROVIDER_BASE.replace(/\/v1$/, '')}/v1/_antseed/channels?all=1`;
const resp = await fetch(url);
if (!resp.ok) return res.json({ channels: [] });
const body = await resp.json();
res.json({ channels: body.channels ?? [] });
} catch (e) {
res.json({ channels: [] });
}
});

app.get('/api/buyer-usage', async (_req, res) => {
try {
const url = `${PROVIDER_BASE.replace(/\/v1$/, '')}/v1/_antseed/buyer-usage`;
const resp = await fetch(url);
if (!resp.ok) return res.json({
totalRequests: 0, totalInputTokens: '0', totalOutputTokens: '0',
totalSettlements: 0, uniqueSellers: 0, activeChannels: 0, channels: [],
});
const body = await resp.json();
res.json(body.totals ?? {
totalRequests: 0, totalInputTokens: '0', totalOutputTokens: '0',
totalSettlements: 0, uniqueSellers: 0, activeChannels: 0, channels: [],
});
} catch (e) {
res.json({
totalRequests: 0, totalInputTokens: '0', totalOutputTokens: '0',
totalSettlements: 0, uniqueSellers: 0, activeChannels: 0, channels: [],
});
}
});

app.get('/api/network-stats', async (_req, res) => {
try {
const statsUrl = emissionsCfg.networkStatsUrl;
if (!statsUrl) return res.json({ totals: { activePeers: 0, totalRequests: '0', totalInputTokens: '0', totalOutputTokens: '0', totalSettlements: 0 } });
const resp = await fetch(`${statsUrl.replace(/\/$/, '')}/stats`);
if (!resp.ok) throw new Error(`network-stats returned ${resp.status}`);
const body = await resp.json();
const peers = Array.isArray(body.peers) ? body.peers : [];
const activePeers = peers.filter(p => p.onChainStats).length;
if (body.totals) {
return res.json({
totals: {
activePeers,
totalRequests: body.totals.totalRequests ?? '0',
totalInputTokens: body.totals.totalInputTokens ?? '0',
totalOutputTokens: body.totals.totalOutputTokens ?? '0',
totalSettlements: Number(body.totals.settlementCount ?? 0),
...(typeof body.totals.sellerCount === 'number' ? { sellerCount: body.totals.sellerCount } : {}),
},
});
}
let totalRequests = 0n, totalInputTokens = 0n, totalOutputTokens = 0n, totalSettlements = 0;
for (const peer of peers) {
const s = peer.onChainStats;
if (!s) continue;
try { totalRequests += BigInt(s.totalRequests ?? '0'); } catch {}
try { totalInputTokens += BigInt(s.totalInputTokens ?? '0'); } catch {}
try { totalOutputTokens += BigInt(s.totalOutputTokens ?? '0'); } catch {}
totalSettlements += Number(s.settlementCount ?? 0);
}
res.json({
totals: { activePeers, totalRequests: totalRequests.toString(), totalInputTokens: totalInputTokens.toString(), totalOutputTokens: totalOutputTokens.toString(), totalSettlements },
});
} catch (e) {
res.status(500).json({ error: e.message });
}
});

app.get('/api/emissions/epoch-info', async (_req, res) => {
  try {
    const [epochInfo, shares] = await Promise.all([
      emissionsClient.getEpochInfo(),
      emissionsClient.getShares(),
    ]);
    res.json({
      currentEpoch: epochInfo.epoch,
      currentEmission: Number(epochInfo.emission) / 1e18,
      epochDuration: epochInfo.epochDuration,
      shares,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/emissions/pending', async (req, res) => {
 try {
 const rawAddress = req.query.address;
 const extraAddresses = req.query.buyer_addresses ? req.query.buyer_addresses.split(',').map(a => a.trim()).filter(Boolean) : [];
 const epochs = req.query.epochs ? req.query.epochs.split(',').map(Number) : [];
 if (!rawAddress) return res.status(400).json({ error: 'address query param required' });
 if (epochs.length === 0) return res.json({ seller: '0', buyer: '0', epochs: [] });

 const bustCache = req.query.bust === '1';
 const cacheKey = rawAddress.toLowerCase() + (extraAddresses.length ? ':' + extraAddresses.join(',') : '');
 const cached = bustCache ? null : db.prepare('SELECT data FROM address_emissions WHERE address = ?').get(cacheKey);
 if (cached) {
 return res.json(JSON.parse(cached.data));
 }

 const dbBuyers = db.prepare('SELECT buyer FROM operator_buyers WHERE operator = ?').all(rawAddress.toLowerCase());
 const dbBuyerAddresses = dbBuyers.map(r => r.buyer);
 const allAddresses = [rawAddress, ...extraAddresses, ...dbBuyerAddresses.filter(a => !extraAddresses.includes(a) && a !== rawAddress)];
 const uniqueAddresses = [...new Set(allAddresses.map(a => a.toLowerCase()))];
 const epochInfo = await emissionsClient.getEpochInfo();
 const currentEpoch = Number(epochInfo.epoch);
 const epochDetails = [];
 let sellerTotal = 0;
 let buyerTotal = 0;

 for (const epoch of epochs) {
 const isCurrent = epoch >= currentEpoch;
 let epochSellerPts = 0;
 let epochBuyerPts = 0;
 let epochSellerReward = 0;
 let epochBuyerReward = 0;
 let epochSellerClaimed = false;
 let epochBuyerClaimed = false;

        for (const addr of uniqueAddresses) {
          const [sp, bp, esp, ebp, sc, bc, epochEmission] = await Promise.all([
            emissionsClient.userSellerPoints(addr, epoch),
            emissionsClient.userBuyerPoints(addr, epoch),
            emissionsClient.epochTotalSellerPoints(epoch),
            emissionsClient.epochTotalBuyerPoints(epoch),
            emissionsClient.sellerEpochClaimed(addr, epoch),
            emissionsClient.buyerEpochClaimed(addr, epoch),
            emissionsClient.getEpochEmission(epoch),
          ]);

          let v1SellerPts = 0;
          let v1BuyerPts = 0;
          let v1TotalSellerPts = 0;
          let v1TotalBuyerPts = 0;
          if (epoch <= MIGRATION_EPOCH) {
            const [v1sp, v1bp, v1esp, v1ebp] = await Promise.all([
              emissionsV1Client.userSellerPoints(addr, epoch),
              emissionsV1Client.userBuyerPoints(addr, epoch),
              emissionsV1Client.epochTotalSellerPoints(epoch),
              emissionsV1Client.epochTotalBuyerPoints(epoch),
            ]);
            v1SellerPts = Number(v1sp);
            v1BuyerPts = Number(v1bp);
            v1TotalSellerPts = Number(v1esp);
            v1TotalBuyerPts = Number(v1ebp);

            if (epoch < MIGRATION_EPOCH) {
              const v1sc = await emissionsV1Client.sellerEpochClaimed(addr, epoch);
              const v1bc = await emissionsV1Client.buyerEpochClaimed(addr, epoch);
              if (v1sc) epochSellerClaimed = true;
              if (v1bc) epochBuyerClaimed = true;
            }
          }

          const userSellerPts = Number(sp) + v1SellerPts;
          const userBuyerPts = Number(bp) + v1BuyerPts;
          const totalSellerPts = Number(esp) + v1TotalSellerPts;
          const totalBuyerPts = Number(ebp) + v1TotalBuyerPts;
          const emission = Number(epochEmission) / 1e18;

          if (userSellerPts > 0 || userBuyerPts > 0) {
            epochSellerPts += userSellerPts;
            epochBuyerPts += userBuyerPts;

            if (isCurrent) {
              epochSellerReward += totalSellerPts > 0 ? (userSellerPts / totalSellerPts) * emission * 0.5 : 0;
              epochBuyerReward += totalBuyerPts > 0 ? (userBuyerPts / totalBuyerPts) * emission * 0.2 : 0;
            } else {
              const pending = await emissionsClient.pendingEmissions(addr, [epoch]);
              epochSellerReward += Number(pending.seller) / 1e18;
              epochBuyerReward += Number(pending.buyer) / 1e18;
              if (epoch <= MIGRATION_EPOCH) {
                const v1Pending = await emissionsV1Client.pendingEmissions(addr, [epoch]);
                epochSellerReward += Number(v1Pending.seller) / 1e18;
                epochBuyerReward += Number(v1Pending.buyer) / 1e18;
              }
            }
          }
          if (sc) epochSellerClaimed = true;
          if (bc) epochBuyerClaimed = true;
        }

 epochDetails.push({
 epoch,
 sellerPoints: epochSellerPts,
 buyerPoints: epochBuyerPts,
 sellerReward: epochSellerReward,
 buyerReward: epochBuyerReward,
 sellerClaimed: epochSellerClaimed,
 buyerClaimed: epochBuyerClaimed,
 isCurrentEpoch: isCurrent,
 });
 }

      for (const addr of uniqueAddresses) {
        const pending = await emissionsClient.pendingEmissions(addr, epochs);
        sellerTotal += Number(pending.seller) / 1e18;
        buyerTotal += Number(pending.buyer) / 1e18;
        const v1Epochs = epochs.filter(e => e <= MIGRATION_EPOCH);
        if (v1Epochs.length > 0) {
          const v1Pending = await emissionsV1Client.pendingEmissions(addr, v1Epochs);
          sellerTotal += Number(v1Pending.seller) / 1e18;
          buyerTotal += Number(v1Pending.buyer) / 1e18;
        }
      }

 const data = {
 seller: sellerTotal.toFixed(6),
 buyer: buyerTotal.toFixed(6),
 epochs: epochDetails,
 };

 db.prepare('INSERT OR REPLACE INTO address_emissions (address, data, fetched_at) VALUES (?, ?, ?)').run(
 cacheKey,
 JSON.stringify(data),
 Date.now()
 );

 res.json(data);
 } catch (e) {
 res.status(500).json({ error: e.message });
 }
});

app.get('/api/operator-buyers', (req, res) => {
 try {
 const operator = req.query.operator;
 if (operator) {
 const rows = db.prepare('SELECT operator, buyer FROM operator_buyers WHERE operator = ?').all(operator.toLowerCase());
 return res.json(rows);
 }
 const rows = db.prepare('SELECT operator, buyer FROM operator_buyers').all();
 res.json(rows);
 } catch (e) {
 res.status(500).json({ error: e.message });
 }
});

app.post('/api/operator-buyers', (req, res) => {
 try {
 const { operator, buyer } = req.body;
 if (!operator || !buyer) return res.status(400).json({ error: 'operator and buyer required' });
 if (!/^0x[a-fA-F0-9]{40}$/.test(operator) || !/^0x[a-fA-F0-9]{40}$/.test(buyer)) {
 return res.status(400).json({ error: 'invalid address format' });
 }
 db.prepare('INSERT OR IGNORE INTO operator_buyers (operator, buyer) VALUES (?, ?)').run(operator.toLowerCase(), buyer.toLowerCase());
 res.json({ ok: true });
 } catch (e) {
 res.status(500).json({ error: e.message });
 }
});

app.delete('/api/operator-buyers', (req, res) => {
 try {
 const { operator, buyer } = req.body;
 if (!operator || !buyer) return res.status(400).json({ error: 'operator and buyer required' });
 db.prepare('DELETE FROM operator_buyers WHERE operator = ? AND buyer = ?').run(operator.toLowerCase(), buyer.toLowerCase());
 res.json({ ok: true });
 } catch (e) {
 res.status(500).json({ error: e.message });
 }
});

app.get('/api/emissions/claimed', async (req, res) => {
  try {
    const address = req.query.address;
    const epochs = req.query.epochs ? req.query.epochs.split(',').map(Number) : [];
    if (!address) return res.status(400).json({ error: 'address query param required' });
    if (epochs.length === 0) return res.json({ seller: [], buyer: [] });

        const sellerStatuses = await Promise.all(
          epochs.map(e => emissionsClient.sellerEpochClaimed(address, e))
        );
        const buyerStatuses = await Promise.all(
          epochs.map(e => emissionsClient.buyerEpochClaimed(address, e))
        );

        const v1SellerStatuses = await Promise.all(
          epochs.filter(e => e < MIGRATION_EPOCH).map(e => emissionsV1Client.sellerEpochClaimed(address, e))
        );
        const v1BuyerStatuses = await Promise.all(
          epochs.filter(e => e < MIGRATION_EPOCH).map(e => emissionsV1Client.buyerEpochClaimed(address, e))
        );

        const v1EpochIndexes = {};
        epochs.filter(e => e < MIGRATION_EPOCH).forEach((e, i) => { v1EpochIndexes[e] = i; });

        res.json({
          seller: epochs.map((e, i) => ({
            epoch: e,
            claimed: sellerStatuses[i] || (v1EpochIndexes[e] !== undefined ? v1SellerStatuses[v1EpochIndexes[e]] : false),
          })),
          buyer: epochs.map((e, i) => ({
            epoch: e,
            claimed: buyerStatuses[i] || (v1EpochIndexes[e] !== undefined ? v1BuyerStatuses[v1EpochIndexes[e]] : false),
          })),
        });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/emissions/balance', async (req, res) => {
  try {
    const address = req.query.address;
    if (!address) return res.status(400).json({ error: 'address query param required' });

    const cached = db.prepare('SELECT ants FROM address_balances WHERE address = ?').get(address.toLowerCase());
    if (cached) {
      return res.json({ ants: cached.ants });
    }

    const balance = await antsTokenClient.balanceOf(address);
    const ants = Number(balance) / 1e18;

    db.prepare('INSERT OR REPLACE INTO address_balances (address, ants, fetched_at) VALUES (?, ?, ?)').run(
      address.toLowerCase(),
      ants,
      Date.now()
    );

    res.json({ ants });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname, '../dist')));

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`AntSeed Dashboard + API running on http://0.0.0.0:${PORT}`);
  // Sync real data from the official AntSeed network API
  await syncFromOfficialNetwork();
  // Start background poller for on-chain metrics (every 5 minutes)
  startChainPoller(300);
  console.log('Chain metrics poller started (refresh every 5 min).');
});
