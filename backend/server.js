import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { EmissionsClient, ANTSTokenClient, DepositsClient, resolveChainConfig } from '@antseed/node';
import { readChainMetrics, updateChainMetrics, startChainPoller } from './chain-poller.js';
import { syncFromOfficialNetwork } from './sync-official.js';
import { startCacheCleanup } from './lib/cache.js';
import { readBoolEnv } from './lib/env.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerCoreRoutes } from './routes/core.js';
import { registerEmissionsRoutes } from './routes/emissions.js';
import { registerProviderRoutes } from './routes/provider.js';

const PROVIDER_BASE = process.env.PROVIDER_BASE_URL || 'http://localhost:8377/v1';
const PORT = process.env.PORT || 3001;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const ENABLE_ADMIN_ROUTES = readBoolEnv('ENABLE_ADMIN_ROUTES', true);
const SHOULD_SYNC_ON_STARTUP = readBoolEnv('SYNC_ON_STARTUP', true);
const SHOULD_START_CHAIN_POLLER = readBoolEnv('START_CHAIN_POLLER', true);
const SHOULD_START_CACHE_CLEANUP = readBoolEnv('START_CACHE_CLEANUP', true);
const EMISSIONS_V1_ADDRESS = '0x36877fBa8Fa333aa46a1c57b66D132E4995C86b5';
const MIGRATION_EPOCH = 4;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

function requireAdminAccess(req, res, next) {
  if (!ENABLE_ADMIN_ROUTES) {
    return res.status(403).json({ error: 'Admin routes are disabled' });
  }

  if (!ADMIN_API_KEY) {
    return res.status(503).json({ error: 'Admin API key is not configured' });
  }

  const providedKey = req.header('x-admin-api-key');
  if (providedKey !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

async function loadBuyerEvmAddress() {
  try {
    const { identityFromPrivateKeyHex } = await import('@antseed/node');
    const fs = await import('fs');
    const nodePath = await import('path');
    const identityPath = nodePath.join(process.env.HOME, '.antseed', 'identity.key');
    const identityHex = process.env.ANTSEED_IDENTITY_HEX || fs.readFileSync(identityPath, 'utf8').trim();
    const identity = identityFromPrivateKeyHex(identityHex);
    const address = identity.wallet.address;
    console.log(`Buyer EVM address (from identity): ${address}`);
    return address;
  } catch (error) {
    console.warn('Could not load buyer identity:', error.message);
    return null;
  }
}

const emissionsCfg = resolveChainConfig('base-mainnet');
const buyerEvmAddress = await loadBuyerEvmAddress();

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

registerCoreRoutes(app);
registerAdminRoutes(app, { requireAdminAccess, updateChainMetrics, syncFromOfficialNetwork });
registerProviderRoutes(app, {
  providerBase: PROVIDER_BASE,
  emissionsCfg: {
    ...emissionsCfg,
    depositsClient,
    buyerEvmAddress,
  },
});
registerEmissionsRoutes(app, {
  readChainMetrics,
  emissionsClient,
  emissionsV1Client,
  antsTokenClient,
  migrationEpoch: MIGRATION_EPOCH,
});

app.use(express.static(path.join(__dirname, '../dist')));

app.use('/api', (error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({ error: error.message || 'Internal Server Error' });
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`AntSeed Dashboard + API running on http://0.0.0.0:${PORT}`);

  if (SHOULD_SYNC_ON_STARTUP) {
    try {
      await syncFromOfficialNetwork();
      console.log('Startup sync completed.');
    } catch (error) {
      console.error('Startup sync failed:', error.message || error);
    }
  } else {
    console.log('Startup sync disabled by SYNC_ON_STARTUP.');
  }

  if (SHOULD_START_CHAIN_POLLER) {
    startChainPoller(300);
    console.log('Chain metrics poller started (refresh every 5 min).');
  } else {
    console.log('Chain metrics poller disabled by START_CHAIN_POLLER.');
  }

  if (SHOULD_START_CACHE_CLEANUP) {
    startCacheCleanup();
    console.log('Cache cleanup started.');
  } else {
    console.log('Cache cleanup disabled by START_CACHE_CLEANUP.');
  }
});
