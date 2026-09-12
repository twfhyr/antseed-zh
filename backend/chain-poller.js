import {
  DepositsClient, EmissionsClient, EmissionsGateClient, ANTSTokenClient,
  resolveChainConfig, resolveLegacyContractAddresses, GATE_MINTERS, gateMinterId,
} from '@antseed/node';
import db from './database.js';

let intervalId = null;

// Schema additions for older databases (idempotent).
for (const column of ['emissions_effective_epoch INTEGER', 'emissions_duration INTEGER', 'allocation_json TEXT']) {
  try { db.prepare(`ALTER TABLE chain_metrics ADD COLUMN ${column}`).run(); } catch (_) {}
}

export function startChainPoller(seconds = 300) {
  if (intervalId) clearInterval(intervalId);
  intervalId = setInterval(async () => {
    try {
      await updateChainMetrics();
      console.log('[poller] Chain metrics synced via official SDK.');
    } catch (e) {
      console.error('[poller] Failed to sync chain metrics:', e.shortMessage || e.message || e);
    }
  }, seconds * 1000);
  // Run once immediately
  updateChainMetrics().catch(e => console.error('[poller] Initial sync failed:', e.shortMessage || e.message || e));
}

function baseClientConfig(cfg) {
  return { rpcUrl: cfg.rpcUrl, fallbackRpcUrls: cfg.fallbackRpcUrls, evmChainId: cfg.evmChainId };
}

export async function updateChainMetrics() {
  const cfg = resolveChainConfig('base-mainnet');
  const legacy = resolveLegacyContractAddresses(cfg);

  const antsTokenClient = new ANTSTokenClient({ ...baseClientConfig(cfg), contractAddress: cfg.antsTokenAddress });
  const depositsClient = new DepositsClient({
    ...baseClientConfig(cfg),
    contractAddress: cfg.depositsContractAddress,
    usdcAddress: cfg.usdcContractAddress,
  });
  const legacyEmissionsClient = new EmissionsClient({ ...baseClientConfig(cfg), contractAddress: legacy.legacyEmissionsContractAddress });
  const gateClient = cfg.emissionsGateAddress ? new EmissionsGateClient({ ...baseClientConfig(cfg), contractAddress: cfg.emissionsGateAddress }) : null;

  const data = { ants: {}, emissions: {}, usdc: {}, allocation: [] };

  // ANTS totalSupply + maxSupply (both read from the token contract)
  try {
    const [supply, maxSupply] = await Promise.all([antsTokenClient.totalSupply(), antsTokenClient.maxSupply()]);
    data.ants.totalSupply = Number(supply) / 1e18;
    data.ants.maxSupply = Number(maxSupply) / 1e18;
  } catch (e) {
    data.ants.error = e.shortMessage || e.message;
  }

  // Epoch clock: the M001 emissions gate owns the schedule since epoch 22; it
  // inherits the legacy V1/V2 clock, so both agree. Prefer the gate when the
  // recognized-usage deployment is configured, fall back to legacy V2.
  try {
    let epoch, rate, genesis, halving, duration, effectiveEpoch = null;
    if (gateClient) {
      [epoch, genesis, halving, duration] = await Promise.all([
        gateClient.currentEpoch(), gateClient.genesis(), gateClient.halvingInterval(), gateClient.epochDuration(),
      ]);
      rate = Number(await gateClient.currentEmissionRate()) / 1e18;
      effectiveEpoch = await gateClient.effectiveEpoch();
    } else {
      const epochInfo = await legacyEmissionsClient.getEpochInfo();
      epoch = Number(epochInfo.epoch);
      duration = epochInfo.epochDuration;
      rate = Number(await legacyEmissionsClient.getEpochEmission(epochInfo.epoch)) / 1e18;
      genesis = Number(await legacyEmissionsClient.getGenesis());
      halving = Number(await legacyEmissionsClient.getHalvingInterval());
    }
    data.emissions.currentEpoch = epoch;
    data.emissions.currentRate = rate;
    data.emissions.genesis = genesis;
    data.emissions.halvingInterval = halving;
    data.emissions.epochDuration = duration;
    data.emissions.effectiveEpoch = effectiveEpoch;
  } catch (e) {
    data.emissions.error = e.shortMessage || e.message;
  }

  // Allocation ceilings (gate minters: seller-pools 40%, usage 20%, team 15%, reserve 15%, verification 10%)
  if (gateClient) {
    try {
      const denominator = await gateClient.shareDenominator();
      for (const minter of GATE_MINTERS) {
        try {
          const info = await gateClient.minter(gateMinterId(minter.id));
          data.allocation.push({
            name: minter.name,
            controller: info.controller,
            shareBps: info.shareBps,
            sharePct: denominator > 0 ? (info.shareBps / denominator) * 100 : null,
            editable: info.editable,
          });
        } catch (_) {}
      }
    } catch (_) {}
  }

  // USDC balance of the Deposits contract (funds held for buyers)
  try {
    const bal = await depositsClient.getUSDCBalance(cfg.depositsContractAddress);
    data.usdc.depositsBalance = Number(bal) / 1e6;
  } catch (e) {
    data.usdc.error = e.shortMessage || e.message;
  }

  // USDC balance of the Channels contract (expected zero by design — channels hold no USDC)
  try {
    const bal = await depositsClient.getUSDCBalance(cfg.channelsContractAddress);
    data.usdc.channelsBalance = Number(bal) / 1e6;
  } catch (e) {
    data.usdc.channelsBalance = 0;
  }

  const insert = db.prepare(`
    INSERT INTO chain_metrics (
      id, fetched_at, ants_total_supply, ants_max_supply,
      emissions_epoch, emissions_rate, emissions_genesis, emissions_halving,
      emissions_effective_epoch, emissions_duration, allocation_json,
      usdc_deposits_balance, usdc_channels_balance, rpc_url
    )
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      fetched_at = excluded.fetched_at,
      ants_total_supply = excluded.ants_total_supply,
      ants_max_supply = excluded.ants_max_supply,
      emissions_epoch = excluded.emissions_epoch,
      emissions_rate = excluded.emissions_rate,
      emissions_genesis = excluded.emissions_genesis,
      emissions_halving = excluded.emissions_halving,
      emissions_effective_epoch = excluded.emissions_effective_epoch,
      emissions_duration = excluded.emissions_duration,
      allocation_json = excluded.allocation_json,
      usdc_deposits_balance = excluded.usdc_deposits_balance,
      usdc_channels_balance = excluded.usdc_channels_balance,
      rpc_url = excluded.rpc_url
  `);

  insert.run(
    Date.now(),
    data.ants.totalSupply ?? null, data.ants.maxSupply ?? null,
    data.emissions.currentEpoch ?? null, data.emissions.currentRate ?? null,
    data.emissions.genesis ?? null, data.emissions.halvingInterval ?? null,
    data.emissions.effectiveEpoch ?? null, data.emissions.epochDuration ?? null,
    JSON.stringify(data.allocation),
    data.usdc.depositsBalance ?? null, data.usdc.channelsBalance ?? null,
    cfg.rpcUrl
  );

  return data;
}

function contractMap() {
  const cfg = resolveChainConfig('base-mainnet');
  const legacy = resolveLegacyContractAddresses(cfg);
  const ru = cfg.recognizedUsage?.contracts ?? {};
  return {
    usdc: cfg.usdcContractAddress,
    registry: cfg.registryContractAddress,
    deposits: cfg.depositsContractAddress,
    channels: cfg.channelsContractAddress,
    stats: cfg.statsContractAddress,
    antsToken: cfg.antsTokenAddress,
    identityRegistry: cfg.identityRegistryAddress,
    freeUsage: cfg.freeUsageContractAddress,
    depositRelay: cfg.depositRelayAddress,
    legacyStaking: legacy.legacyStakingContractAddress,
    legacyEmissionsV2: legacy.legacyEmissionsContractAddress,
    legacyEmissionsV1: legacy.legacyEmissionsV1ContractAddress,
    emissionsGate: cfg.emissionsGateAddress ?? ru.emissionsGate,
    sellerPools: cfg.sellerPoolsAddress ?? ru.sellerPools,
    sellerRegistry: cfg.sellerRegistryAddress ?? ru.sellerRegistry,
    positionInit: cfg.positionInitAddress ?? ru.positionInit,
    usageAccounting: cfg.usageAccountingAddress ?? ru.usageAccounting,
    usageRewards: cfg.usageRewardsAddress ?? ru.usageRewards,
    sellerPoolsRewards: cfg.sellerPoolsRewardsAddress ?? ru.sellerPoolsRewards,
    washTradingRegistry: ru.washTradingRegistry,
    pointsPolicyRegistry: ru.pointsPolicyRegistry,
    legacyEmissionsEscrow: cfg.legacyEmissionsEscrowAddress ?? ru.legacyEmissionsEscrow,
  };
}

export function readChainMetrics() {
  const row = db.prepare('SELECT * FROM chain_metrics WHERE id = 1').get();
  if (!row) return null;
  let allocation = [];
  try { allocation = row.allocation_json ? JSON.parse(row.allocation_json) : []; } catch (_) {}
  return {
    timestamp: row.fetched_at,
    rpcUrl: row.rpc_url,
    contracts: contractMap(),
    ants: {
      totalSupply: row.ants_total_supply,
      maxSupply: row.ants_max_supply,
    },
    emissions: {
      currentEpoch: row.emissions_epoch,
      currentRate: row.emissions_rate,
      genesis: row.emissions_genesis,
      halvingInterval: row.emissions_halving,
      effectiveEpoch: row.emissions_effective_epoch,
      epochDuration: row.emissions_duration,
    },
    usdc: {
      depositsBalance: row.usdc_deposits_balance,
      channelsBalance: row.usdc_channels_balance,
    },
    allocation,
  };
}
