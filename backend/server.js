import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './database.js';
import { syncFromOfficialNetwork } from './sync-official.js';
import { readChainMetrics, updateChainMetrics, startChainPoller } from './chain-poller.js';
import {
  EmissionsClient, ANTSTokenClient, DepositsClient, RegistryClient, EmissionsGateClient,
  UsageAccountingClient, UsageRewardsClient, SellerPoolsClient, SellerPoolsRewardsClient,
  SellerRegistryClient, SellerRewardsPoolClient, StakingClient,
  resolveChainConfig, resolveLegacyContractAddresses, GATE_MINTERS, gateMinterId,
  previewPoolRewards, pendingEpochRewards,
} from '@antseed/node';

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

const EMISSIONS_V1_FALLBACK = '0x36877fBa8Fa333aa46a1c57b66D132E4995C86b5';
const MIGRATION_EPOCH = 4;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const emissionsCfg = resolveChainConfig('base-mainnet');
const legacyAddresses = resolveLegacyContractAddresses(emissionsCfg);

let buyerEvmAddress = null;
try {
const { identityFromPrivateKeyHex } = await import('@antseed/node');
const fs = await import('fs');
const path = await import('path');
const identityPath = path.join(process.env.HOME, '.antseed', 'identity.key');
const identityHex = process.env.ANTSEED_IDENTITY_HEX || fs.readFileSync(identityPath, 'utf8').trim();
const id = identityFromPrivateKeyHex(identityHex);
buyerEvmAddress = id.wallet.address;
console.log(`Buyer EVM address (from identity): ${buyerEvmAddress}`);
} catch (e) {
  console.warn('Could not load buyer identity:', e.message);
}

function evmClientConfig(contractAddress) {
  return {
    rpcUrl: emissionsCfg.rpcUrl,
    fallbackRpcUrls: emissionsCfg.fallbackRpcUrls,
    contractAddress,
    evmChainId: emissionsCfg.evmChainId,
  };
}

function sameAddress(a, b) {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

// Legacy emissions V2 — pre-migration points, claims, and epoch clock (epochs 0–21).
const emissionsClient = new EmissionsClient(evmClientConfig(legacyAddresses.legacyEmissionsContractAddress));

// Legacy emissions V1 — historical points for epochs before the V1→V2 migration.
const emissionsV1Client = new EmissionsClient(evmClientConfig(legacyAddresses.legacyEmissionsV1ContractAddress || EMISSIONS_V1_FALLBACK));

// Legacy USDC staking — seller eligibility fallback.
const legacyStakingClient = new StakingClient(evmClientConfig(legacyAddresses.legacyStakingContractAddress));

const antsTokenClient = new ANTSTokenClient(evmClientConfig(emissionsCfg.antsTokenAddress));

const depositsClient = new DepositsClient({
  rpcUrl: emissionsCfg.rpcUrl,
  fallbackRpcUrls: emissionsCfg.fallbackRpcUrls,
  contractAddress: emissionsCfg.depositsContractAddress,
  evmChainId: emissionsCfg.evmChainId,
});

const registryClient = new RegistryClient(evmClientConfig(emissionsCfg.registryContractAddress));

const recognizedUsage = emissionsCfg.recognizedUsage?.contracts ?? {};
const recognizedDeployed = !!(emissionsCfg.usageAccountingAddress && emissionsCfg.sellerRegistryAddress);

const emissionsGateClient = emissionsCfg.emissionsGateAddress
  ? new EmissionsGateClient(evmClientConfig(emissionsCfg.emissionsGateAddress))
  : null;
const usageAccountingClient = emissionsCfg.usageAccountingAddress
  ? new UsageAccountingClient(evmClientConfig(emissionsCfg.usageAccountingAddress))
  : null;
const usageRewardsClient = emissionsCfg.usageRewardsAddress
  ? new UsageRewardsClient(evmClientConfig(emissionsCfg.usageRewardsAddress))
  : null;
const sellerPoolsClient = emissionsCfg.sellerPoolsAddress
  ? new SellerPoolsClient(evmClientConfig(emissionsCfg.sellerPoolsAddress))
  : null;
const sellerPoolsRewardsClient = emissionsCfg.sellerPoolsRewardsAddress
  ? new SellerPoolsRewardsClient(evmClientConfig(emissionsCfg.sellerPoolsRewardsAddress))
  : null;
const sellerRegistryClient = emissionsCfg.sellerRegistryAddress
  ? new SellerRegistryClient(evmClientConfig(emissionsCfg.sellerRegistryAddress))
  : null;

// ─── Protocol phase + epoch ranges (recognized-usage era since epoch 22) ───
const STACK_TTL_MS = 60_000;
const PENDING_TTL_MS = 90_000;
// Concurrent epoch workers for the epoch fan-outs. Each worker makes its RPC
// calls sequentially, so total in-flight requests ≈ this number. Measured on
// the base-mainnet tenderly gateway: sustained bursts beyond ~30-40 in-flight
// get queued and start dying with request timeouts; 12 is comfortably safe.
const EPOCH_CONCURRENCY = 12;
let stackCache = null;

// RPC calls wrapped in safe() degrade to a fallback on failure. A transient
// gateway throttle (burst rate limiting) must not silently zero out reward
// numbers, so timeout-class errors get one retry before the fallback applies.
function isTransientRpcError(e) {
  return !e || typeof e !== 'object' ? false
    : e.code === 'TIMEOUT' || e.code === 'CALL_EXCEPTION' || e.code === 'SERVER_ERROR'
      || /timeout|rate limit|429|too many requests/i.test(e.message || '');
}

async function safe(read, fallback) {
  try {
    return await read();
  } catch (e) {
    if (isTransientRpcError(e)) {
      try {
        await new Promise((r) => setTimeout(r, 500));
        return await read();
      } catch { return fallback; }
    }
    return fallback;
  }
}

// strict() retries transient RPC failures once, then rethrows. Used for calls
// where a fallback would silently fabricate reward data — better to fail the
// request with a real error than display zeros that look legitimate.
async function strict(read) {
  try {
    return await read();
  } catch (e) {
    if (isTransientRpcError(e)) {
      await new Promise((r) => setTimeout(r, 750));
      return await read();
    }
    throw e;
  }
}

async function resolveStack() {
  if (stackCache && Date.now() - stackCache.resolvedAt < STACK_TTL_MS) return stackCache;

  const [registryEmissions, registryStaking] = await Promise.all([
    safe(() => registryClient.emissions(), null),
    safe(() => registryClient.staking(), null),
  ]);
  const active = recognizedDeployed
    && sameAddress(registryEmissions, emissionsCfg.usageAccountingAddress)
    && sameAddress(registryStaking, emissionsCfg.sellerRegistryAddress);
  const phase = active ? 'active' : recognizedDeployed ? 'deployed' : 'legacy';

  let currentEpoch = null;
  let effectiveEpoch = null;
  let genesis = null;
  let epochDuration = null;
  if (emissionsGateClient) {
    [currentEpoch, effectiveEpoch, genesis, epochDuration] = await Promise.all([
      safe(() => emissionsGateClient.currentEpoch(), null),
      active ? safe(() => emissionsGateClient.effectiveEpoch(), null) : Promise.resolve(null),
      safe(() => emissionsGateClient.genesis(), null),
      safe(() => emissionsGateClient.epochDuration(), null),
    ]);
  }
  if (currentEpoch === null) {
    const info = await safe(() => emissionsClient.getEpochInfo(), null);
    if (info) {
      currentEpoch = Number(info.epoch);
      epochDuration = info.epochDuration;
      genesis = await safe(() => emissionsClient.getGenesis(), null);
    }
  }

  const boundary = active && effectiveEpoch !== null ? Math.min(currentEpoch, effectiveEpoch) : currentEpoch;
  const legacyEpochs = boundary !== null ? Array.from({ length: Math.max(0, boundary) }, (_, epoch) => epoch) : [];
  const recognizedEpochs = active && effectiveEpoch !== null && currentEpoch !== null
    ? Array.from({ length: Math.max(0, currentEpoch - effectiveEpoch) }, (_, i) => effectiveEpoch + i)
    : [];

  const lockedRewardsPool = await safe(async () => {
    const pool = await emissionsClient.sellerRewardsPool();
    return sameAddress(pool, ZERO_ADDRESS) ? null : pool;
  }, null);
  const lockedPoolClient = lockedRewardsPool ? new SellerRewardsPoolClient(evmClientConfig(lockedRewardsPool)) : null;

  stackCache = {
    phase, currentEpoch, effectiveEpoch, genesis, epochDuration,
    legacyEpochs, recognizedEpochs,
    lockedRewardsPool, lockedPoolClient,
    resolvedAt: Date.now(),
  };
  return stackCache;
}

// Process items with a bounded number of concurrent workers.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}

// agentId binding is permanent once registered, so cache positive lookups in
// memory. Unregistered addresses keep resolving live so a later registration
// is picked up without a server restart.
const agentIdCache = new Map();
async function agentIdOf(address) {
  const key = address.toLowerCase();
  const cached = agentIdCache.get(key);
  if (cached !== undefined) return cached;
  let agentId = 0;
  if (sellerRegistryClient) {
    agentId = await safe(() => sellerRegistryClient.getAgentId(address), 0);
  }
  if (!agentId) {
    agentId = await safe(() => legacyStakingClient.getAgentId(address), 0);
  }
  if (agentId) agentIdCache.set(key, agentId);
  return agentId;
}

// Epoch-level totals (total points + emission) are address-independent: one
// closed epoch's numbers are identical for every lookup. Persist them in
// epoch_history and share across requests and addresses. Closed epochs are
// frozen on-chain (long TTL); the current epoch still accrues (short TTL, and
// anything cached while the epoch was current is dropped once it rolls over).
const EPOCH_TOTALS_KEY = '__epoch_totals__';
const EPOCH_TOTALS_CLOSED_TTL_MS = 6 * 60 * 60 * 1000;
const EPOCH_TOTALS_CURRENT_TTL_MS = 60 * 1000;
const epochTotalsGet = db.prepare('SELECT data FROM epoch_history WHERE address = ? AND epoch = ?');
const epochTotalsPut = db.prepare('INSERT OR REPLACE INTO epoch_history (address, epoch, data) VALUES (?, ?, ?)');

async function loadEpochTotals(epoch, currentEpoch) {
  const cached = epochTotalsGet.get(EPOCH_TOTALS_KEY, epoch);
  if (cached) {
    try {
      const parsed = JSON.parse(cached.data);
      const age = Date.now() - parsed.fetchedAt;
      if (parsed.wasCurrent) {
        if (epoch >= currentEpoch && age < EPOCH_TOTALS_CURRENT_TTL_MS) return parsed;
      } else if (epoch < currentEpoch && age < EPOCH_TOTALS_CLOSED_TTL_MS) {
        return parsed;
      }
    } catch { /* corrupt row — refetch below */ }
  }
  const esp = await strict(() => emissionsClient.epochTotalSellerPoints(epoch));
  const ebp = await strict(() => emissionsClient.epochTotalBuyerPoints(epoch));
  const emission = await strict(() => emissionsClient.getEpochEmission(epoch));
  const entry = {
    fetchedAt: Date.now(),
    wasCurrent: epoch >= currentEpoch,
    totalSellerPts: esp.toString(),
    totalBuyerPts: ebp.toString(),
    emission: emission.toString(),
  };
  epochTotalsPut.run(EPOCH_TOTALS_KEY, epoch, JSON.stringify(entry));
  return entry;
}

app.get('/api/deposits/config', (_req, res) => {
res.json({
chainId: 'base-mainnet',
evmChainId: emissionsCfg.evmChainId,
rpcUrl: emissionsCfg.rpcUrl,
depositsContractAddress: emissionsCfg.depositsContractAddress,
channelsContractAddress: emissionsCfg.channelsContractAddress,
usdcContractAddress: emissionsCfg.usdcContractAddress,
antsTokenAddress: emissionsCfg.antsTokenAddress,
legacyEmissionsContractAddress: legacyAddresses.legacyEmissionsContractAddress,
legacyStakingContractAddress: legacyAddresses.legacyStakingContractAddress,
emissionsGateAddress: emissionsCfg.emissionsGateAddress,
usageAccountingAddress: emissionsCfg.usageAccountingAddress,
usageRewardsAddress: emissionsCfg.usageRewardsAddress,
sellerPoolsAddress: emissionsCfg.sellerPoolsAddress,
sellerPoolsRewardsAddress: emissionsCfg.sellerPoolsRewardsAddress,
sellerRegistryAddress: emissionsCfg.sellerRegistryAddress,
evmAddress: buyerEvmAddress,
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
    const stack = await resolveStack();
    const [epochInfo, shares] = await Promise.all([
      emissionsClient.getEpochInfo(),
      emissionsClient.getShares().catch(() => null),
    ]);
    const allocation = [];
    if (emissionsGateClient) {
      const denominator = await emissionsGateClient.shareDenominator().catch(() => 0);
      for (const minter of GATE_MINTERS) {
        const info = await emissionsGateClient.minter(gateMinterId(minter.id)).catch(() => null);
        if (info) {
          allocation.push({
            name: minter.name,
            controller: info.controller,
            shareBps: info.shareBps,
            sharePct: denominator > 0 ? (info.shareBps / denominator) * 100 : null,
          });
        }
      }
    }
    res.json({
      currentEpoch: stack.currentEpoch ?? Number(epochInfo.epoch),
      currentEmission: Number(epochInfo.emission) / 1e18,
      epochDuration: epochInfo.epochDuration,
      genesis: stack.genesis,
      effectiveEpoch: stack.effectiveEpoch,
      phase: stack.phase,
      shares, // legacy-era shares (pre-epoch-22)
      allocation, // recognized-usage era ceilings (epoch 22+)
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
 // The cache key must include the epoch list — a row cached for one epoch set
 // used to be served for a different set. The 90s TTL bounds staleness after
 // claims made outside this dashboard (frontend reloads pass bust=1).
 const cacheKey = rawAddress.toLowerCase() + (extraAddresses.length ? ':' + extraAddresses.join(',') : '') + ':e=' + epochs.join(',');
 if (!bustCache) {
 const cached = db.prepare('SELECT data, fetched_at FROM address_emissions WHERE address = ?').get(cacheKey);
 if (cached && Date.now() - cached.fetched_at < PENDING_TTL_MS) return res.json(JSON.parse(cached.data));
 }

 const dbBuyers = db.prepare('SELECT buyer FROM operator_buyers WHERE operator = ?').all(rawAddress.toLowerCase());
 const dbBuyerAddresses = dbBuyers.map(r => r.buyer);
 const allAddresses = [rawAddress, ...extraAddresses, ...dbBuyerAddresses.filter(a => !extraAddresses.includes(a) && a !== rawAddress)];
 const uniqueAddresses = [...new Set(allAddresses.map(a => a.toLowerCase()))];
 // Reuse the cached protocol stack's epoch (60s TTL) instead of a fresh RPC;
 // fall back to the legacy emissions clock if the stack failed to resolve.
 const stack = await resolveStack();
 const currentEpoch = stack.currentEpoch ?? Number((await emissionsClient.getEpochInfo()).epoch);
 let sellerTotal = 0;
 let buyerTotal = 0;

 // Epochs in parallel with a bounded worker pool; per epoch, all addresses and
 // both emissions contracts are fetched concurrently.
 const epochDetails = await mapWithConcurrency(epochs, EPOCH_CONCURRENCY, async (epoch) => {
 const isCurrent = epoch >= currentEpoch;

 // Epoch-level totals are shared across addresses (and cached in epoch_history).
 const totals = await loadEpochTotals(epoch, currentEpoch);
 const totalSellerPts = Number(totals.totalSellerPts);
 const totalBuyerPts = Number(totals.totalBuyerPts);
 const emissionAmount = Number(totals.emission) / 1e18;

 // Pass 1: per address — points + claim status. Calls are sequential within a
 // worker so the total in-flight request count stays ≈ EPOCH_CONCURRENCY; the
 // gateway queues bursts far beyond that and queued calls die with timeouts.
 const addrPoints = [];
 for (const addr of uniqueAddresses) {
   const sp = Number(await strict(() => emissionsClient.userSellerPoints(addr, epoch)));
   const bp = Number(await strict(() => emissionsClient.userBuyerPoints(addr, epoch)));
   const sc = await strict(() => emissionsClient.sellerEpochClaimed(addr, epoch));
   const bc = await strict(() => emissionsClient.buyerEpochClaimed(addr, epoch));
   let v1sp = 0;
   let v1bp = 0;
   let v1sc = false;
   let v1bc = false;
   if (epoch <= MIGRATION_EPOCH) {
     v1sp = Number(await strict(() => emissionsV1Client.userSellerPoints(addr, epoch)));
     v1bp = Number(await strict(() => emissionsV1Client.userBuyerPoints(addr, epoch)));
     if (epoch < MIGRATION_EPOCH) {
       v1sc = await strict(() => emissionsV1Client.sellerEpochClaimed(addr, epoch));
       v1bc = await strict(() => emissionsV1Client.buyerEpochClaimed(addr, epoch));
     }
   }
   addrPoints.push({ addr, sp, bp, sc, bc, v1sp, v1bp, v1sc, v1bc });
 }

 // Pass 2: pendingEmissions per address (only for non-current epochs), also
 // sequential within the worker for the same reason.
 const pendingResults = isCurrent ? null : [];
 if (!isCurrent) {
   for (const a of addrPoints) {
     if (a.sp === 0 && a.bp === 0 && a.v1sp === 0 && a.v1bp === 0) {
       pendingResults.push({ v2: null, v1: null });
       continue;
     }
     const v2 = await strict(() => emissionsClient.pendingEmissions(a.addr, [epoch]));
     let v1 = null;
     if (epoch <= MIGRATION_EPOCH) {
       const p = await strict(() => emissionsV1Client.pendingEmissions(a.addr, [epoch]));
       v1 = { seller: Number(p.seller) / 1e18, buyer: Number(p.buyer) / 1e18 };
     }
     pendingResults.push({
       v2: { seller: Number(v2.seller) / 1e18, buyer: Number(v2.buyer) / 1e18 },
       v1,
     });
   }
 }

 let epochSellerPts = 0;
 let epochBuyerPts = 0;
 let epochSellerReward = 0;
 let epochBuyerReward = 0;
 let epochSellerRewardV1 = 0;
 let epochBuyerRewardV1 = 0;
 let epochSellerRewardV2 = 0;
 let epochBuyerRewardV2 = 0;
 let epochSellerClaimed = false;
 let epochBuyerClaimed = false;

 for (let i = 0; i < addrPoints.length; i++) {
   const { addr, sp, bp, sc, bc, v1sp, v1bp, v1sc, v1bc } = addrPoints[i];
   const userSellerPts = sp + v1sp;
   const userBuyerPts = bp + v1bp;

   if (userSellerPts > 0 || userBuyerPts > 0) {
     epochSellerPts += userSellerPts;
     epochBuyerPts += userBuyerPts;

     if (!isCurrent) {
       const p = pendingResults[i];
       if (p) {
         if (p.v2) {
           epochSellerRewardV2 += p.v2.seller;
           epochBuyerRewardV2 += p.v2.buyer;
           epochSellerReward += p.v2.seller;
           epochBuyerReward += p.v2.buyer;
         }
         if (p.v1) {
           epochSellerRewardV1 += p.v1.seller;
           epochBuyerRewardV1 += p.v1.buyer;
           epochSellerReward += p.v1.seller;
           epochBuyerReward += p.v1.buyer;
         }
       }
     }
   }
   if (sc || v1sc) epochSellerClaimed = true;
   if (bc || v1bc) epochBuyerClaimed = true;
 }

 if (isCurrent) {
   for (const { sp, bp, v1sp, v1bp } of addrPoints) {
     const userSellerPts = sp + v1sp;
     const userBuyerPts = bp + v1bp;
     if (userSellerPts > 0) epochSellerReward += totalSellerPts > 0 ? (userSellerPts / totalSellerPts) * emissionAmount * 0.5 : 0;
     if (userBuyerPts > 0) epochBuyerReward += totalBuyerPts > 0 ? (userBuyerPts / totalBuyerPts) * emissionAmount * 0.2 : 0;
   }
 }

 return {
 epoch,
 sellerPoints: epochSellerPts,
 buyerPoints: epochBuyerPts,
 sellerReward: epochSellerReward,
 buyerReward: epochBuyerReward,
 sellerClaimed: epochSellerClaimed,
 buyerClaimed: epochBuyerClaimed,
 isCurrentEpoch: isCurrent,
 ...(epoch <= MIGRATION_EPOCH && !isCurrent ? {
   sellerRewardV1: epochSellerRewardV1,
   buyerRewardV1: epochBuyerRewardV1,
   sellerRewardV2: epochSellerRewardV2,
   buyerRewardV2: epochBuyerRewardV2,
 } : {}),
 };
 });
       // Parallel total accumulation
       const totalsResult = await Promise.all(uniqueAddresses.map(addr =>
         Promise.all([
           addr,
           emissionsClient.pendingEmissions(addr, epochs),
           epochs.some(e => e <= MIGRATION_EPOCH)
             ? emissionsV1Client.pendingEmissions(addr, epochs.filter(e => e <= MIGRATION_EPOCH))
             : Promise.resolve({ seller: 0n, buyer: 0n }),
         ])
       ));
       for (const [, pending, v1Pending] of totalsResult) {
         sellerTotal += Number(pending.seller) / 1e18;
         buyerTotal += Number(pending.buyer) / 1e18;
         sellerTotal += Number(v1Pending.seller) / 1e18;
         buyerTotal += Number(v1Pending.buyer) / 1e18;
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

// ─── Rewards view (recognized-usage era: 5 buckets) ───
// Mirrors the official ANTS dashboard: staker (seller-pool lANTS positions),
// seller usage rewards, buyer usage rewards, legacy emissions, locked M002 pool.
// ─── /api/rewards bucket loaders (the five buckets run concurrently) ───

async function loadSellerUsageRewards(address, stack, agentIdPromise) {
  if (stack.phase !== 'active' || !usageAccountingClient || !usageRewardsClient || stack.recognizedEpochs.length === 0) {
    return { total: 0n, epochs: [] };
  }
  const agentId = await agentIdPromise;
  // The batched pending total and the per-epoch rows are independent — issue
  // them together. pendingAgentReward is fetched unconditionally and gated by
  // the claimed flag afterwards (safe() absorbs reverts on claimed epochs).
  const [total, rows] = await Promise.all([
    safe(() => pendingEpochRewards(stack.recognizedEpochs, async (batch) => (await usageAccountingClient.pendingEmissions(address, batch)).seller), 0n),
    mapWithConcurrency(stack.recognizedEpochs, EPOCH_CONCURRENCY, async (epoch) => {
      // Sequential within the worker so total in-flight RPCs stay bounded;
      // safe() retries transient gateway throttles once before its fallback.
      const sellerClaimed = agentId ? await safe(() => usageRewardsClient.agentEpochClaimed(agentId, epoch), false) : false;
      const sellerPoints = await safe(() => usageAccountingClient.sellerPointsByEpoch(epoch, address), 0n);
      const sellerAmount = agentId ? await safe(() => usageRewardsClient.pendingAgentReward(agentId, epoch), 0n) : 0n;
      return {
        epoch,
        points: Number(sellerPoints) / 1e6,
        amount: sellerClaimed ? 0 : Number(sellerAmount) / 1e18,
        claimed: sellerClaimed,
      };
    }),
  ]);
  return { total, epochs: rows };
}

async function loadBuyerUsageRewards(address, stack) {
  if (stack.phase !== 'active' || !usageRewardsClient || stack.recognizedEpochs.length === 0) {
    return { total: 0n, epochs: [] };
  }
  const rows = await mapWithConcurrency(stack.recognizedEpochs, EPOCH_CONCURRENCY, async (epoch) => {
    const buyerClaimed = await safe(() => usageRewardsClient.buyerEpochClaimed(address, epoch), false);
    const buyerPoints = usageAccountingClient ? await safe(() => usageAccountingClient.buyerPointsByEpoch(epoch, address), 0n) : 0n;
    const buyerAmount = await safe(() => usageRewardsClient.pendingBuyerReward(address, epoch), 0n);
    return { epoch, buyerClaimed, buyerPoints, buyerAmount };
  });
  const total = rows.reduce((sum, r) => sum + (r.buyerClaimed ? 0n : r.buyerAmount), 0n);
  return {
    total,
    epochs: rows.map((r) => ({
      epoch: r.epoch,
      points: Number(r.buyerPoints) / 1e6,
      amount: r.buyerClaimed ? 0 : Number(r.buyerAmount) / 1e18,
      claimed: r.buyerClaimed,
    })),
  };
}

async function loadLegacyRewards(address, stack) {
  if (stack.legacyEpochs.length === 0) return { seller: 0, buyer: 0 };
  const v1Epochs = stack.legacyEpochs.filter((e) => e <= MIGRATION_EPOCH);
  const [pending, v1Pending] = await Promise.all([
    safe(() => emissionsClient.pendingEmissions(address, stack.legacyEpochs), { seller: 0n, buyer: 0n }),
    v1Epochs.length > 0
      ? safe(() => emissionsV1Client.pendingEmissions(address, v1Epochs), { seller: 0n, buyer: 0n })
      : Promise.resolve({ seller: 0n, buyer: 0n }),
  ]);
  return {
    seller: Number(pending.seller) / 1e18 + Number(v1Pending.seller) / 1e18,
    buyer: Number(pending.buyer) / 1e18 + Number(v1Pending.buyer) / 1e18,
  };
}

app.get('/api/rewards', async (req, res) => {
  try {
    const address = req.query.address;
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({ error: 'valid address query param required' });
    }
    const bustCache = req.query.bust === '1';
    const cacheKey = `rewards:${address.toLowerCase()}`;
    if (!bustCache) {
      const cached = db.prepare('SELECT data, fetched_at FROM address_emissions WHERE address = ?').get(cacheKey);
      if (cached && Date.now() - cached.fetched_at < 90_000) return res.json(JSON.parse(cached.data));
    }

    const stack = await resolveStack();

    // The five reward buckets are independent — fetch them all concurrently so
    // cold-path latency is the slowest bucket, not the sum of all buckets.
    const agentIdPromise = agentIdOf(address).catch(() => 0);
    const [
      agentId,
      stakerPositions,
      sellerUsage,
      buyerUsage,
      operator,
      legacy,
      locked,
    ] = await Promise.all([
      agentIdPromise,
      sellerPoolsClient && sellerPoolsRewardsClient
        ? safe(() => previewPoolRewards(sellerPoolsClient, sellerPoolsRewardsClient, address), [])
        : Promise.resolve([]),
      loadSellerUsageRewards(address, stack, agentIdPromise),
      loadBuyerUsageRewards(address, stack),
      safe(() => depositsClient.getOperator(address), ZERO_ADDRESS),
      loadLegacyRewards(address, stack),
      stack.lockedPoolClient
        ? safe(() => stack.lockedPoolClient.claimable(address), { locked: 0n, claimable: 0n, policy: ZERO_ADDRESS })
        : Promise.resolve({ locked: 0n, claimable: 0n, policy: ZERO_ADDRESS }),
    ]);

    const stakerPending = stakerPositions.filter((p) => p.amount > 0n);
    const stakerTotalAnts = stakerPending.reduce((sum, p) => sum + p.amount, 0n);
    const isOperator = sameAddress(operator, address);
    const total = Number(stakerTotalAnts) / 1e18 + Number(sellerUsage.total) / 1e18 + Number(buyerUsage.total) / 1e18
      + legacy.seller + legacy.buyer + Number(locked.claimable) / 1e18;

    const data = {
      currentEpoch: stack.currentEpoch,
      effectiveEpoch: stack.effectiveEpoch,
      phase: stack.phase,
      agentId,
      operator: sameAddress(operator, ZERO_ADDRESS) ? null : operator,
      staker: {
        total: Number(stakerTotalAnts) / 1e18,
        positions: stakerPending.map((p) => ({
          id: p.id,
          agentId: p.agentId,
          amount: Number(p.amount) / 1e18,
          closedAtEpoch: p.closedAtEpoch,
        })),
      },
      sellerUsage: {
        total: Number(sellerUsage.total) / 1e18,
        claimable: stack.phase === 'active' && agentId !== 0,
        epochs: sellerUsage.epochs,
      },
      buyerUsage: {
        total: Number(buyerUsage.total) / 1e18,
        claimable: stack.phase === 'active' && isOperator,
        recipient: sameAddress(operator, ZERO_ADDRESS) ? null : operator,
        epochs: buyerUsage.epochs,
      },
      legacy: {
        seller: legacy.seller,
        buyer: legacy.buyer,
        epochs: stack.legacyEpochs,
        contract: legacyAddresses.legacyEmissionsContractAddress,
      },
      locked: {
        locked: Number(locked.locked) / 1e18,
        claimable: Number(locked.claimable) / 1e18,
        pool: stack.lockedRewardsPool,
        policy: sameAddress(locked.policy, ZERO_ADDRESS) ? null : locked.policy,
      },
      total,
      contracts: {
        usageAccounting: emissionsCfg.usageAccountingAddress,
        usageRewards: emissionsCfg.usageRewardsAddress,
        sellerPoolsRewards: emissionsCfg.sellerPoolsRewardsAddress,
        sellerPools: emissionsCfg.sellerPoolsAddress,
        legacyEmissions: legacyAddresses.legacyEmissionsContractAddress,
        legacyEmissionsV1: legacyAddresses.legacyEmissionsV1ContractAddress || EMISSIONS_V1_FALLBACK,
        lockedPool: stack.lockedRewardsPool,
      },
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
