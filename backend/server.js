import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Interface, JsonRpcProvider, Contract } from 'ethers';
import db from './database.js';
import { syncFromOfficialNetwork, getLastCatalogSync } from './sync-official.js';
import { readChainMetrics, updateChainMetrics, startChainPoller } from './chain-poller.js';
import {
  runHistorySync, startHistorySync,
  readLatestSnapshot, readDailyMetrics, readBuyersOnchain, countBuyersOnchain, readSellersOnchain,
  readEpochMetrics,
} from './sync-history.js';
import {
  fetchBuyerEpochs, fetchSellerEpochs, fetchPoolEpochs, fetchOpenStakePositions, fetchStakingEpoch,
} from './antscan.js';
import {
  EmissionsClient, ANTSTokenClient, DepositsClient, RegistryClient, EmissionsGateClient,
  UsageAccountingClient, UsageRewardsClient, SellerPoolsClient, SellerPoolsRewardsClient,
  SellerRegistryClient, SellerRewardsPoolClient, StakingClient,
  resolveChainConfig, resolveLegacyContractAddresses, GATE_MINTERS, gateMinterId,
  previewPoolRewards, pendingEpochRewards,
  // Model identity comes from the protocol SDK, NOT from a local heuristic.
  // Sellers advertise the same model under many spellings (claude-opus-4-8,
  // claude-opus-4.8, opus-4.8 — one seller publishes all three), and
  // network.antseed.com/stats is the raw discovery payload, so the names
  // arrive unnormalized. `canonicalModelKey` is the same function the buyer
  // node uses to resolve a requested model to a seller, so grouping by it
  // means this dashboard groups exactly the way routing does. Do not replace
  // this with local string munging: a hand-rolled version over-merged
  // distinct products (deepseek-v4-flash vs -0731, which are priced
  // differently, and e2ee- encrypted variants), which silently puts two
  // different services into one price comparison.
  canonicalModelKey, preferredModelDisplayName,
} from '@antseed/node';

const PROVIDER_BASE = process.env.PROVIDER_BASE_URL || 'http://localhost:8377/v1';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// This backend always runs behind nginx (both the `:8088/zh` proxy and the
// antseed-zh.com vhost `proxy_pass` to 127.0.0.1:3001). Without this, every
// request — including ones from the public internet — has req.ip ===
// '127.0.0.1', which silently defeated the localhost check in
// requireAdminAuth below. Trust exactly one hop (our own nginx).
app.set('trust proxy', 1);

// ─── Admin auth gate ───
// Previously /api/admin/sync and /api/admin/force-chain-sync were open to
// anyone. Require a shared-secret token (ADMIN_SYNC_TOKEN env var).
//
// SECURITY: this used to fall back to "allow if req.ip is localhost" when
// ADMIN_SYNC_TOKEN was unset. Combined with the missing `trust proxy` above,
// that made every admin route publicly callable through nginx (verified:
// `curl -X POST http://<public-ip>:8088/zh/api/admin/force-chain-sync` -> 200),
// giving anyone an unauthenticated RPC/Antscan amplification lever against
// the rate-limited Tenderly gateway. We now fail CLOSED: no token configured
// means remote admin calls are refused outright, and the localhost exemption
// is evaluated against the real client IP (req.ip, now proxy-aware) rather
// than the proxy's address.
const ADMIN_SYNC_TOKEN = process.env.ADMIN_SYNC_TOKEN || null;

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function requireAdminAuth(req, res, next) {
  if (ADMIN_SYNC_TOKEN) {
    const provided = req.get('x-admin-token') || req.query.token;
    if (provided === ADMIN_SYNC_TOKEN) return next();
    return res.status(401).json({ error: 'unauthorized' });
  }
  // No token configured: only genuinely local callers (server-side cron /
  // health checks running on this host) may proceed. `req.ip` is now the
  // real client address because of `trust proxy` above, and we additionally
  // require the socket peer itself to be loopback so a spoofed
  // X-Forwarded-For cannot fabricate a local origin.
  const clientIp = req.ip || '';
  const socketIp = req.socket?.remoteAddress || '';
  if (isLoopback(clientIp) && isLoopback(socketIp) && !req.get('x-forwarded-for')) return next();
  return res.status(401).json({ error: 'unauthorized (set ADMIN_SYNC_TOKEN to allow admin calls)' });
}

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
    // `name` stays exactly as the seller advertised it — it is the routing
    // identifier a buyer passes as the model id, so it must never be
    // rewritten. These two fields are derived display/grouping aids.
    canonicalKey: canonicalModelKey(row.name),
    displayName: preferredModelDisplayName(row.name),
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
// Current-epoch buyers/sellers/volume for the Overview tab — sourced from
// epoch_metrics (Antscan-backed, synced every 5 min by sync-history.js),
// keyed by the live epoch number from the chain poller. No services number:
// unlike buyers/sellers/volume, services have no per-epoch entity on Antscan
// (they're a live DHT catalog snapshot, not a settlement ledger) — see
// notes/epoch-features-plan.md for why that was deliberately left out
// rather than faked.
function currentEpochOverview() {
  const chain = readChainMetrics();
  const epoch = chain?.emissions?.currentEpoch;
  if (epoch == null) return null;
  const row = db.prepare('SELECT * FROM epoch_metrics WHERE epoch = ?').get(epoch);
  // Epoch date range (unix seconds), so the frontend can show a day-by-day
  // breakdown of just this epoch's window rather than an all-epochs
  // aggregate. genesis/epochDuration are both already live-read by
  // chain-poller.js; startTs is undefined (not just late) if either is
  // missing, since a wrong range would silently mislabel days as
  // in/out of the epoch.
  const genesis = chain?.emissions?.genesis;
  const duration = chain?.emissions?.epochDuration;
  const startTs = genesis != null && duration != null ? genesis + epoch * duration : null;
  const endTs = startTs != null && duration != null ? startTs + duration : null;
  return {
    epoch,
    buyers: row?.active_buyers ?? null,
    sellers: row?.active_sellers ?? null,
    volumeUsdc: row?.volume_usdc != null ? Number(row.volume_usdc) / 1e6 : null,
    startTs,
    endTs,
  };
}

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
    currentEpoch: currentEpochOverview(),
  });
});

app.put('/api/stats', requireAdminAuth, (req, res) => {
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

app.post('/api/buyers', requireAdminAuth, (req, res) => {
  const { id, name, status, totalSpent, requests, avgLatency, joined } = req.body;
  const result = db.prepare(`
    INSERT INTO buyers (id, name, status, total_spent, requests, avg_latency, joined)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, status, totalSpent ?? 0, requests ?? 0, avgLatency ?? 0, joined);
  res.status(201).json({ id: result.lastInsertRowid });
});

app.put('/api/buyers/:id', requireAdminAuth, (req, res) => {
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

app.delete('/api/buyers/:id', requireAdminAuth, (req, res) => {
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

app.post('/api/sellers', requireAdminAuth, (req, res) => {
  const { id, name, status, totalEarned, capacity, uptime, models, joined } = req.body;
  const result = db.prepare(`
    INSERT INTO sellers (id, name, status, total_earned, capacity, uptime, models, joined)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, status, totalEarned ?? 0, capacity, uptime ?? 0, models ?? 0, joined);
  res.status(201).json({ id: result.lastInsertRowid });
});

app.put('/api/sellers/:id', requireAdminAuth, (req, res) => {
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

app.delete('/api/sellers/:id', requireAdminAuth, (req, res) => {
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

// --- Reference prices (OpenRouter) ------------------------------------------
// Backs the "vs reference" column in the Services > By model view. Sellers
// only publish their own price, so a comparison needs an outside rate; this
// proxies OpenRouter's public model catalogue (no API key required).
//
// IMPORTANT FRAMING: OpenRouter is itself a marketplace, so what we get is a
// LIST price, not "the vendor's official price". The UI must say
// "OpenRouter list price" — calling it official would be a claim we can't
// back. Nothing here is hardcoded: if the fetch fails we serve `{}` and the
// column renders `—` rather than a stale or invented number.
//
// Proxied server-side (not fetched from the browser) so one cached copy
// serves every visitor and the site doesn't depend on a third-party CORS
// policy.
const REFERENCE_TTL_MS = 6 * 60 * 60 * 1000; // vendor list prices move slowly
let referenceCache = null;
let referenceCacheAt = 0;
let referenceInflight = null;

async function fetchReferencePrices() {
  const resp = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`openrouter ${resp.status}`);
  const body = await resp.json();
  const models = Array.isArray(body?.data) ? body.data : [];
  const out = {};
  for (const m of models) {
    // `:batch`, `:free`, `:thinking` etc. are pricing tiers of a model, not
    // the model's standard rate — comparing a seller against a batch-discount
    // price would overstate how expensive the seller is.
    if (typeof m?.id !== 'string' || m.id.includes(':')) continue;
    const input = Number(m?.pricing?.prompt) * 1e6;
    const output = Number(m?.pricing?.completion) * 1e6;
    // Free/unpriced entries carry 0 or non-numeric values — skip rather than
    // treat as a real $0 reference, which would produce a bogus -100%.
    if (!Number.isFinite(input) || !Number.isFinite(output) || input <= 0 || output <= 0) continue;
    if (out[m.id]) continue;
    // Canonicalize with the same protocol function used for service rows, so
    // an OpenRouter id lines up with the advertised model it should be
    // compared against without the client re-deriving keys.
    out[m.id] = {
      id: m.id,
      canonicalKey: canonicalModelKey(m.id),
      name: m.name ?? m.id,
      inputUsdPerMillion: input,
      outputUsdPerMillion: output,
    };
  }
  return out;
}

app.get('/api/reference-prices', async (_req, res) => {
  const fresh = referenceCache && Date.now() - referenceCacheAt < REFERENCE_TTL_MS;
  if (fresh) {
    return res.json({ source: 'openrouter', fetchedAt: referenceCacheAt, models: referenceCache });
  }
  try {
    // Collapse concurrent misses into one upstream request.
    referenceInflight = referenceInflight || fetchReferencePrices();
    const models = await referenceInflight;
    referenceInflight = null;
    referenceCache = models;
    referenceCacheAt = Date.now();
    res.json({ source: 'openrouter', fetchedAt: referenceCacheAt, models });
  } catch (err) {
    referenceInflight = null;
    // Serve a stale copy if we have one — an old list price is still a real
    // number. With nothing cached, return empty so the UI shows `—`.
    if (referenceCache) {
      return res.json({ source: 'openrouter', fetchedAt: referenceCacheAt, stale: true, models: referenceCache });
    }
    console.error('[reference-prices]', err.message);
    res.json({ source: 'openrouter', fetchedAt: null, error: err.message, models: {} });
  }
});

// --- Marketplace comparison (Surplus Intelligence + Orbio) ------------------
// Backs the "Inference Market" tab. Same caching pattern as
// /api/reference-prices: proxied server-side, 6h TTL, in-flight dedup, serve
// stale on failure. No number here is hardcoded — every figure comes from the
// competitor's own public endpoint, or the field is null and the UI renders
// `—`. Surplus/Orbio prices are marketplace prices (like OpenRouter's list
// price), not official vendor rates, and the UI must say so.
const MARKETPLACE_TTL_MS = 6 * 60 * 60 * 1000;
let marketplaceCache = null;
let marketplaceCacheAt = 0;
let marketplaceInflight = null;

// Shared normalization for OpenAI-style /v1/models payloads with per-token
// pricing (both Surplus and Orbio use this shape). Identity still comes from
// the protocol's canonicalModelKey — never local name munging (see the
// import comment at the top of this file for why that matters).
function catalogFromPerTokenPricing(list) {
  const out = {};
  for (const m of Array.isArray(list) ? list : []) {
    if (typeof m?.id !== 'string' || m.id.includes(':')) continue;
    const input = Number(m?.pricing?.prompt) * 1e6;
    const output = Number(m?.pricing?.completion) * 1e6;
    // Free/unpriced entries carry 0 or non-numeric values — skip rather than
    // treat as a real $0 price (same reasoning as /api/reference-prices).
    if (!Number.isFinite(input) || !Number.isFinite(output) || input <= 0 || output <= 0) continue;
    if (out[m.id]) continue;
    // Orbio prefixes some ids with `~` (its internal marker for unlisted
    // models) — stripping that single character is mechanical, not model
    // identity munging; canonicalModelKey does the actual identity work.
    const rawId = m.id.replace(/^~/, '');
    out[m.id] = {
      id: m.id,
      canonicalKey: canonicalModelKey(rawId),
      name: m.name ?? m.id,
      inputUsdPerMillion: input,
      outputUsdPerMillion: output,
    };
  }
  return out;
}

async function fetchSurplusCatalog() {
  const resp = await fetch('https://api.surplusintelligence.ai/v1/models', {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`surplus ${resp.status}`);
  const body = await resp.json();
  const list = Array.isArray(body?.data) ? body.data : [];
  const models = catalogFromPerTokenPricing(list);
  return { modelCount: list.length, pricedCount: Object.keys(models).length, models };
}

async function fetchOrbioCatalog() {
  const resp = await fetch('https://api.orbio.so/api/v1/models', {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`orbio models ${resp.status}`);
  const body = await resp.json();
  const list = Array.isArray(body?.data) ? body.data : [];
  const models = catalogFromPerTokenPricing(list);

  // Orbio's catalog lists OpenRouter list prices; what a buyer actually pays
  // is discounted by resold credits (their liquidity book) plus a 5% platform
  // fee on the discounted price (per orbio.so FAQ). The book is embedded in
  // the homepage's Next.js payload as {"discountBps":3750,"microUsd":"…"}
  // tiers. Best tier = highest discount, regardless of depth — the UI shows
  // the tier's available credits so depth limits stay visible. If the parse
  // fails, discount stays null and the UI shows the undiscounted list price
  // labeled as such — the "37.5% less" marketing headline is never hardcoded.
  let discount = null;
  try {
    const homeResp = await fetch('https://www.orbio.so/', {
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(20_000),
    });
    if (homeResp.ok) {
      const html = await homeResp.text();
      const tiers = new Map();
      // Matches both raw and JSON-escaped (\\\") forms of the embedded pairs.
      const re = /discountBps\\?":(\d+),\\?"microUsd\\?":\\?"(\d+)\\?"/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        const bps = Number(m[1]);
        const creditsUsd = Number(m[2]) / 1e6;
        if (Number.isFinite(bps) && bps > 0 && bps < 10_000 && Number.isFinite(creditsUsd)) {
          tiers.set(bps, (tiers.get(bps) ?? 0) + creditsUsd);
        }
      }
      if (tiers.size) {
        const bestBps = Math.max(...tiers.keys());
        discount = {
          bps: bestBps,
          creditsUsd: tiers.get(bestBps),
          totalCreditsUsd: [...tiers.values()].reduce((s, v) => s + v, 0),
        };
      }
    }
  } catch (err) {
    console.warn('[marketplace-compare] orbio discount parse failed:', err.message);
  }

  // Effective price = list × (1 − discount) × 1.05 (platform fee). Computed
  // here so the frontend never has to redo Orbio's fee math.
  if (discount) {
    const factor = (1 - discount.bps / 10_000) * 1.05;
    for (const entry of Object.values(models)) {
      entry.effectiveInputUsdPerMillion = entry.inputUsdPerMillion * factor;
      entry.effectiveOutputUsdPerMillion = entry.outputUsdPerMillion * factor;
    }
  }
  return { modelCount: list.length, pricedCount: Object.keys(models).length, discount, models };
}

// AntSeed's own side of the comparison: aggregates over the live services
// table (per-model prices stay client-side — the tab already receives the
// same services array ServicesList uses).
function antseedLocalMetrics() {
  const rows = db.prepare('SELECT name, seller_id FROM services').all();
  const modelKeys = new Set();
  const sellers = new Set();
  for (const r of rows) {
    const key = canonicalModelKey(r.name);
    if (key) modelKeys.add(key);
    if (r.seller_id) sellers.add(r.seller_id);
  }
  return { listings: rows.length, models: modelKeys.size, sellers: sellers.size };
}

async function fetchMarketplaceCompare() {
  // Per-source isolation: one competitor being down must not blank the
  // other — each source resolves to data or { error }.
  const [surplus, orbio] = await Promise.all([
    fetchSurplusCatalog().catch(err => ({ error: err.message })),
    fetchOrbioCatalog().catch(err => ({ error: err.message })),
  ]);
  return { fetchedAt: Date.now(), antseed: antseedLocalMetrics(), surplus, orbio };
}

app.get('/api/marketplace-compare', async (_req, res) => {
  const fresh = marketplaceCache && Date.now() - marketplaceCacheAt < MARKETPLACE_TTL_MS;
  if (fresh) return res.json(marketplaceCache);
  try {
    marketplaceInflight = marketplaceInflight || fetchMarketplaceCompare();
    const payload = await marketplaceInflight;
    marketplaceInflight = null;
    marketplaceCache = payload;
    marketplaceCacheAt = Date.now();
    res.json(payload);
  } catch (err) {
    marketplaceInflight = null;
    if (marketplaceCache) {
      return res.json({ ...marketplaceCache, stale: true });
    }
    console.error('[marketplace-compare]', err.message);
    res.json({ fetchedAt: null, error: err.message, antseed: null, surplus: null, orbio: null });
  }
});

app.post('/api/services', requireAdminAuth, (req, res) => {
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

app.put('/api/services/:id', requireAdminAuth, (req, res) => {
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

app.delete('/api/services/:id', requireAdminAuth, (req, res) => {
  const result = db.prepare('DELETE FROM services WHERE id = ?').run(req.params.id);
  res.json({ deleted: result.changes });
});

// ─── Computed stats for live updates ───
app.get('/api/computed-stats', (_req, res) => {
  // Previously this summed `buyers.total_spent` — a column that only ever
  // held the 8 fabricated seed rows — and reported ~$98,242 of invented
  // volume as the network total. Buyer count came from the same fake table.
  // Both now come from the real Antscan network snapshot (the same source
  // sync-official.js uses for the stats row), and are null when no snapshot
  // has been synced yet rather than falling back to a guess.
  const snap = readLatestSnapshot();
  const sellerCount = db.prepare('SELECT COUNT(*) as c FROM sellers').get().c;
  const serviceCount = db.prepare('SELECT COUNT(*) as c FROM services').get().c;
  res.json({
    totalBuyers: snap?.buyer_count ?? null,
    totalSellers: sellerCount,
    totalServices: serviceCount,
    totalVolume: snap ? Number(snap.total_volume_usdc) / 1e6 : null,
  });
});

app.get('/api/chain-stats', (_req, res) => {
  const data = readChainMetrics();
  if (!data) {
    return res.status(503).json({ error: 'Chain metrics not yet available. Wait for the next poller cycle.' });
  }
  res.json(data);
});

// ─── Tokenomics: current (epoch 22+) vs legacy allocation, live stake data ───
// This is a separate, cached (5 min TTL) endpoint so the Tokenomics tab loads
// fast without re-reading the chain on every request. Data is real on-chain
// reads (via the same clients the poller uses), not hardcoded percentages.
const TOKENOMICS_TTL_MS = 5 * 60 * 1000;
let tokenomicsCache = null;
let tokenomicsCacheAt = 0;
// Guards against a refresh stampede: several concurrent visitors on a cold
// cache would otherwise each kick off the same ~42s chain read.
let tokenomicsRefreshing = null;

/** Durable (SQLite-backed) companion to the in-memory caches. Survives
 *  restarts, so a cold process can still answer instantly with the last
 *  known good payload while it refreshes in the background. */
function readPayloadCache(key) {
  try {
    const row = db.prepare('SELECT data, fetched_at FROM payload_cache WHERE key = ?').get(key);
    if (!row) return null;
    return { data: JSON.parse(row.data), fetchedAt: row.fetched_at };
  } catch { return null; }
}

function writePayloadCache(key, data) {
  try {
    db.prepare(`INSERT INTO payload_cache (key, data, fetched_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`)
      .run(key, JSON.stringify(data), Date.now());
  } catch { /* cache write failures must never break the response */ }
}

/** Recomputes tokenomics and updates both cache layers. Deduplicated: a
 *  second caller while a refresh is in flight joins the existing promise. */
function refreshTokenomics() {
  if (tokenomicsRefreshing) return tokenomicsRefreshing;
  tokenomicsRefreshing = computeTokenomics()
    .then((data) => {
      tokenomicsCache = data;
      tokenomicsCacheAt = Date.now();
      writePayloadCache('tokenomics', data);
      return data;
    })
    .finally(() => { tokenomicsRefreshing = null; });
  return tokenomicsRefreshing;
}

// Gate share values (minShareBps/maxShareBps on the dynamic staker and usage
// configs) use a 100_000 denominator, not the standard 10_000 bps one — see
// AntseedEmissionsGate.SHARE_DENOMINATOR / AntseedSellerPoolsRewards.
// GATE_SHARE_DENOMINATOR / AntseedUsageRewards.GATE_SHARE_DENOMINATOR.
// Converting to a percentage is therefore bps / 100_000 * 100 === bps / 1000.
const GATE_SHARE_DENOMINATOR = 100_000;
function bpsToPct(bps) {
  if (bps == null) return null;
  return (Number(bps) / GATE_SHARE_DENOMINATOR) * 100;
}

// Legacy (pre-epoch-22) allocation. These percentages are mutable on-chain
// (AntseedEmissions.setShares) and the deployed Base-mainnet V2 contract has
// in fact been re-configured away from its constructor defaults: a live
// getShares() returns 65/5/15/15, not the 50/20/15/15 the contract tests
// assert. Hardcoding either set is therefore wrong — read them live, and
// only fall back to the last-known-live values if the chain read fails.
const LEGACY_ALLOCATION_FALLBACK = [
  { name: 'sellers', sharePct: 65, desc: 'Legacy V2 seller emissions (capped at 50% of the seller bucket per seller).' },
  { name: 'buyers', sharePct: 5, desc: 'Legacy V2 buyer emissions (capped at 5% of the buyer bucket per buyer).' },
  { name: 'reserve', sharePct: 15, desc: 'Protocol reserve — legacy flush destination.' },
  { name: 'team', sharePct: 15, desc: 'Team wallet — legacy flush destination.' },
];

async function readLegacyAllocation() {
  if (!emissionsClient) return LEGACY_ALLOCATION_FALLBACK;
  try {
    const p = await emissionsClient.getShares();
    if (!p || !p.initialized) return LEGACY_ALLOCATION_FALLBACK;
    return [
      { name: 'sellers', sharePct: Number(p.sellerSharePct), desc: `Legacy V2 seller emissions (capped at ${Number(p.maxSellerSharePct)}% of the seller bucket per seller).` },
      { name: 'buyers', sharePct: Number(p.buyerSharePct), desc: `Legacy V2 buyer emissions (capped at ${Number(p.maxBuyerSharePct)}% of the buyer bucket per buyer).` },
      { name: 'reserve', sharePct: Number(p.reserveSharePct), desc: 'Protocol reserve — legacy flush destination.' },
      { name: 'team', sharePct: Number(p.teamSharePct), desc: 'Team wallet — legacy flush destination.' },
    ];
  } catch (_) {
    return LEGACY_ALLOCATION_FALLBACK;
  }
}

async function computeTokenomics() {
  const cd = readChainMetrics();
  const stack = await resolveStack().catch(() => null);
  const currentEpoch = stack?.currentEpoch ?? cd?.emissions?.currentEpoch ?? null;
  const effectiveEpoch = stack?.effectiveEpoch ?? cd?.emissions?.effectiveEpoch ?? 22;

  let stake = null;
  try {
    if (sellerPoolsClient && sellerPoolsRewardsClient && currentEpoch != null) {
      const [totalActiveStake, totalPowerWeight, dynStaker, epochEmission, initialEmission] = await Promise.all([
        sellerPoolsClient.totalActiveStakeAtEpoch(currentEpoch).catch(() => null),
        sellerPoolsClient.totalPowerWeightAtEpoch(currentEpoch).catch(() => null),
        sellerPoolsRewardsClient.dynamicStakerConfigAt(currentEpoch).catch(() => null),
        emissionsGateClient ? emissionsGateClient.getEpochEmission(currentEpoch).catch(() => null) : null,
        emissionsGateClient ? emissionsGateClient.initialEmission().catch(() => null) : null,
      ]);
      const activeAnts = totalActiveStake != null ? Number(totalActiveStake) / 1e18 : null;
      const powerWeight = totalPowerWeight != null ? Number(totalPowerWeight) / 1e18 : null;
      let effectiveSharePct = null;
      let target = null;
      if (dynStaker && activeAnts != null) {
        // BPS here are gate-share units with denominator 100_000 (see
        // AntseedSellerPoolsRewards.GATE_SHARE_DENOMINATOR), NOT standard
        // 10_000 bps. Dividing by 100 reported the on-chain defaults
        // (2_000 / 40_000) as "20%" and "400%" — a 400% emission share was
        // being rendered on the Tokenomics tab. Correct conversion to a
        // percentage is bps / 100_000 * 100 === bps / 1000.
        const min = bpsToPct(dynStaker.minShareBps);
        const max = bpsToPct(dynStaker.maxShareBps);
        const rawTarget = Number(dynStaker.stakeShareTarget) / 1e18;
        // The configured target is denominated at the initial emission level
        // and scales with each epoch's emission
        // (_liveStakerEpochBudget: scaledTarget = target * epochEmission / initialEmission).
        // Using the raw target overstated the denominator and understated
        // the effective share.
        const scale = epochEmission != null && initialEmission != null && initialEmission > 0n
          ? Number(epochEmission) / Number(initialEmission)
          : 1;
        target = rawTarget * scale;
        // Mirrors AntseedShareMath.saturatingShareBps: zero metric earns
        // nothing (returns 0, not min); a zero target saturates to max.
        if (activeAnts === 0) effectiveSharePct = 0;
        else if (target === 0) effectiveSharePct = max;
        else effectiveSharePct = min + (max - min) * (activeAnts / (activeAnts + target));
      }
      stake = {
        totalActiveStakeAnts: activeAnts,
        totalPowerWeight: powerWeight,
        stakeShareTarget: target,
        minSharePct: dynStaker ? bpsToPct(dynStaker.minShareBps) : null,
        maxSharePct: dynStaker ? bpsToPct(dynStaker.maxShareBps) : null,
        effectiveSharePct,
      };
    }
  } catch (_) { /* leave stake null on failure — no fabricated fallback */ }

  let usage = null;
  try {
    if (usageRewardsClient && currentEpoch != null) {
      const [dynUsage, stakingEpochNow, buyerBudget, sellerBudget] = await Promise.all([
        usageRewardsClient.dynamicUsageConfigAt(currentEpoch).catch(() => null),
        fetchStakingEpoch(currentEpoch).catch(() => null),
        usageRewardsClient.buyerEpochBudget(currentEpoch).catch(() => null),
        usageRewardsClient.sellerEpochBudget(currentEpoch).catch(() => null),
      ]);
      if (dynUsage) {
        // Same 100_000 gate-share denominator as the staker config above;
        // /100 previously reported the 5_000/10_000 defaults as 50%/100%
        // instead of the real 5%/10%.
        const buyerMin = bpsToPct(dynUsage.buyerMinShareBps);
        const buyerMax = bpsToPct(dynUsage.buyerMaxShareBps);
        const sellerMin = bpsToPct(dynUsage.sellerMinShareBps);
        const sellerMax = bpsToPct(dynUsage.sellerMaxShareBps);
        const target = Number(dynUsage.volumeShareTarget) / 1e6;

        // Live effective share for the *open* current epoch — mirrors the
        // staker share's formula above. Per antseed.com/docs/recognized-usage/:
        // "The usage input is the larger of the epoch's total buyer points
        // and total seller points, after points policies" — ONE shared
        // input (max of the two sides), fed into BOTH the buyer and the
        // seller share formula. Previously this used each side's own points
        // as its own input, which happens to match when buyer/seller points
        // are equal (the common case absent wash-trading divergence) but is
        // wrong in general — fixed to match the documented formula exactly.
        // Same saturatingShareBps rule as the staker share (zero input ->
        // zero share, zero target -> saturates to max).
        const shareFor = (input, min, max) => {
          if (input == null || min == null || max == null) return null;
          if (input === 0) return 0;
          if (target === 0) return max; // target shared by both sides; only reached if genuinely 0
          return min + (max - min) * (input / (input + target));
        };
        const buyerPointsUsdc = stakingEpochNow?.totalBuyerPoints != null ? Number(stakingEpochNow.totalBuyerPoints) / 1e6 : null;
        const sellerPointsUsdc = stakingEpochNow?.totalSellerPoints != null ? Number(stakingEpochNow.totalSellerPoints) / 1e6 : null;
        const usageInput = buyerPointsUsdc != null || sellerPointsUsdc != null
          ? Math.max(buyerPointsUsdc ?? 0, sellerPointsUsdc ?? 0)
          : null;

        usage = {
          buyerMinSharePct: buyerMin,
          buyerMaxSharePct: buyerMax,
          sellerMinSharePct: sellerMin,
          sellerMaxSharePct: sellerMax,
          volumeShareTargetUsdc: target,
          buyerEffectiveSharePct: shareFor(usageInput, buyerMin, buyerMax),
          sellerEffectiveSharePct: shareFor(usageInput, sellerMin, sellerMax),
          buyerRecognizedVolumeUsdc: buyerPointsUsdc,
          sellerRecognizedVolumeUsdc: sellerPointsUsdc,
          buyerEpochBudgetAnts: buyerBudget != null ? Number(buyerBudget) / 1e18 : null,
          sellerEpochBudgetAnts: sellerBudget != null ? Number(sellerBudget) / 1e18 : null,
        };
      }
    }
  } catch (_) { /* leave usage null on failure */ }

  // Emitted-so-far distribution: split total supply into the one-time
  // pre-epoch-22 backlog (funded into the legacy escrow, distributed to
  // legacy sellers/buyers/reserve/team as they claim) vs everything minted
  // under the current gate (epoch 22+, split by minter bucket).
  let distribution = null;
  try {
    if (emissionsGateClient && antsTokenClient && effectiveEpoch != null) {
      const [escrowAddr, cumThroughEffective, totalSupply] = await Promise.all([
        emissionsGateClient.legacyEscrow().catch(() => null),
        emissionsGateClient.cumulativeEmissionThrough(effectiveEpoch).catch(() => null),
        antsTokenClient.totalSupply().catch(() => null),
      ]);
      const legacyTotal = cumThroughEffective != null ? Number(cumThroughEffective) / 1e18 : null;
      // NOTE: this used to be `.catch(() => 0n)`. On an RPC hiccup that made
      // legacyEscrowRemaining 0, hence legacyClaimed === legacyTotal — i.e.
      // the Tokenomics tab would claim the entire pre-epoch-22 backlog had
      // been claimed and the escrow was empty. Fall back to null like every
      // other read here so the UI shows "—" instead of a fabricated figure.
      const escrowBalance = escrowAddr && antsTokenClient
        ? await antsTokenClient.balanceOf(escrowAddr).catch(() => null)
        : null;
      const legacyEscrowRemaining = escrowBalance != null ? Number(escrowBalance) / 1e18 : null;
      const legacyClaimed = legacyTotal != null && legacyEscrowRemaining != null
        ? Math.max(0, legacyTotal - legacyEscrowRemaining)
        : null;

      // minterEpochMinted tracks what has actually been claimed against each
      // minter's budget (unlike minterEpochBudget, which is just the epoch's
      // ceiling) — read it directly since the SDK wrapper doesn't expose it.
      let currentByMinter = [];
      let currentTotal = null;
      if (currentEpoch != null && currentEpoch >= effectiveEpoch && emissionsCfg.emissionsGateAddress) {
        const epochs = Array.from({ length: currentEpoch - effectiveEpoch + 1 }, (_, i) => effectiveEpoch + i);
        // Previously this ran nested Promise.all over GATE_MINTERS x epochs
        // with raw contract calls, i.e. 5 x N simultaneous eth_calls that
        // bypassed Multicall3 entirely. At ~1 epoch/week that crosses the
        // Tenderly gateway's ~30-40 in-flight limit within months, and the
        // `.catch(() => 0n)` fallback would then silently report 0 ANTS
        // minted per bucket as if it were real. Batch through multicallView
        // (chunked + bounded concurrency) and treat failures as unknown.
        const requests = [];
        for (const minter of GATE_MINTERS) {
          const id = gateMinterId(minter.id);
          for (const epoch of epochs) {
            requests.push({ target: emissionsCfg.emissionsGateAddress, iface: gateMintedIface, method: 'minterEpochMinted', args: [id, epoch] });
          }
        }
        const decoded = await multicallView(requests);
        let anyFailed = false;
        currentByMinter = GATE_MINTERS.map((minter, mIdx) => {
          let total = 0;
          for (let eIdx = 0; eIdx < epochs.length; eIdx++) {
            const v = decoded[mIdx * epochs.length + eIdx];
            if (v?.[0] == null) { anyFailed = true; continue; }
            total += Number(v[0]) / 1e18;
          }
          return { name: minter.name, mintedAnts: total };
        });
        // Don't present a partial sum as the authoritative total.
        currentTotal = anyFailed ? null : currentByMinter.reduce((s, m) => s + m.mintedAnts, 0);
      }

      distribution = {
        totalSupply: totalSupply != null ? Number(totalSupply) / 1e18 : null,
        legacy: {
          scheduledTotal: legacyTotal, // full pre-epoch-22 backlog (one-time mint)
          claimed: legacyClaimed,       // already paid out to sellers/buyers/reserve/team
          remainingInEscrow: legacyEscrowRemaining,
        },
        current: {
          total: currentTotal, // minted under the gate since epoch 22, by minter bucket
          byMinter: currentByMinter,
        },
      };
    }
  } catch (_) { /* leave distribution null on failure — no fabricated fallback */ }

  const legacyAllocation = await readLegacyAllocation();

  return {
    fetchedAt: Date.now(),
    currentEpoch,
    effectiveEpoch,
    migrationDate: '2026-09-10T09:54:21Z',
    supply: cd?.ants ?? null,
    currentAllocation: cd?.allocation ?? [], // epoch 22+ ceilings, read live from AntseedEmissionsGate
    legacyAllocation,                          // pre-epoch-22 config, read live (mutable via setShares)
    dynamicShares: { stake, usage },
    distribution,
    contracts: cd?.contracts ?? null,
  };
}

// Stale-while-revalidate: this endpoint never makes the client wait for a
// chain read if ANY cached payload exists (in memory, or persisted from a
// previous process). The response carries `stale` + `fetchedAt` so the UI can
// render real numbers immediately and show a refreshing indicator.
// `?wait=1` forces the old blocking behaviour (used by the refresh poll).
app.get('/api/tokenomics', async (req, res) => {
  try {
    const fresh = tokenomicsCache && Date.now() - tokenomicsCacheAt < TOKENOMICS_TTL_MS;
    if (fresh) return res.json({ ...tokenomicsCache, stale: false });

    // Fall back to the durable cache so a just-restarted process still has
    // something real to show.
    const persisted = !tokenomicsCache ? readPayloadCache('tokenomics') : null;
    const cached = tokenomicsCache || persisted?.data || null;
    const cachedAt = tokenomicsCache ? tokenomicsCacheAt : persisted?.fetchedAt || 0;

    if (cached && req.query.wait !== '1') {
      refreshTokenomics().catch(() => {}); // kick off, don't await
      return res.json({ ...cached, stale: true, fetchedAt: cachedAt });
    }

    const data = await refreshTokenomics();
    res.json({ ...data, stale: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Current-epoch participant rewards (recognized-usage era) ───
// What a buyer/seller has earned *this epoch* — points, plus a "potential
// reward" estimate combining their usage reward (pendingBuyerReward /
// pendingAgentReward — exact on-chain view functions, not a reimplemented
// formula) and, if they hold any lANTS stake position(s), their pending
// pool/staker reward too (previewStakerRewards — also a real on-chain
// preview, not an approximation). Both are genuinely live/moving numbers
// while the epoch is still open. Computed here (not per-request) and
// refreshed hourly by startEpochRewardsPoller — see
// notes/epoch-features-plan.md for the full design and why.
let epochRewardsSyncing = null;

async function syncCurrentEpochRewards() {
  const chain = readChainMetrics();
  const epoch = chain?.emissions?.currentEpoch;
  if (epoch == null) { console.warn('[epoch-rewards] no current epoch yet, skipping'); return; }

  const [buyerEpochsResult, sellerEpochsResult, poolEpochsResult, stakePositionsResult] = await Promise.all([
    fetchBuyerEpochs(epoch).catch((e) => { console.error('[epoch-rewards] buyerEpochs failed:', e.message); return { items: [] }; }),
    fetchSellerEpochs(epoch).catch((e) => { console.error('[epoch-rewards] sellerEpochs failed:', e.message); return { items: [] }; }),
    fetchPoolEpochs(epoch).catch((e) => { console.error('[epoch-rewards] poolEpochs failed:', e.message); return { items: [] }; }),
    fetchOpenStakePositions().catch((e) => { console.error('[epoch-rewards] stakePositions failed:', e.message); return { items: [] }; }),
  ]);
  const buyers = buyerEpochsResult.items;
  const sellers = sellerEpochsResult.items;
  const stakedByAgentId = new Map(poolEpochsResult.items.map((p) => [String(p.agentId), p.activeStake]));

  // owner (lowercased address) -> [positionId, ...], for the pool-reward
  // component. Only ~tens of open positions network-wide as of the
  // recognized-usage era's early weeks, so this stays cheap even fetched
  // in full every sync.
  const positionsByOwner = new Map();
  for (const p of stakePositionsResult.items) {
    const owner = (p.owner || '').toLowerCase();
    if (!owner) continue;
    if (!positionsByOwner.has(owner)) positionsByOwner.set(owner, []);
    positionsByOwner.get(owner).push(p.id);
  }

  // Pool/staker reward preview: one call covering every open position
  // network-wide, then summed back per owner. previewStakerRewards is a
  // pure on-chain simulation (no indexing transaction required) — see
  // SellerPoolsRewardsClient in @antseed/node.
  const poolRewardByOwner = new Map();
  if (sellerPoolsRewardsClient && positionsByOwner.size > 0) {
    try {
      const allIds = [...positionsByOwner.values()].flat();
      const amounts = await sellerPoolsRewardsClient.previewStakerRewards(allIds);
      let cursor = 0;
      for (const [owner, ids] of positionsByOwner) {
        let sum = 0n;
        for (let i = 0; i < ids.length; i++) sum += amounts[cursor + i] ?? 0n;
        cursor += ids.length;
        poolRewardByOwner.set(owner, sum);
      }
    } catch (e) {
      console.error('[epoch-rewards] previewStakerRewards failed:', e.message);
    }
  }

  // Usage reward: batched through the same Multicall3 helper the tokenomics
  // endpoint uses — one or two RPC round-trips for the whole epoch's
  // participants instead of one eth_call per address.
  let usageRewardByBuyer = new Map();
  let usageRewardBySeller = new Map();
  if (usageRewardsTarget && (buyers.length > 0 || sellers.length > 0)) {
    const requests = [
      ...buyers.map((b) => ({ target: usageRewardsTarget, iface: usageRewardsViewIface, method: 'pendingBuyerReward', args: [b.buyer, epoch] })),
      ...sellers.map((s) => ({ target: usageRewardsTarget, iface: usageRewardsViewIface, method: 'pendingAgentReward', args: [s.agentId, epoch] })),
    ];
    const decoded = await multicallView(requests);
    buyers.forEach((b, i) => usageRewardByBuyer.set(b.buyer.toLowerCase(), decoded[i]?.[0] ?? null));
    sellers.forEach((s, i) => usageRewardBySeller.set(s.seller.toLowerCase(), decoded[buyers.length + i]?.[0] ?? null));
  }

  const now = Date.now();
  const upsertBuyer = db.prepare(`
    INSERT INTO buyer_epoch_rewards (address, epoch, points, volume_usdc, requests, usage_reward_wei, pool_reward_wei, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address, epoch) DO UPDATE SET
      points = excluded.points, volume_usdc = excluded.volume_usdc, requests = excluded.requests,
      usage_reward_wei = excluded.usage_reward_wei, pool_reward_wei = excluded.pool_reward_wei, fetched_at = excluded.fetched_at
  `);
  const upsertSeller = db.prepare(`
    INSERT INTO seller_epoch_rewards (address, agent_id, epoch, points, volume_usdc, requests, staked_ants_wei, usage_reward_wei, pool_reward_wei, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address, epoch) DO UPDATE SET
      agent_id = excluded.agent_id, points = excluded.points, volume_usdc = excluded.volume_usdc, requests = excluded.requests,
      staked_ants_wei = excluded.staked_ants_wei, usage_reward_wei = excluded.usage_reward_wei,
      pool_reward_wei = excluded.pool_reward_wei, fetched_at = excluded.fetched_at
  `);
  const tx = db.transaction(() => {
    for (const b of buyers) {
      const addrLower = b.buyer.toLowerCase();
      const usageWei = usageRewardByBuyer.get(addrLower);
      const poolWei = poolRewardByOwner.get(addrLower);
      upsertBuyer.run(
        b.buyer, epoch, b.points, b.volumeUsdc, b.requests,
        usageWei != null ? usageWei.toString() : null,
        poolWei != null ? poolWei.toString() : null,
        now
      );
    }
    for (const s of sellers) {
      const addrLower = s.seller.toLowerCase();
      const usageWei = usageRewardBySeller.get(addrLower);
      const poolWei = poolRewardByOwner.get(addrLower);
      const staked = stakedByAgentId.get(String(s.agentId));
      upsertSeller.run(
        s.seller, String(s.agentId), epoch, s.points, s.volumeUsdc, s.requests,
        staked != null ? String(staked) : null,
        usageWei != null ? usageWei.toString() : null,
        poolWei != null ? poolWei.toString() : null,
        now
      );
    }
  });
  tx();
  console.log(`[epoch-rewards] synced epoch ${epoch}: ${buyers.length} buyers, ${sellers.length} sellers, ${positionsByOwner.size} stakers.`);
}

/** Deduplicated: a second caller mid-sync joins the in-flight run instead of starting another. */
function refreshEpochRewards() {
  if (epochRewardsSyncing) return epochRewardsSyncing;
  epochRewardsSyncing = syncCurrentEpochRewards()
    .catch((e) => console.error('[epoch-rewards] sync failed:', e.message))
    .finally(() => { epochRewardsSyncing = null; });
  return epochRewardsSyncing;
}

/** Hourly refresh, per product decision (these are "how am I doing this
 *  week" numbers, not numbers that need to be live-live) — see
 *  notes/epoch-features-plan.md. */
function startEpochRewardsPoller(seconds = 3600) {
  setInterval(() => { refreshEpochRewards(); }, seconds * 1000);
  refreshEpochRewards();
}

function parsePageParams(req, defaultLimit = 100, maxLimit = 1000) {
  const limit = Math.min(Math.max(Number(req.query.limit) || defaultLimit, 1), maxLimit);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 64);
  return { limit, offset, q };
}

app.get('/api/epoch/buyers', (req, res) => {
  const chain = readChainMetrics();
  const epoch = chain?.emissions?.currentEpoch;
  if (epoch == null) return res.json({ epoch: null, items: [], total: 0, offset: 0, limit: 0, hasMore: false });
  const { limit, offset, q } = parsePageParams(req);
  const where = q ? 'AND address LIKE ?' : '';
  const args = q ? [epoch, `%${q}%`] : [epoch];
  const total = db.prepare(`SELECT COUNT(*) AS c FROM buyer_epoch_rewards WHERE epoch = ? ${where}`).get(...args).c;
  const items = db.prepare(
    `SELECT * FROM buyer_epoch_rewards WHERE epoch = ? ${where} ORDER BY CAST(points AS INTEGER) DESC, address ASC LIMIT ? OFFSET ?`
  ).all(...args, limit, offset);
  res.json({ epoch, items, total, offset, limit, hasMore: offset + items.length < total });
});

app.get('/api/epoch/sellers', (req, res) => {
  const chain = readChainMetrics();
  const epoch = chain?.emissions?.currentEpoch;
  if (epoch == null) return res.json({ epoch: null, items: [], total: 0, offset: 0, limit: 0, hasMore: false });
  const { limit, offset, q } = parsePageParams(req);
  // Sellers are also matched by display name (from the live DHT `sellers`
  // table via agent_id), not just address — the address alone isn't what
  // most visitors recognize a seller by.
  const where = q ? 'AND (r.address LIKE ? OR EXISTS (SELECT 1 FROM sellers s WHERE s.agent_id = r.agent_id AND LOWER(s.name) LIKE ?))' : '';
  const args = q ? [epoch, `%${q}%`, `%${q}%`] : [epoch];
  const total = db.prepare(`SELECT COUNT(*) AS c FROM seller_epoch_rewards r WHERE r.epoch = ? ${where}`).get(...args).c;
  const rows = db.prepare(
    `SELECT r.*, (SELECT s.name FROM sellers s WHERE s.agent_id = r.agent_id LIMIT 1) AS seller_name
     FROM seller_epoch_rewards r WHERE r.epoch = ? ${where}
     ORDER BY CAST(r.points AS INTEGER) DESC, r.address ASC LIMIT ? OFFSET ?`
  ).all(...args, limit, offset);
  res.json({ epoch, items: rows, total, offset, limit, hasMore: offset + rows.length < total });
});

app.post('/api/admin/force-epoch-rewards-sync', requireAdminAuth, async (_req, res) => {
  try {
    await syncCurrentEpochRewards();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Real historical network data (Antscan-sourced, cached in SQLite) ───
app.get('/api/history/overview', (_req, res) => {
  const snap = readLatestSnapshot();
  res.json(snap ?? null);
});

app.get('/api/history/daily', (req, res) => {
  const days = Math.min(Number(req.query.days) || 90, 365);
  res.json(readDailyMetrics(days));
});

app.get('/api/history/epochs', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 50);
  res.json(readEpochMetrics(limit));
});

app.get('/api/history/buyers', (req, res) => {
  // Paginated: the Buyers tab soft-loads pages on scroll instead of pulling
  // all ~1150 rows (and rendering ~1150 DOM rows) up front.
  // Returns a bare array when no pagination is requested, to stay compatible
  // with any caller expecting the previous shape.
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  // Addresses are stored lowercase; searching is a plain substring match.
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 64);
  const items = readBuyersOnchain(limit, offset, q);
  const total = countBuyersOnchain(q);
  res.json({ items, total, offset, limit, hasMore: offset + items.length < total });
});

app.get('/api/history/sellers', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 5000, 5000);
  res.json(readSellersOnchain(limit));
});

app.post('/api/admin/force-history-sync', requireAdminAuth, async (_req, res) => {
  try {
    const data = await runHistorySync();
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/force-chain-sync', requireAdminAuth, async (_req, res) => {
  try {
    const data = await updateChainMetrics();
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Where the current catalog came from. Public and read-only: it reports
// provenance (local buyer node vs hosted snapshot) and how old the underlying
// observations are, so a stale fallback is visible rather than silent.
app.get('/api/catalog-source', (_req, res) => {
  res.json(getLastCatalogSync() ?? { source: null, note: 'no catalog sync has run yet' });
});

app.post('/api/admin/sync', requireAdminAuth, async (_req, res) => {
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
// Epochs last 7 days (EPOCH_DURATION = 604800), so a 10-minute stack cache is
// never meaningfully stale; a 60s TTL used to re-resolve it on most lookups.
const STACK_TTL_MS = 600_000;
const PENDING_TTL_MS = 90_000;
// ANTS balances change whenever a user claims, so this must expire — it
// previously had no TTL at all and served a stale balance indefinitely.
const BALANCE_TTL_MS = 60_000;
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

// ─── Multicall3 batching ───
// One eth_call carries dozens of view reads through Multicall3. This collapses
// the per-epoch fan-outs (~130 reads for a 22-epoch lookup) into 1-3 RPCs —
// critical for latency AND for the tenderly gateway, which queues bursts
// beyond ~30-40 in-flight calls until they die with TIMEOUT errors.
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const multicallProvider = new JsonRpcProvider(emissionsCfg.rpcUrl);
const multicall3 = new Contract(MULTICALL3_ADDRESS, [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
], multicallProvider);

const emissionsTarget = legacyAddresses.legacyEmissionsContractAddress;
const emissionsV1Target = legacyAddresses.legacyEmissionsV1ContractAddress || EMISSIONS_V1_FALLBACK;
const usageAccountingTarget = emissionsCfg.usageAccountingAddress || null;
const usageRewardsTarget = emissionsCfg.usageRewardsAddress || null;

const emissionsViewIface = new Interface([
  'function userSellerPoints(address account, uint256 epoch) view returns (uint256)',
  'function userBuyerPoints(address account, uint256 epoch) view returns (uint256)',
  'function sellerEpochClaimed(address account, uint256 epoch) view returns (bool)',
  'function buyerEpochClaimed(address account, uint256 epoch) view returns (bool)',
  'function epochTotalSellerPoints(uint256 epoch) view returns (uint256)',
  'function epochTotalBuyerPoints(uint256 epoch) view returns (uint256)',
  'function getEpochEmission(uint256 epoch) view returns (uint256)',
  'function pendingEmissions(address account, uint256[] epochs) view returns (uint256 seller, uint256 buyer)',
]);
const usageAccountingViewIface = new Interface([
  'function sellerPointsByEpoch(uint256 epoch, address seller) view returns (uint256)',
  'function buyerPointsByEpoch(uint256 epoch, address buyer) view returns (uint256)',
  'function pendingEmissions(address account, uint256[] epochs) view returns (uint256 seller, uint256 buyer)',
]);
const usageRewardsViewIface = new Interface([
  'function agentEpochClaimed(uint256 agentId, uint256 epoch) view returns (bool)',
  'function pendingAgentReward(uint256 agentId, uint256 epoch) view returns (uint256)',
  'function buyerEpochClaimed(address buyer, uint256 epoch) view returns (bool)',
  'function pendingBuyerReward(address buyer, uint256 epoch) view returns (uint256)',
]);
// minterEpochMinted = ANTS actually minted against a bucket's budget (as
// opposed to minterEpochBudget, which is only the epoch's ceiling). Not
// exposed on the SDK client, so it's batched through multicallView.
const gateMintedIface = new Interface([
  'function minterEpochMinted(bytes32 minterId, uint256 epoch) view returns (uint256)',
]);

// Batched view reads: each request is { target, iface, method, args }; the
// result is the decoded args array per request, or null for a reverting read.
// A chunk that fails as a whole (RPC timeout, gas cap) is split and retried;
// a single call that still fails yields null like a reverting read.
async function multicallView(requests, options = {}) {
  if (requests.length === 0) return [];
  const chunkSize = options.chunkSize ?? 100;
  const concurrency = Math.max(1, options.concurrency ?? 3);
  const results = new Array(requests.length).fill(null);
  const run = async (offset, size) => {
    const chunk = requests.slice(offset, offset + size);
    if (chunk.length === 0) return;
    const calls = chunk.map((r) => ({ target: r.target, allowFailure: true, callData: r.iface.encodeFunctionData(r.method, r.args) }));
    let returned;
    try {
      returned = await multicall3.getFunction('aggregate3').staticCall(calls);
    } catch {
      if (chunk.length === 1) return;
      const half = Math.ceil(chunk.length / 2);
      await run(offset, half);
      await run(offset + half, chunk.length - half);
      return;
    }
    returned.forEach((entry, index) => {
      const r = chunk[index];
      if (!entry.success || entry.returnData === '0x') return;
      try {
        results[offset + index] = [...r.iface.decodeFunctionResult(r.method, entry.returnData)];
      } catch {
        results[offset + index] = null;
      }
    });
  };
  const offsets = Array.from({ length: Math.ceil(requests.length / chunkSize) }, (_, index) => index * chunkSize);
  await Promise.all(Array.from({ length: Math.min(concurrency, offsets.length) }, async () => {
    for (let next = offsets.shift(); next !== undefined; next = offsets.shift()) await run(next, chunkSize);
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

function readCachedEpochTotals(epoch, currentEpoch) {
  const cached = epochTotalsGet.get(EPOCH_TOTALS_KEY, epoch);
  if (!cached) return null;
  try {
    const parsed = JSON.parse(cached.data);
    const age = Date.now() - parsed.fetchedAt;
    if (parsed.wasCurrent) {
      if (epoch >= currentEpoch && age < EPOCH_TOTALS_CURRENT_TTL_MS) return parsed;
    } else if (epoch < currentEpoch && age < EPOCH_TOTALS_CLOSED_TTL_MS) {
      return parsed;
    }
  } catch { /* corrupt row — treat as a miss */ }
  return null;
}

// Totals for all requested epochs: served from the epoch_history cache, with
// the misses fetched in ONE multicall round and persisted back.
async function loadEpochTotalsBatch(epochs, currentEpoch) {
  const entries = new Map();
  const missing = [];
  for (const epoch of epochs) {
    const cached = readCachedEpochTotals(epoch, currentEpoch);
    if (cached) entries.set(epoch, cached);
    else missing.push(epoch);
  }
  if (missing.length > 0) {
    const requests = [];
    for (const epoch of missing) {
      requests.push({ target: emissionsTarget, iface: emissionsViewIface, method: 'epochTotalSellerPoints', args: [epoch] });
      requests.push({ target: emissionsTarget, iface: emissionsViewIface, method: 'epochTotalBuyerPoints', args: [epoch] });
      requests.push({ target: emissionsTarget, iface: emissionsViewIface, method: 'getEpochEmission', args: [epoch] });
    }
    const decoded = await multicallView(requests);
    missing.forEach((epoch, i) => {
      const sellerPts = decoded[i * 3];
      const buyerPts = decoded[i * 3 + 1];
      const emission = decoded[i * 3 + 2];
      // multicallView returns null for any call that failed (reverted, or a
      // chunk that errored even after splitting to size 1). Previously these
      // were coerced with `?? 0n` into a real-looking "0" and PERSISTED for
      // up to 6 hours under the shared __epoch_totals__ key — so one
      // transient gateway timeout poisoned that epoch's totals for every
      // address, silently reporting zero points / zero emission (and hence
      // zero rewards) as if they were real on-chain values. Skip caching
      // unless all three reads actually resolved; a miss just gets retried
      // on the next request.
      if (sellerPts?.[0] == null || buyerPts?.[0] == null || emission?.[0] == null) return;
      const entry = {
        fetchedAt: Date.now(),
        wasCurrent: epoch >= currentEpoch,
        totalSellerPts: String(sellerPts[0]),
        totalBuyerPts: String(buyerPts[0]),
        emission: String(emission[0]),
      };
      epochTotalsPut.run(EPOCH_TOTALS_KEY, epoch, JSON.stringify(entry));
      entries.set(epoch, entry);
    });
  }
  return entries;
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

  // ── Multicall rounds instead of ~180 individual eth_calls ──
  // Round 0: epoch-level totals (address-independent; served from epoch_history).
  const totalsByEpoch = await loadEpochTotalsBatch(epochs, currentEpoch);

  // Live share/cap params for the current-epoch reward estimate below. These
  // are mutable on-chain (setShares), so they must not be hardcoded. Null on
  // failure -> the estimate is skipped rather than computed from guesses.
  const epochParams = await emissionsClient.getShares()
    .then((p) => (p && p.initialized ? p : null))
    .catch(() => null);

  // Round 1: batched pending totals for the whole epoch set + points/claim flags
  // for every (address, epoch) on V2 and V1 — one multicallView fan-out.
  const totalsRequests = [];
  for (const addr of uniqueAddresses) {
    totalsRequests.push({ target: emissionsTarget, iface: emissionsViewIface, method: 'pendingEmissions', args: [addr, epochs] });
  }
  const v1EpochsInSet = epochs.filter((e) => e <= MIGRATION_EPOCH);
  if (v1EpochsInSet.length > 0) {
    for (const addr of uniqueAddresses) {
      totalsRequests.push({ target: emissionsV1Target, iface: emissionsViewIface, method: 'pendingEmissions', args: [addr, v1EpochsInSet] });
    }
  }
  const pass1Requests = [];
  const pass1Slots = [];
  epochs.forEach((epoch, epochIdx) => {
    for (const addr of uniqueAddresses) {
      for (const [field, method] of [['sp', 'userSellerPoints'], ['bp', 'userBuyerPoints'], ['sc', 'sellerEpochClaimed'], ['bc', 'buyerEpochClaimed']]) {
        pass1Slots.push({ epochIdx, addr, field });
        pass1Requests.push({ target: emissionsTarget, iface: emissionsViewIface, method, args: [addr, epoch] });
      }
      if (epoch <= MIGRATION_EPOCH) {
        for (const [field, method] of [['v1sp', 'userSellerPoints'], ['v1bp', 'userBuyerPoints']]) {
          pass1Slots.push({ epochIdx, addr, field });
          pass1Requests.push({ target: emissionsV1Target, iface: emissionsViewIface, method, args: [addr, epoch] });
        }
        if (epoch < MIGRATION_EPOCH) {
          for (const [field, method] of [['v1sc', 'sellerEpochClaimed'], ['v1bc', 'buyerEpochClaimed']]) {
            pass1Slots.push({ epochIdx, addr, field });
            pass1Requests.push({ target: emissionsV1Target, iface: emissionsViewIface, method, args: [addr, epoch] });
          }
        }
      }
    }
  });
  const round1 = await multicallView([...totalsRequests, ...pass1Requests]);
  const round1Totals = round1.slice(0, totalsRequests.length);
  const pass1 = round1.slice(totalsRequests.length);

  // Decode round 1: per-epoch map of addr → { sp, bp, sc, bc, v1sp, v1bp, v1sc, v1bc }
  const pointsByEpoch = epochs.map(() => new Map());
  pass1.forEach((decoded, i) => {
    const { epochIdx, addr, field } = pass1Slots[i];
    let perAddr = pointsByEpoch[epochIdx].get(addr);
    if (!perAddr) {
      perAddr = {};
      pointsByEpoch[epochIdx].set(addr, perAddr);
    }
    if (decoded === null) return;
    if (field === 'sp' || field === 'bp' || field === 'v1sp' || field === 'v1bp') {
      perAddr[field] = Number(decoded[0]);
    } else {
      perAddr[field] = decoded[0] === true;
    }
  });

  // Round 2: pendingEmissions per (address, epoch) for non-current epochs where
  // the address earned points (V2 always; V1 for epochs ≤ MIGRATION_EPOCH).
  const pass2Requests = [];
  const pass2Slots = [];
  epochs.forEach((epoch, epochIdx) => {
    if (epoch >= currentEpoch) return;
    for (const addr of uniqueAddresses) {
      const a = pointsByEpoch[epochIdx].get(addr) || {};
      if ((a.sp || 0) === 0 && (a.bp || 0) === 0 && (a.v1sp || 0) === 0 && (a.v1bp || 0) === 0) continue;
      pass2Slots.push({ epochIdx, addr, contract: 'v2' });
      pass2Requests.push({ target: emissionsTarget, iface: emissionsViewIface, method: 'pendingEmissions', args: [addr, [epoch]] });
      if (epoch <= MIGRATION_EPOCH) {
        pass2Slots.push({ epochIdx, addr, contract: 'v1' });
        pass2Requests.push({ target: emissionsV1Target, iface: emissionsViewIface, method: 'pendingEmissions', args: [addr, [epoch]] });
      }
    }
  });
  const pass2 = await multicallView(pass2Requests);
  const pendingByEpoch = epochs.map(() => new Map());
  pass2.forEach((decoded, i) => {
    const { epochIdx, addr, contract } = pass2Slots[i];
    let perAddr = pendingByEpoch[epochIdx].get(addr);
    if (!perAddr) {
      perAddr = { v2: null, v1: null };
      pendingByEpoch[epochIdx].set(addr, perAddr);
    }
    perAddr[contract] = decoded ? { seller: Number(decoded[0]) / 1e18, buyer: Number(decoded[1]) / 1e18 } : null;
  });

  // Aggregate per epoch (same semantics as the per-call version).
  const epochDetails = epochs.map((epoch, epochIdx) => {
  const isCurrent = epoch >= currentEpoch;
  // A missing entry means the on-chain read did not resolve (see
  // loadEpochTotalsBatch — we no longer fabricate zeros for failed calls).
  // Flag it so the current-epoch estimate below reports null instead of a
  // confident-looking 0 reward.
  const totals = totalsByEpoch.get(epoch);
  const totalsUnavailable = !totals;
  const totalSellerPts = Number(totals?.totalSellerPts || 0);
  const totalBuyerPts = Number(totals?.totalBuyerPts || 0);
  const emissionAmount = Number(totals?.emission || 0) / 1e18;

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

  for (const addr of uniqueAddresses) {
    const { sp = 0, bp = 0, sc = false, bc = false, v1sp = 0, v1bp = 0, v1sc = false, v1bc = false } = pointsByEpoch[epochIdx].get(addr) || {};
    const userSellerPts = sp + v1sp;
    const userBuyerPts = bp + v1bp;

    if (userSellerPts > 0 || userBuyerPts > 0) {
      epochSellerPts += userSellerPts;
      epochBuyerPts += userBuyerPts;

      if (!isCurrent) {
        const p = pendingByEpoch[epochIdx].get(addr);
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

  if (isCurrent && !totalsUnavailable && epochParams) {
    // These shares used to be hardcoded as 0.5 / 0.2. They are mutable
    // on-chain via setShares(), and the per-seller cap (maxSellerSharePct)
    // was omitted entirely — so a dominant seller's displayed current-epoch
    // reward could be up to 2x the real claimable amount. Mirror
    // AntseedEmissions.pendingEmissions: reward = userPts/totalPts * budget,
    // clamped to budget * maxSellerSharePct / 100.
    const sellerBudget = emissionAmount * (epochParams.sellerSharePct / 100);
    const buyerBudget = emissionAmount * (epochParams.buyerSharePct / 100);
    const maxSellerReward = sellerBudget * (epochParams.maxSellerSharePct / 100);
    for (const addr of uniqueAddresses) {
      const { sp = 0, bp = 0, v1sp = 0, v1bp = 0 } = pointsByEpoch[epochIdx].get(addr) || {};
      const userSellerPts = sp + v1sp;
      const userBuyerPts = bp + v1bp;
      if (userSellerPts > 0 && totalSellerPts > 0) {
        const raw = (userSellerPts / totalSellerPts) * sellerBudget;
        epochSellerReward += Math.min(raw, maxSellerReward);
      }
      if (userBuyerPts > 0 && totalBuyerPts > 0) {
        epochBuyerReward += (userBuyerPts / totalBuyerPts) * buyerBudget;
      }
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
  // Pending totals over the whole epoch set (V2 + V1) already came back in
  // round 1: first one entry per address from V2, then one per address from V1.
  {
    const n = uniqueAddresses.length;
    for (let i = 0; i < n; i++) {
      const v2 = round1Totals[i];
      if (v2) {
        sellerTotal += Number(v2[0]) / 1e18;
        buyerTotal += Number(v2[1]) / 1e18;
      }
      if (v1EpochsInSet.length > 0) {
        const v1 = round1Totals[n + i];
        if (v1) {
          sellerTotal += Number(v1[0]) / 1e18;
          buyerTotal += Number(v1[1]) / 1e18;
        }
      }
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

    // This cache previously had NO TTL: the row stored fetched_at but never
    // compared it, so once an address was queried its ANTS balance was
    // frozen forever. After a user claimed rewards the dashboard kept
    // showing their pre-claim balance until the SQLite file was deleted.
    const bust = req.query.bust === '1';
    const cached = db.prepare('SELECT ants, fetched_at FROM address_balances WHERE address = ?').get(address.toLowerCase());
    if (!bust && cached && Date.now() - Number(cached.fetched_at ?? 0) < BALANCE_TTL_MS) {
      return res.json({ ants: cached.ants, cached: true });
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
  const epochs = stack.recognizedEpochs;
  // One multicall: batched pending total (slot 0) + per-epoch rows. With an
  // agentId every epoch is [claimed, amount, points]; without, just [points].
  const requests = [{ target: usageAccountingTarget, iface: usageAccountingViewIface, method: 'pendingEmissions', args: [address, epochs] }];
  for (const epoch of epochs) {
    if (agentId) {
      requests.push({ target: usageRewardsTarget, iface: usageRewardsViewIface, method: 'agentEpochClaimed', args: [agentId, epoch] });
      requests.push({ target: usageRewardsTarget, iface: usageRewardsViewIface, method: 'pendingAgentReward', args: [agentId, epoch] });
    }
    requests.push({ target: usageAccountingTarget, iface: usageAccountingViewIface, method: 'sellerPointsByEpoch', args: [epoch, address] });
  }
  const decoded = await multicallView(requests);
  const total = decoded[0] ? BigInt(decoded[0][0]) : 0n;
  const rows = [];
  let i = 1;
  for (const epoch of epochs) {
    let claimed = false;
    let amount = 0n;
    if (agentId) {
      claimed = !!decoded[i] && decoded[i][0] === true;
      amount = decoded[i + 1] ? BigInt(decoded[i + 1][0]) : 0n;
      i += 2;
    }
    const points = decoded[i] ? BigInt(decoded[i][0]) : 0n;
    i += 1;
    rows.push({
      epoch,
      points: Number(points) / 1e6,
      amount: claimed ? 0 : Number(amount) / 1e18,
      claimed,
    });
  }
  return { total, epochs: rows };
}

async function loadBuyerUsageRewards(address, stack) {
  if (stack.phase !== 'active' || !usageRewardsClient || stack.recognizedEpochs.length === 0) {
    return { total: 0n, epochs: [] };
  }
  const epochs = stack.recognizedEpochs;
  const includePoints = !!usageAccountingClient;
  // One multicall: per epoch [claimed, amount, points?].
  const requests = [];
  for (const epoch of epochs) {
    requests.push({ target: usageRewardsTarget, iface: usageRewardsViewIface, method: 'buyerEpochClaimed', args: [address, epoch] });
    requests.push({ target: usageRewardsTarget, iface: usageRewardsViewIface, method: 'pendingBuyerReward', args: [address, epoch] });
    if (includePoints) {
      requests.push({ target: usageAccountingTarget, iface: usageAccountingViewIface, method: 'buyerPointsByEpoch', args: [epoch, address] });
    }
  }
  const decoded = await multicallView(requests);
  const rows = [];
  let total = 0n;
  let i = 0;
  for (const epoch of epochs) {
    const claimed = !!decoded[i] && decoded[i][0] === true;
    const amount = decoded[i + 1] ? BigInt(decoded[i + 1][0]) : 0n;
    i += 2;
    let points = 0n;
    if (includePoints) {
      points = decoded[i] ? BigInt(decoded[i][0]) : 0n;
      i += 1;
    }
    const effective = claimed ? 0n : amount;
    total += effective;
    rows.push({
      epoch,
      points: Number(points) / 1e6,
      amount: Number(effective) / 1e18,
      claimed,
    });
  }
  return { total, epochs: rows };
}

async function loadLegacyRewards(address, stack) {
  if (stack.legacyEpochs.length === 0) return { seller: 0, buyer: 0 };
  const v1Epochs = stack.legacyEpochs.filter((e) => e <= MIGRATION_EPOCH);
  // One multicall: V2 pending over all legacy epochs + V1 pending over the
  // pre-migration subset.
  const requests = [
    { target: emissionsTarget, iface: emissionsViewIface, method: 'pendingEmissions', args: [address, stack.legacyEpochs] },
  ];
  if (v1Epochs.length > 0) {
    requests.push({ target: emissionsV1Target, iface: emissionsViewIface, method: 'pendingEmissions', args: [address, v1Epochs] });
  }
  const decoded = await multicallView(requests);
  const v2 = decoded[0] || [0n, 0n];
  const v1 = v1Epochs.length > 0 ? (decoded[1] || [0n, 0n]) : [0n, 0n];
  return {
    seller: Number(v2[0]) / 1e18 + Number(v1[0]) / 1e18,
    buyer: Number(v2[1]) / 1e18 + Number(v1[1]) / 1e18,
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

// ============================================================
// LOCAL ONLY — DO NOT COMMIT THIS BLOCK. Personal page (not project-
// related), explicitly asked to stay off GitHub. Serves ../private/osaka/
// (gitignored) at antseed-zh.com/osaka. If you're about to `git add -A` or
// commit this file for unrelated work, exclude this hunk.
const osakaDir = path.join(__dirname, '../private/osaka');
if (fs.existsSync(osakaDir)) {
  // Lets the checklist page (list/index.html) submit picks with a button
  // instead of the picks only living in that browser's localStorage —
  // writes to private/osaka/picks.json (gitignored, same as this whole
  // directory) so they can just be read from disk, no messaging needed.
  app.post('/osaka/api/picks', (req, res) => {
    try {
      const { picks } = req.body || {};
      if (!Array.isArray(picks)) return res.status(400).json({ error: 'picks must be an array' });
      fs.writeFileSync(
        path.join(osakaDir, 'picks.json'),
        JSON.stringify({ picks, submittedAt: new Date().toISOString() }, null, 2)
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.use('/osaka', express.static(osakaDir));
}
// ============================================================

// Two static builds share this backend: `dist` (base='/zh/', served behind
// the 5.223.54.56:8088/zh path-prefix proxy) and `dist-root` (base='/',
// served at antseed-zh.com root). Pick by Host header so nginx can just
// proxy_pass everything here for the dedicated domain, instead of needing
// filesystem read access under /root (which stays 700).
const ROOT_DOMAIN_HOSTS = new Set(['antseed-zh.com', 'www.antseed-zh.com']);
function staticDirFor(req) {
  const host = (req.hostname || '').toLowerCase();
  return ROOT_DOMAIN_HOSTS.has(host) ? '../dist-root' : '../dist';
}

app.use((req, res, next) => {
  express.static(path.join(__dirname, staticDirFor(req)))(req, res, next);
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, staticDirFor(req), 'index.html'));
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`AntSeed Dashboard + API running on http://0.0.0.0:${PORT}`);
  // Sync real historical/network data first (Antscan-sourced, cached locally
  // in SQLite — closed days are never re-fetched/overwritten) so the DHT
  // sync below can match sellers to real on-chain earnings by agentId.
  await runHistorySync().catch((e) => console.error('[history-sync] initial run failed:', e.message));
  // Sync the live peer/service catalog. Primary source is the LOCAL buyer
  // node's DHT view (`/_antseed/peers`); the hosted network.antseed.com
  // snapshot is only a fallback, because it lags well behind.
  await syncFromOfficialNetwork();
  // Start background poller for on-chain metrics (every 5 minutes)
  startChainPoller(300);
  console.log('Chain metrics poller started (refresh every 5 min).');
  // Keep history in sync on the same cadence going forward (already ran once above).
  startHistorySync(300, { runImmediately: false });
  console.log('History sync started (refresh every 5 min).');

  // Current-epoch buyer/seller points + potential-reward estimates, hourly
  // (these are "how's my week going" numbers, not live-live ones — see
  // notes/epoch-features-plan.md). Runs after the chain poller so
  // readChainMetrics() already has a current epoch to sync against.
  startEpochRewardsPoller(3600);
  console.log('Epoch rewards poller started (refresh every hour).');

  // Warm the tokenomics cache in the background. It needs the chain poller's
  // data, so it runs after startChainPoller. Until it lands, requests are
  // served from the persisted payload_cache, so nobody waits on the ~42s
  // cold chain read.
  const warmedFrom = readPayloadCache('tokenomics');
  if (warmedFrom) {
    console.log(`Tokenomics served from persisted cache (${new Date(warmedFrom.fetchedAt).toISOString()}) while refreshing.`);
  }
  refreshTokenomics()
    .then(() => console.log('Tokenomics cache warmed.'))
    .catch((e) => console.error('[tokenomics] warm failed:', e.message));
});
