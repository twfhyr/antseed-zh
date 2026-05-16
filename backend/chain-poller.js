import { DepositsClient, EmissionsClient, ANTSTokenClient, resolveChainConfig } from '@antseed/node';
import db from './database.js';

let intervalId = null;

export function startChainPoller(seconds = 300) {
  if (intervalId) clearInterval(intervalId);
  intervalId = setInterval(async () => {
    try {
      await updateChainMetrics();
      console.log('[poller] Chain metrics synced via official SDK.');
    } catch (e) {
      console.error('[poller] Failed to sync chain metrics:', e.message || e);
    }
  }, seconds * 1000);
  // Run once immediately
  updateChainMetrics().catch(e => console.error('[poller] Initial sync failed:', e.message || e));
}

export async function updateChainMetrics() {
  const cfg = resolveChainConfig('base-mainnet');

  const depositsClient = new DepositsClient({
    rpcUrl: cfg.rpcUrl,
    fallbackRpcUrls: cfg.fallbackRpcUrls,
    contractAddress: cfg.depositsContractAddress,
    usdcAddress: cfg.usdcContractAddress,
    evmChainId: cfg.evmChainId,
  });

  const emissionsClient = new EmissionsClient({
    rpcUrl: cfg.rpcUrl,
    fallbackRpcUrls: cfg.fallbackRpcUrls,
    contractAddress: cfg.emissionsContractAddress,
    evmChainId: cfg.evmChainId,
  });

  const antsTokenClient = new ANTSTokenClient({
    rpcUrl: cfg.rpcUrl,
    fallbackRpcUrls: cfg.fallbackRpcUrls,
    contractAddress: cfg.antsTokenAddress,
    evmChainId: cfg.evmChainId,
  });

  const data = {
    ants: {},
    emissions: {},
    usdc: {},
  };

  // ANTS totalSupply
  try {
    const supply = await antsTokenClient.totalSupply();
    data.ants.totalSupply = Number(supply) / 1e18;
    data.ants.maxSupply = 1_040_000_000;
  } catch (e) {
    data.ants.error = e.shortMessage || e.message;
  }

  // Emissions
  try {
    const epochInfo = await emissionsClient.getEpochInfo();
    data.emissions.currentEpoch = Number(epochInfo.epoch);
    const emission = await emissionsClient.getEpochEmission(epochInfo.epoch);
    data.emissions.currentRate = Number(emission) / 1e18;
    const genesis = await emissionsClient.getGenesis();
    data.emissions.genesis = Number(genesis);
    const halving = await emissionsClient.getHalvingInterval();
    data.emissions.halvingInterval = Number(halving);
  } catch (e) {
    data.emissions.error = e.shortMessage || e.message;
  }

  // USDC balance of Deposits contract
  try {
    const bal = await depositsClient.getUSDCBalance(cfg.depositsContractAddress);
    data.usdc.depositsBalance = Number(bal) / 1e6;
  } catch (e) {
    data.usdc.error = e.shortMessage || e.message;
  }

  // USDC balance of Channels contract
  try {
    const bal = await depositsClient.getUSDCBalance(cfg.channelsContractAddress);
    data.usdc.channelsBalance = Number(bal) / 1e6;
  } catch (e) {
    data.usdc.channelsBalance = 0;
  }

  // Insert / update DB
  const insert = db.prepare(`
    INSERT INTO chain_metrics (
      id, fetched_at, ants_total_supply, ants_max_supply,
      emissions_epoch, emissions_rate, emissions_genesis, emissions_halving,
      usdc_deposits_balance, usdc_channels_balance, rpc_url
    )
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      fetched_at = excluded.fetched_at,
      ants_total_supply = excluded.ants_total_supply,
      ants_max_supply = excluded.ants_max_supply,
      emissions_epoch = excluded.emissions_epoch,
      emissions_rate = excluded.emissions_rate,
      emissions_genesis = excluded.emissions_genesis,
      emissions_halving = excluded.emissions_halving,
      usdc_deposits_balance = excluded.usdc_deposits_balance,
      usdc_channels_balance = excluded.usdc_channels_balance,
      rpc_url = excluded.rpc_url
  `);

  insert.run(
    Date.now(),
    data.ants.totalSupply ?? null, data.ants.maxSupply ?? null,
    data.emissions.currentEpoch ?? null, data.emissions.currentRate ?? null,
    data.emissions.genesis ?? null, data.emissions.halvingInterval ?? null,
    data.usdc.depositsBalance ?? null, data.usdc.channelsBalance ?? null,
    cfg.rpcUrl
  );

  return data;
}

export function readChainMetrics() {
  const row = db.prepare('SELECT * FROM chain_metrics WHERE id = 1').get();
  if (!row) return null;
  return {
    timestamp: row.fetched_at,
    rpcUrl: row.rpc_url,
    contracts: {
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      registry: '0xf33fC901BFa97326379A369401F4490E231B69B0',
      deposits: '0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2',
      channels: '0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d',
      staking: '0x3652E6B22919bd322A25723B94BB207602E5c8e6',
      stats: '0x15649ff076BFa5e37e24EE3154a00503149954Fd',
      emissions: '0xF13bE52c4A3afC6AE29536f073588d01A0564088',
      antsToken: '0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263',
      identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    },
    ants: {
      totalSupply: row.ants_total_supply,
      maxSupply: row.ants_max_supply,
    },
    emissions: {
      currentEpoch: row.emissions_epoch,
      currentRate: row.emissions_rate,
      genesis: row.emissions_genesis,
      halvingInterval: row.emissions_halving,
    },
    usdc: {
      depositsBalance: row.usdc_deposits_balance,
      channelsBalance: row.usdc_channels_balance,
    },
  };
}
