// Hosted My Antseed reads. Official `antseed ants` uses Antscan for lists
// and public RPCs for a single local process. This process also runs the
// chain poller, epoch-rewards sync, and every website visitor, so per-request
// RotatingJsonRpcProvider calls stampede Base public RPCs and then lie
// (safe() → 0n) when they fail.
//
// Network pages: Antscan + chain_metrics / payload_cache. No per-request RPC.
// Wallet connect: one Multicall3 to persist completed-epoch claimable amounts,
// then SQLite for later loads. Amounts for finished epochs are fixed.
import { ZeroAddress } from 'ethers';
import { GATE_MINTERS, gateMinterId, positionState, resolveLegacyContractAddresses } from '@antseed/node';
import db from '../database.js';
import { readChainMetrics } from '../chain-poller.js';
import { createIndexer } from './service/indexer.js';
import { explorerSellers } from './service/explorer.js';
import { mergePools } from './service/pool-merge.js';
import { epochInfo } from './service/overview.js';
import {
  chainConfig,
  multicallView,
  asBig,
  asBool,
  asAddress,
  usageRewardsAddress,
  depositsAddress,
  antsTokenAddress,
  sellerRegistryAddress,
  identityRegistryAddress,
  sellerPoolsAddress,
  sellerPoolsRewardsAddress,
  emissionsGateAddress,
  usageRewardsIface,
  depositsIface,
  antsTokenIface,
  sellerRegistryIface,
  identityIface,
  poolsIface,
  poolRewardsIface,
  gateIface,
} from './hosted-multicall.js';

const EXPLORER = chainConfig.explorerApiUrl || 'https://antscan.co';
const indexer = createIndexer(EXPLORER);
const ZERO = ZeroAddress;
const SNAPSHOT_TTL_MS = 5 * 60_000;
const NETWORK_TTL_MS = 30_000;
const VOLUME_EPOCHS = 3;
const RECOGNIZED_FIRST = 22;

const selectCompleted = db.prepare(
  'SELECT side, epoch, agent_id, amount_wei, claimed, checked_at FROM ants_completed_epoch_rewards WHERE address = ?',
);
const upsertCompleted = db.prepare(`
  INSERT INTO ants_completed_epoch_rewards (address, side, epoch, agent_id, amount_wei, claimed, checked_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(address, side, epoch) DO UPDATE SET
    agent_id = COALESCE(excluded.agent_id, agent_id),
    amount_wei = CASE
      WHEN excluded.amount_wei != '0' THEN excluded.amount_wei
      WHEN amount_wei != '0' THEN amount_wei
      ELSE excluded.amount_wei
    END,
    claimed = excluded.claimed,
    checked_at = excluded.checked_at
`);
const insertCompletedIfMissing = db.prepare(`
  INSERT INTO ants_completed_epoch_rewards (address, side, epoch, agent_id, amount_wei, claimed, checked_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(address, side, epoch) DO NOTHING
`);
const selectSnapshot = db.prepare('SELECT data, fetched_at FROM ants_wallet_snapshot WHERE address = ?');
const upsertSnapshot = db.prepare(`
  INSERT INTO ants_wallet_snapshot (address, data, fetched_at) VALUES (?, ?, ?)
  ON CONFLICT(address) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at
`);
const selectBuyerHist = db.prepare(
  'SELECT epoch, usage_reward_wei FROM buyer_epoch_rewards WHERE lower(address) = ? AND epoch = ?',
);
const selectSellerHist = db.prepare(
  'SELECT epoch, agent_id, usage_reward_wei FROM seller_epoch_rewards WHERE lower(address) = ? AND epoch = ?',
);
const selectClaimedCache = db.prepare(
  'SELECT epoch, amount FROM reward_epoch_cache WHERE subject = ? AND side = ? AND epoch = ?',
);
const selectPayload = db.prepare('SELECT data, fetched_at FROM payload_cache WHERE key = ?');
const upsertPayload = db.prepare(`
  INSERT INTO payload_cache (key, data, fetched_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at
`);

const inflight = new Map();
function once(key, load) {
  const hit = inflight.get(key);
  if (hit) return hit;
  const pending = Promise.resolve().then(load).finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

function isAddress(value) {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
}
function sameAddress(a, b) {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}
function lower(address) {
  return address.toLowerCase();
}

function clock() {
  const chain = readChainMetrics();
  const em = chain?.emissions || {};
  const currentEpoch = em.currentEpoch ?? 0;
  const effectiveEpoch = em.effectiveEpoch ?? RECOGNIZED_FIRST;
  const genesis = em.genesis ?? 0;
  const epochDuration = em.epochDuration ?? 0;
  const stack = {
    phase: 'active',
    currentEpoch,
    effectiveEpoch,
    genesis,
    epochDuration,
  };
  return { chain, stack, epoch: epochInfo(stack) };
}

function completedEpochs(stack) {
  const start = stack.effectiveEpoch ?? RECOGNIZED_FIRST;
  const current = stack.currentEpoch ?? 0;
  const length = Math.max(0, current - start);
  return Array.from({ length }, (_, i) => start + i);
}

function contractAddresses() {
  const chain = { ...chainConfig };
  const legacy = resolveLegacyContractAddresses(chain);
  const entries = [
    ['registry', chain.registryContractAddress],
    ['antsToken', chain.antsTokenAddress],
    ['emissionsGate', chain.emissionsGateAddress],
    ['sellerPools', chain.sellerPoolsAddress],
    ['sellerPoolsRewards', chain.sellerPoolsRewardsAddress],
    ['sellerRegistry', chain.sellerRegistryAddress],
    ['usageAccounting', chain.usageAccountingAddress],
    ['usageRewards', chain.usageRewardsAddress],
    ['positionInit', chain.positionInitAddress],
    ['pointsPolicyRegistry', chain.pointsPolicyRegistryAddress],
    ['washTradingRegistry', chain.washTradingRegistryAddress],
    ['legacyEmissionsEscrow', chain.legacyEmissionsEscrowAddress],
    ['emissions', chain.emissionsContractAddress],
    ['staking', chain.stakingContractAddress],
    ['legacyEmissions', legacy.legacyEmissionsContractAddress],
    ['legacyStaking', legacy.legacyStakingContractAddress],
    ['legacyEmissionsV1', legacy.legacyEmissionsV1ContractAddress],
    ['deposits', chain.depositsContractAddress],
    ['channels', chain.channelsContractAddress],
    ['identityRegistry', chain.identityRegistryAddress],
    ['usdc', chain.usdcContractAddress],
  ];
  return Object.fromEntries(entries.filter((entry) => !!entry[1]));
}

function antsToWei(ants) {
  if (ants == null || !Number.isFinite(Number(ants))) return null;
  const rounded = Math.round(Number(ants));
  if (Math.abs(Number(ants) - rounded) < 1e-6) return (BigInt(rounded) * 10n ** 18n).toString();
  const text = Number(ants).toFixed(18);
  const [whole, frac = ''] = text.split('.');
  return (BigInt(whole) * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18))).toString();
}

function epochEmissionWei(stack, chain) {
  const rate = chain?.emissions?.currentRate;
  const duration = stack.epochDuration;
  if (rate == null || !duration) return null;
  const ants = Number(rate) * Number(duration);
  return antsToWei(ants);
}

function readPayload(key) {
  try {
    const row = selectPayload.get(key);
    if (!row) return null;
    return { data: JSON.parse(row.data), fetchedAt: row.fetched_at };
  } catch {
    return null;
  }
}

function writePayload(key, data) {
  try {
    upsertPayload.run(key, JSON.stringify(data), Date.now());
  } catch {
    /* cache write must not break the response */
  }
}

function emptyWallet(address) {
  return {
    address,
    ants: '0',
    eth: '0',
    transfersEnabled: true,
    whitelisted: false,
    canTransfer: true,
    totalActiveStake: '0',
    positionCount: 0,
    agentId: 0,
    sellerBound: false,
  };
}

function emptyRewards(currentEpoch, firstRewardedEpoch) {
  return {
    currentEpoch,
    firstRewardedEpoch,
    staker: { total: '0', positions: [] },
    sellerUsage: { total: '0', agentId: 0, epochs: [], claimable: false },
    buyerUsage: { total: '0', epochs: [], operator: null, claimable: false, recipient: null },
    legacy: { seller: '0', buyer: '0', contract: contractAddresses().legacyEmissions || null, buyerClaimable: false },
    locked: { locked: '0', claimable: '0', policy: null, pool: null },
    total: '0',
  };
}

async function loadIndexedNetwork() {
  const [indexed, sellerEpochs, metrics, explorer] = await Promise.all([
    indexer.pools(),
    indexer.sellerEpochs(VOLUME_EPOCHS),
    indexer.epochMetrics(),
    explorerSellers(EXPLORER),
  ]);
  return { indexed, sellerEpochs, metrics, explorer };
}

let networkCache = null;
async function networkSnapshot() {
  if (networkCache && Date.now() - networkCache.at < NETWORK_TTL_MS) return networkCache.data;
  return once('network', async () => {
    try {
      const data = await loadIndexedNetwork();
      networkCache = { at: Date.now(), data };
      writePayload('ants:network', { currentEpoch: data.indexed.currentEpoch, fetchedAt: Date.now() });
      return data;
    } catch (error) {
      if (networkCache) return networkCache.data;
      const persisted = readPayload('ants:network-full');
      if (persisted?.data?.indexed) return persisted.data;
      throw error;
    }
  });
}

function ownFromPositions(rows, currentEpoch) {
  const own = new Map();
  for (const row of rows) {
    if (row.withdrawn || row.closedAtEpoch !== 0) continue;
    if (currentEpoch < row.stakeStartEpoch) continue;
    const entry = own.get(row.agentId) ?? { positionIds: [], stake: 0n, power: 0n };
    entry.positionIds.push(row.id);
    try { entry.stake += BigInt(row.amount || '0'); } catch { /* keep */ }
    try { entry.power += BigInt(row.weightAmount || '0'); } catch { /* keep */ }
    own.set(row.agentId, entry);
  }
  return own;
}

function stakeableFromIndexed(indexed) {
  const map = new Map();
  for (const pool of indexed.pools) {
    const hasPool = Number(pool.openPositions) > 0
      || BigInt(pool.weight || '0') !== 0n
      || BigInt(pool.activeStake || '0') !== 0n;
    map.set(pool.agentId, pool.registered || hasPool);
  }
  return map;
}

async function positionsFor(address) {
  if (!isAddress(address) || sameAddress(address, ZERO)) return [];
  try {
    return await indexer.positions(address, true);
  } catch {
    return [];
  }
}

async function participantFor(address, count) {
  if (!isAddress(address) || sameAddress(address, ZERO)) {
    return { address, currentEpoch: 0, seller: [], buyer: [] };
  }
  try {
    return await indexer.participant(address, count);
  } catch {
    return { address, currentEpoch: 0, seller: [], buyer: [] };
  }
}

function poolConfigCached() {
  return readPayload('ants:pool-config')?.data ?? null;
}

async function refreshPoolConfig() {
  if (!sellerPoolsAddress) return poolConfigCached();
  const cached = poolConfigCached();
  if (cached && Date.now() - (readPayload('ants:pool-config')?.fetchedAt || 0) < 60 * 60_000) return cached;
  const requests = [
    { target: sellerPoolsAddress, iface: poolsIface, method: 'minStakeEpochs', args: [] },
    { target: sellerPoolsAddress, iface: poolsIface, method: 'MAX_STAKE_EPOCHS', args: [] },
    { target: sellerPoolsAddress, iface: poolsIface, method: 'stakeActivationDelay', args: [] },
    { target: sellerPoolsAddress, iface: poolsIface, method: 'maxSlashBps', args: [] },
    { target: sellerPoolsAddress, iface: poolsIface, method: 'minEarlyExitSlashBps', args: [] },
    { target: sellerPoolsAddress, iface: poolsIface, method: 'restakedRewardWeightBonusBps', args: [] },
    { target: sellerPoolsAddress, iface: poolsIface, method: 'moveWeightPenaltyBps', args: [] },
  ];
  const decoded = await multicallView(requests);
  const num = (row) => {
    const value = asBig(row);
    return value == null ? null : Number(value);
  };
  if (num(decoded[0]) == null || num(decoded[1]) == null) return cached;
  const config = {
    minStakeEpochs: num(decoded[0]),
    maxStakeEpochs: num(decoded[1]),
    stakeActivationDelay: num(decoded[2]) ?? 1,
    maxSlashBps: num(decoded[3]) ?? 0,
    minEarlyExitSlashBps: num(decoded[4]) ?? 0,
    restakedRewardWeightBonusBps: num(decoded[5]) ?? 0,
    moveWeightPenaltyBps: num(decoded[6]) ?? 0,
  };
  writePayload('ants:pool-config', config);
  return config;
}

async function refreshEmissionsExtras(stack) {
  if (!emissionsGateAddress) return readPayload('ants:emissions')?.data ?? null;
  const cached = readPayload('ants:emissions');
  if (cached && Date.now() - cached.fetchedAt < 5 * 60_000) return cached.data;
  const epoch = stack.currentEpoch;
  const requests = [
    { target: emissionsGateAddress, iface: gateIface, method: 'initialEmission', args: [] },
    { target: emissionsGateAddress, iface: gateIface, method: 'cumulativeEmissionThrough', args: [epoch + 1] },
    { target: emissionsGateAddress, iface: gateIface, method: 'currentEmissionRate', args: [] },
    { target: emissionsGateAddress, iface: gateIface, method: 'getEpochEmission', args: [epoch] },
    { target: emissionsGateAddress, iface: gateIface, method: 'shareDenominator', args: [] },
    { target: emissionsGateAddress, iface: gateIface, method: 'emissionsReserve', args: [] },
    { target: emissionsGateAddress, iface: gateIface, method: 'legacyEscrow', args: [] },
  ];
  for (const minter of GATE_MINTERS) {
    const id = gateMinterId(minter.id);
    requests.push({ target: emissionsGateAddress, iface: gateIface, method: 'minters', args: [id] });
    requests.push({ target: emissionsGateAddress, iface: gateIface, method: 'minterEpochBudget', args: [id, Math.max(epoch, stack.effectiveEpoch ?? epoch)] });
  }
  const decoded = await multicallView(requests);
  if (!decoded[0] && cached) return cached.data;
  const minters = GATE_MINTERS.map((minter, index) => {
    const info = decoded[7 + index * 2];
    const budget = asBig(decoded[8 + index * 2]);
    return {
      name: minter.name,
      id: gateMinterId(minter.id),
      controller: asAddress(info) || ZERO,
      shareBps: info ? Number(info[1] ?? 0) : 0,
      editable: info ? Boolean(info[2]) : false,
      epochBudget: budget != null ? budget.toString() : null,
    };
  });
  const data = {
    initialEmission: asBig(decoded[0])?.toString() ?? null,
    cumulativeThroughCurrent: asBig(decoded[1])?.toString() ?? null,
    currentRate: asBig(decoded[2])?.toString() ?? null,
    epochEmission: asBig(decoded[3])?.toString() ?? null,
    shareDenominator: decoded[4] ? Number(decoded[4][0]) : 100_000,
    emissionsReserve: asAddress(decoded[5]),
    legacyEscrow: asAddress(decoded[6]),
    minters,
  };
  writePayload('ants:emissions', data);
  return data;
}

export async function hostedOverview(address) {
  const { chain, stack, epoch } = clock();
  const net = await networkSnapshot();
  const current = net.indexed.network.current;
  const emission = epochEmissionWei(stack, chain);
  const extras = readPayload('ants:emissions')?.data ?? null;
  const tokenomics = readPayload('tokenomics')?.data ?? null;
  const usageBuyer = tokenomics?.dynamicShares?.usage?.buyerEpochBudgetAnts;
  const usageSeller = tokenomics?.dynamicShares?.usage?.sellerEpochBudgetAnts;
  const network = current ? {
    totalActiveStake: current.totalActiveStake ?? '0',
    totalPowerWeight: current.totalPowerWeight ?? '0',
    epochEmission: extras?.epochEmission ?? emission ?? '0',
    stakerBudget: current.stakerBudget ?? '0',
    usageBuyerBudget: antsToWei(usageBuyer) ?? '0',
    usageSellerBudget: antsToWei(usageSeller) ?? '0',
    antsTotalSupply: antsToWei(chain?.ants?.totalSupply) ?? '0',
    antsMaxSupply: antsToWei(chain?.ants?.maxSupply) ?? '0',
  } : null;

  let wallet = emptyWallet(sameAddress(address, ZERO) ? ZERO : address);
  if (isAddress(address) && !sameAddress(address, ZERO)) {
    const [rows, snap] = await Promise.all([
      positionsFor(address),
      Promise.resolve(readWalletSnapshot(address)),
    ]);
    const open = rows.filter((row) => !row.withdrawn && row.closedAtEpoch === 0);
    const activeStake = open
      .filter((row) => stack.currentEpoch >= row.stakeStartEpoch)
      .reduce((sum, row) => {
        try { return sum + BigInt(row.amount || '0'); } catch { return sum; }
      }, 0n);
    const agentId = snap?.agentId || agentIdFromIndexed(address, net, rows);
    wallet = {
      address,
      ants: snap?.ants,
      eth: snap?.eth,
      transfersEnabled: snap?.transfersEnabled ?? true,
      whitelisted: snap?.whitelisted ?? false,
      canTransfer: (snap?.transfersEnabled ?? true) || (snap?.whitelisted ?? false),
      totalActiveStake: activeStake.toString(),
      positionCount: open.length,
      agentId,
      sellerBound: agentId !== 0,
    };
    if (!snap || Date.now() - snap.fetchedAt > SNAPSHOT_TTL_MS) {
      fillWalletSnapshot(address, { agentId, rows }).catch((error) => {
        console.error('[ants-hosted] wallet snapshot failed:', error.message);
      });
    }
  }

  return {
    phase: stack.phase,
    chainId: chainConfig.chainId,
    evmChainId: chainConfig.evmChainId,
    rpcUrl: chainConfig.rpcUrl,
    addresses: contractAddresses(),
    epoch,
    wallet,
    network,
    notices: [],
  };
}

function agentIdFromIndexed(address, net, rows) {
  const want = lower(address);
  for (const pool of net.indexed.pools) {
    if (pool.seller && lower(pool.seller) === want && pool.agentId) return pool.agentId;
  }
  const fromExplorer = [...net.explorer.byAgent.entries()].find(([, seller]) => seller === want);
  if (fromExplorer) return fromExplorer[0];
  const fromPos = rows.find((row) => row.agentId)?.agentId;
  return fromPos || 0;
}

export async function hostedPools(address) {
  const { stack } = clock();
  const net = await networkSnapshot();
  const epochs = Array.from({ length: VOLUME_EPOCHS }, (_, index) => stack.currentEpoch - index).filter((value) => value >= 0);
  const rows = isAddress(address) && !sameAddress(address, ZERO) ? await positionsFor(address) : [];
  const own = ownFromPositions(rows, stack.currentEpoch);
  const stakeable = stakeableFromIndexed(net.indexed);
  const views = mergePools({
    indexed: net.indexed,
    explorer: net.explorer,
    sellerEpochs: net.sellerEpochs,
    epochs,
    own,
    stakeable,
  });
  const totalPower = BigInt(net.indexed.network.current?.totalPowerWeight ?? '0');
  const yourTotalPower = [...own.values()].reduce((sum, entry) => sum + entry.power, 0n);
  return {
    currentEpoch: stack.currentEpoch,
    firstRewardedEpoch: stack.effectiveEpoch,
    stakerBudget: net.indexed.network.current?.stakerBudget ?? '0',
    explorer: EXPLORER,
    totalActiveStake: net.indexed.network.current?.totalActiveStake ?? '0',
    totalPowerWeight: totalPower.toString(),
    networkVolumes: epochs.map((epoch) => ({
      epoch,
      usdc: net.metrics.find((row) => row.epoch === epoch)?.volumeUsdc
        ?? (epoch === stack.currentEpoch ? net.indexed.network.current?.volumeUsdc : epoch === stack.currentEpoch - 1 ? net.indexed.network.last?.volumeUsdc : null)
        ?? '0',
    })),
    yourTotalPower: yourTotalPower.toString(),
    yourNetworkShareBps: totalPower === 0n ? 0 : Number(yourTotalPower * 10000n / totalPower),
    source: 'indexer',
    sourceError: null,
    pools: views,
  };
}

export async function hostedSinglePool(address, agentId) {
  const view = await hostedPools(address);
  const pool = view.pools.find((row) => row.agentId === agentId);
  if (!pool) throw new Error(`Pool ${agentId} is not in the explorer index.`);
  return { ...pool, currentEpoch: view.currentEpoch };
}

export async function hostedPositions(address) {
  const { stack } = clock();
  if (!isAddress(address) || sameAddress(address, ZERO)) {
    return { currentEpoch: stack.currentEpoch, config: poolConfigCached(), positions: [], totals: { activeStake: '0', pendingRewards: '0', open: 0 }, historySource: 'indexer' };
  }
  const rows = await positionsFor(address);
  const snap = readWalletSnapshot(address);
  const pendingById = new Map((snap?.staker?.positions || []).map((p) => [p.id, p.amount]));
  const config = poolConfigCached();
  const details = rows.map((row) => {
    const open = !row.withdrawn && row.closedAtEpoch === 0;
    const state = positionState({
      withdrawn: row.withdrawn,
      closedAtEpoch: row.closedAtEpoch,
      stakeStartEpoch: row.stakeStartEpoch,
      stakeEndEpoch: row.stakeEndEpoch,
    }, stack.currentEpoch);
    return {
      id: row.id,
      agentId: row.agentId,
      owner: row.owner,
      amount: row.amount,
      weightAmount: row.weightAmount,
      stakeStartEpoch: row.stakeStartEpoch,
      stakeEndEpoch: row.stakeEndEpoch,
      closedAtEpoch: row.closedAtEpoch,
      withdrawn: row.withdrawn,
      state,
      withdrawableEpoch: row.stakeEndEpoch,
      changePending: stack.currentEpoch < row.stakeStartEpoch,
      maxLocked: row.maxLocked === true,
      slashBps: null,
      projectedSlashBps: 0,
      slashedAmount: '0',
      returnedAmount: open ? row.amount : (row.returnedAmount ?? '0'),
      pendingReward: pendingById.get(row.id) ?? '0',
      epochsRemaining: open ? Math.max(0, row.stakeEndEpoch - Math.max(stack.currentEpoch, row.stakeStartEpoch)) : 0,
      closedBy: row.closedBy ?? null,
      replacementIds: row.replacementIds ?? [],
    };
  }).sort((a, b) => b.id - a.id);
  const activeStake = details
    .filter((p) => p.state === 'active' || p.state === 'matured')
    .reduce((sum, p) => sum + BigInt(p.amount || '0'), 0n);
  const pendingRewards = details.reduce((sum, p) => sum + BigInt(p.pendingReward || '0'), 0n);
  return {
    currentEpoch: stack.currentEpoch,
    config,
    positions: details,
    totals: {
      activeStake: activeStake.toString(),
      pendingRewards: pendingRewards.toString(),
      open: details.filter((p) => !p.withdrawn && p.closedAtEpoch === 0).length,
    },
    historySource: 'indexer',
  };
}

export async function hostedUsage(address, options = {}) {
  const { stack } = clock();
  const count = Math.max(1, Math.min(52, options.epochs ?? 8));
  const first = stack.effectiveEpoch ?? RECOGNIZED_FIRST;
  const from = Math.max(first, stack.currentEpoch - count + 1);
  const [participant, network] = await Promise.all([
    participantFor(address, count),
    indexer.stakingEpochs(count).catch(() => []),
  ]);
  const epochs = [];
  for (let epoch = stack.currentEpoch; epoch >= from; epoch -= 1) {
    const seller = participant.seller.find((row) => row.epoch === epoch);
    const buyer = participant.buyer.find((row) => row.epoch === epoch);
    const totals = network.find((row) => row.epoch === epoch);
    epochs.push({
      epoch,
      buyerPoints: buyer?.points ?? '0',
      weightedBuyerPoints: buyer?.weightedPoints ?? '0',
      sellerPoints: seller?.points ?? '0',
      agentId: seller?.agentId ?? 0,
      totalBuyerPoints: totals?.totalBuyerPoints ?? '0',
      totalSellerPoints: totals?.totalSellerPoints ?? '0',
      totalPoolPoints: totals?.totalSellerPoints ?? '0',
      totalWeightedPoolPoints: totals?.totalWeightedPoolPoints ?? '0',
    });
  }
  const sum = (rows, key) => rows.reduce((acc, row) => {
    try { return acc + BigInt(row[key] || '0'); } catch { return acc; }
  }, 0n);
  return {
    currentEpoch: stack.currentEpoch,
    firstRewardedEpoch: stack.effectiveEpoch,
    epochs,
    totals: {
      buyerPoints: sum(participant.buyer, 'points').toString(),
      buyerWeightedPoints: sum(participant.buyer, 'weightedPoints').toString(),
      networkBuyerPoints: sum(network, 'totalBuyerPoints').toString(),
      networkSellerPoints: sum(network, 'totalSellerPoints').toString(),
    },
    pointsPolicy: null,
    poolWeightPolicy: null,
    minimumAccountedPoolPower: null,
    source: 'indexer',
    sourceError: null,
  };
}

export async function hostedEmissions() {
  const { chain, stack } = clock();
  const extras = readPayload('ants:emissions')?.data ?? null;
  const allocation = chain?.allocation || [];
  const rate = extras?.currentRate ?? antsToWei(chain?.emissions?.currentRate);
  const emission = extras?.epochEmission ?? epochEmissionWei(stack, chain);
  const denom = extras?.shareDenominator ?? 100_000;
  const net = await networkSnapshot().catch(() => null);
  const tokenomicsForBudgets = readPayload('tokenomics')?.data ?? null;
  const liveStaker = net?.indexed?.network?.current?.stakerBudget ?? null;
  const liveUsage = (() => {
    const buyer = tokenomicsForBudgets?.dynamicShares?.usage?.buyerEpochBudgetAnts;
    const seller = tokenomicsForBudgets?.dynamicShares?.usage?.sellerEpochBudgetAnts;
    if (buyer == null && seller == null) return null;
    const sum = (Number(buyer) || 0) + (Number(seller) || 0);
    return antsToWei(sum);
  })();
  const extraByName = new Map((extras?.minters || []).map((row) => [row.name, row]));
  const minters = GATE_MINTERS.map((minter) => {
    const row = allocation.find((item) => item.name === minter.name);
    const extra = extraByName.get(minter.name);
    const extrasUsable = extra && extra.shareBps > 0;
    const shareBps = (extrasUsable ? extra.shareBps : null) ?? row?.shareBps ?? 0;
    let budget = extrasUsable ? extra.epochBudget : null;
    if (minter.name === 'seller-pools' && liveStaker) budget = liveStaker;
    else if (minter.name === 'usage' && liveUsage) budget = liveUsage;
    else if (!budget && emission && shareBps) {
      budget = (BigInt(emission) * BigInt(shareBps) / BigInt(denom)).toString();
    }
    return {
      name: minter.name,
      id: extra?.id || gateMinterId(minter.id),
      controller: extrasUsable && extra.controller !== ZERO ? extra.controller : (row?.controller || ZERO),
      shareBps,
      editable: extrasUsable ? extra.editable : (row?.editable ?? false),
      epochBudget: budget,
    };
  });
  const tokenomics = readPayload('tokenomics')?.data ?? null;
  const legacyAlloc = tokenomics?.legacyAllocation;
  const addrs = contractAddresses();
  return {
    currentEpoch: stack.currentEpoch,
    effectiveEpoch: stack.effectiveEpoch,
    genesis: stack.genesis,
    epochDuration: stack.epochDuration,
    halvingInterval: chain?.emissions?.halvingInterval ?? 104,
    initialEmission: extras?.initialEmission ?? null,
    currentRate: rate ?? '0',
    cumulativeThroughCurrent: extras?.cumulativeThroughCurrent ?? antsToWei(tokenomics?.distribution?.current?.total) ?? '0',
    shareDenominator: denom,
    minters,
    emissionsReserve: extras?.emissionsReserve ?? null,
    legacyEscrow: extras?.legacyEscrow ?? addrs.legacyEmissionsEscrow ?? null,
    dynamicStaker: tokenomics?.dynamicShares?.stake ? {
      minShareBps: Math.round((tokenomics.dynamicShares.stake.minSharePct || 0) * 1000),
      maxShareBps: Math.round((tokenomics.dynamicShares.stake.maxSharePct || 0) * 1000),
      stakeShareTarget: antsToWei(tokenomics.dynamicShares.stake.stakeShareTarget) ?? '0',
    } : null,
    dynamicUsage: tokenomics?.dynamicShares?.usage ? {
      buyerMinShareBps: Math.round((tokenomics.dynamicShares.usage.buyerMinSharePct || 0) * 1000),
      buyerMaxShareBps: Math.round((tokenomics.dynamicShares.usage.buyerMaxSharePct || 0) * 1000),
      sellerMinShareBps: Math.round((tokenomics.dynamicShares.usage.sellerMinSharePct || 0) * 1000),
      sellerMaxShareBps: Math.round((tokenomics.dynamicShares.usage.sellerMaxSharePct || 0) * 1000),
      volumeShareTarget: antsToWei(tokenomics.dynamicShares.usage.volumeShareTargetUsdc) ?? '0',
    } : null,
    legacy: legacyAlloc ? {
      contract: addrs.legacyEmissions || null,
      sellerPct: legacyAlloc.find((r) => r.name === 'sellers')?.sharePct ?? 65,
      buyerPct: legacyAlloc.find((r) => r.name === 'buyers')?.sharePct ?? 5,
      reservePct: legacyAlloc.find((r) => r.name === 'reserve')?.sharePct ?? 15,
      teamPct: legacyAlloc.find((r) => r.name === 'team')?.sharePct ?? 15,
      currentEpoch: stack.effectiveEpoch,
    } : null,
  };
}

export async function hostedSeller(address) {
  if (!isAddress(address) || sameAddress(address, ZERO)) {
    return {
      address: null, agentId: 0, identityRegistered: false, registryBound: false, eligible: false,
      legacyStake: '0', legacyEligibilityEnabled: null, minPoolStake: null, poolActiveStake: '0', starter: null,
    };
  }
  const { stack } = clock();
  const net = await networkSnapshot();
  const snap = readWalletSnapshot(address);
  const rows = await positionsFor(address);
  const agentId = snap?.agentId || agentIdFromIndexed(address, net, rows);
  const pool = net.indexed.pools.find((p) => p.agentId === agentId);
  return {
    address,
    agentId,
    identityRegistered: snap?.identityRegistered ?? null,
    registryBound: snap?.registryBound ?? Boolean(pool?.registered),
    eligible: snap?.eligible ?? Boolean(pool?.registered || (pool && Number(pool.openPositions) > 0)),
    legacyStake: snap?.legacyStake ?? '0',
    legacyEligibilityEnabled: snap?.legacyEligibilityEnabled ?? null,
    minPoolStake: snap?.minPoolStake ?? null,
    poolActiveStake: pool?.activeStake ?? snap?.poolActiveStake ?? '0',
    starter: snap?.starter ?? null,
  };
}

export async function hostedVerification() {
  return { registry: null, seller: null, policies: [], pointsPolicy: null, enforced: false };
}

function readWalletSnapshot(address) {
  const row = selectSnapshot.get(lower(address));
  if (!row) return null;
  try {
    return { ...JSON.parse(row.data), fetchedAt: row.fetched_at };
  } catch {
    return null;
  }
}

function writeWalletSnapshot(address, data) {
  upsertSnapshot.run(lower(address), JSON.stringify(data), Date.now());
}

function loadStoredEpochs(address) {
  const rows = selectCompleted.all(lower(address));
  const buyer = new Map();
  const seller = new Map();
  for (const row of rows) {
    const entry = {
      epoch: row.epoch,
      agentId: row.agent_id || 0,
      amount: row.amount_wei,
      claimed: row.claimed === 1,
      checkedAt: row.checked_at,
    };
    if (row.side === 'seller') seller.set(row.epoch, entry);
    else buyer.set(row.epoch, entry);
  }
  return { buyer, seller };
}

function historicalWei(address, side, epoch) {
  if (side === 'buyer') {
    const row = selectBuyerHist.get(lower(address), epoch);
    return row?.usage_reward_wei || null;
  }
  const row = selectSellerHist.get(lower(address), epoch);
  return row ? { wei: row.usage_reward_wei, agentId: row.agent_id ? Number(row.agent_id) : 0 } : null;
}

function seedCompletedFromHistory(address, completed, agentId) {
  const now = Date.now();
  for (const epoch of completed) {
    const buyerHist = historicalWei(address, 'buyer', epoch);
    if (buyerHist && buyerHist !== '0') {
      const claimedRow = selectClaimedCache.get(lower(address), 'buyer', epoch);
      insertCompletedIfMissing.run(lower(address), 'buyer', epoch, null, buyerHist, claimedRow ? 1 : 0, now);
    }
    const sellerHist = historicalWei(address, 'seller', epoch);
    if (sellerHist?.wei && sellerHist.wei !== '0') {
      const subject = String(sellerHist.agentId || agentId || '');
      const claimedRow = subject ? selectClaimedCache.get(subject, 'seller', epoch) : null;
      insertCompletedIfMissing.run(
        lower(address),
        'seller',
        epoch,
        sellerHist.agentId || agentId || null,
        sellerHist.wei,
        claimedRow ? 1 : 0,
        now,
      );
    }
  }
}

function persistEpoch(address, side, epoch, agentId, amountWei, claimed) {
  const amount = amountWei == null ? '0' : amountWei.toString();
  upsertCompleted.run(lower(address), side, epoch, agentId ?? null, amount, claimed ? 1 : 0, Date.now());
}

async function fillWalletSnapshot(address, hints = {}) {
  return once(`wallet:${lower(address)}`, async () => {
    const { stack } = clock();
    const completed = completedEpochs(stack);
    const participant = await participantFor(address, Math.max(completed.length + 2, 8));
    const agentFromPart = participant.seller.find((row) => row.agentId)?.agentId || 0;
    const agentId = hints.agentId || agentFromPart;
    seedCompletedFromHistory(address, completed, agentId);

    const stored = loadStoredEpochs(address);
    const buyerNeeded = new Set(participant.buyer.filter((row) => completed.includes(row.epoch)).map((row) => row.epoch));
    const sellerNeeded = new Set(participant.seller.filter((row) => completed.includes(row.epoch)).map((row) => row.epoch));
    for (const epoch of stored.buyer.keys()) buyerNeeded.add(epoch);
    for (const epoch of stored.seller.keys()) sellerNeeded.add(epoch);

    const requests = [];
    const mark = [];
    if (antsTokenAddress) {
      requests.push({ target: antsTokenAddress, iface: antsTokenIface, method: 'balanceOf', args: [address] });
      mark.push('ants');
      requests.push({ target: antsTokenAddress, iface: antsTokenIface, method: 'transfersEnabled', args: [] });
      mark.push('transfers');
      requests.push({ target: antsTokenAddress, iface: antsTokenIface, method: 'transferWhitelist', args: [address] });
      mark.push('whitelist');
    }
    if (depositsAddress) {
      requests.push({ target: depositsAddress, iface: depositsIface, method: 'getOperator', args: [address] });
      mark.push('operator');
    }
    if (sellerRegistryAddress) {
      requests.push({ target: sellerRegistryAddress, iface: sellerRegistryIface, method: 'getAgentId', args: [address] });
      mark.push('agentId');
      requests.push({ target: sellerRegistryAddress, iface: sellerRegistryIface, method: 'isStakedAboveMin', args: [address] });
      mark.push('eligible');
      requests.push({ target: sellerRegistryAddress, iface: sellerRegistryIface, method: 'minSellerPoolStake', args: [] });
      mark.push('minPool');
      requests.push({ target: sellerRegistryAddress, iface: sellerRegistryIface, method: 'legacyStakeEligibilityEnabled', args: [] });
      mark.push('legacyElig');
    }
    if (identityRegistryAddress) {
      requests.push({ target: identityRegistryAddress, iface: identityIface, method: 'isRegistered', args: [address] });
      mark.push('identity');
    }

    const buyerMissing = [...buyerNeeded].filter((epoch) => !stored.buyer.has(epoch) || stored.buyer.get(epoch).amount === '0');
    const sellerMissing = [...sellerNeeded].filter((epoch) => !stored.seller.has(epoch) || stored.seller.get(epoch).amount === '0');
    const buyerRecheck = [...buyerNeeded].filter((epoch) => stored.buyer.get(epoch) && !stored.buyer.get(epoch).claimed);
    const sellerRecheck = [...sellerNeeded].filter((epoch) => stored.seller.get(epoch) && !stored.seller.get(epoch).claimed);

    if (usageRewardsAddress) {
      for (const epoch of new Set([...buyerMissing, ...buyerRecheck])) {
        requests.push({ target: usageRewardsAddress, iface: usageRewardsIface, method: 'buyerEpochClaimed', args: [address, epoch] });
        mark.push({ kind: 'buyerClaimed', epoch });
        if (buyerMissing.includes(epoch)) {
          requests.push({ target: usageRewardsAddress, iface: usageRewardsIface, method: 'pendingBuyerReward', args: [address, epoch] });
          mark.push({ kind: 'buyerPending', epoch });
        }
      }
      const resolvedAgent = agentId;
      if (resolvedAgent) {
        for (const epoch of new Set([...sellerMissing, ...sellerRecheck])) {
          requests.push({ target: usageRewardsAddress, iface: usageRewardsIface, method: 'agentEpochClaimed', args: [resolvedAgent, epoch] });
          mark.push({ kind: 'sellerClaimed', epoch });
          if (sellerMissing.includes(epoch)) {
            requests.push({ target: usageRewardsAddress, iface: usageRewardsIface, method: 'pendingAgentReward', args: [resolvedAgent, epoch] });
            mark.push({ kind: 'sellerPending', epoch });
          }
        }
      }
    }

    const positionIds = (hints.rows || []).map((row) => row.id).filter((id) => Number.isFinite(id));
    if (sellerPoolsRewardsAddress && positionIds.length > 0) {
      for (const id of positionIds.slice(0, 32)) {
        requests.push({ target: sellerPoolsRewardsAddress, iface: poolRewardsIface, method: 'pendingIndexedStakerReward', args: [id] });
        mark.push({ kind: 'staker', id });
      }
    }

    const decoded = requests.length > 0 ? await multicallView(requests) : [];
    const by = {};
    const buyerClaimed = new Map();
    const buyerPending = new Map();
    const sellerClaimed = new Map();
    const sellerPending = new Map();
    const stakerPos = [];
    decoded.forEach((row, index) => {
      const tag = mark[index];
      if (typeof tag === 'string') {
        by[tag] = row;
        return;
      }
      if (tag?.kind === 'buyerClaimed') buyerClaimed.set(tag.epoch, asBool(row));
      else if (tag?.kind === 'buyerPending') buyerPending.set(tag.epoch, asBig(row));
      else if (tag?.kind === 'sellerClaimed') sellerClaimed.set(tag.epoch, asBool(row));
      else if (tag?.kind === 'sellerPending') sellerPending.set(tag.epoch, asBig(row));
      else if (tag?.kind === 'staker') {
        const amount = asBig(row) ?? 0n;
        if (amount > 0n) stakerPos.push({ id: tag.id, amount: amount.toString() });
      }
    });

    const resolvedAgent = Number(asBig(by.agentId) ?? agentId) || 0;

    for (const epoch of new Set([...buyerNeeded])) {
      const prev = stored.buyer.get(epoch);
      const claimed = buyerClaimed.has(epoch)
        ? Boolean(buyerClaimed.get(epoch))
        : Boolean(prev?.claimed);
      let amount = prev?.amount ?? null;
      if (buyerPending.has(epoch) && buyerPending.get(epoch) != null) {
        const pending = buyerPending.get(epoch);
        if (!claimed || pending > 0n) amount = pending.toString();
      }
      if ((amount == null || amount === '0') && claimed) {
        amount = historicalWei(address, 'buyer', epoch) || amount || '0';
      }
      if (amount == null) amount = '0';
      persistEpoch(address, 'buyer', epoch, null, amount, claimed);
    }

    for (const epoch of new Set([...sellerNeeded])) {
      const prev = stored.seller.get(epoch);
      const claimed = sellerClaimed.has(epoch)
        ? Boolean(sellerClaimed.get(epoch))
        : Boolean(prev?.claimed);
      let amount = prev?.amount ?? null;
      if (sellerPending.has(epoch) && sellerPending.get(epoch) != null) {
        const pending = sellerPending.get(epoch);
        if (!claimed || pending > 0n) amount = pending.toString();
      }
      if ((amount == null || amount === '0') && claimed) {
        const hist = historicalWei(address, 'seller', epoch);
        amount = hist?.wei || amount || '0';
      }
      if (amount == null) amount = '0';
      persistEpoch(address, 'seller', epoch, resolvedAgent || prev?.agentId || null, amount, claimed);
    }

    // After persist, stored is stale; if we needed pending and got neither
    // pending nor history, the multicall failed for that epoch. Do not
    // invent 0. Throw only when a wallet actually earned points there.
    const stillMissing = [];
    const after = loadStoredEpochs(address);
    for (const epoch of buyerMissing) {
      const row = after.buyer.get(epoch);
      if (!row && buyerNeeded.has(epoch) && participant.buyer.some((p) => p.epoch === epoch)) stillMissing.push(`buyer ${epoch}`);
    }
    for (const epoch of sellerMissing) {
      const row = after.seller.get(epoch);
      if (!row && sellerNeeded.has(epoch) && participant.seller.some((p) => p.epoch === epoch)) stillMissing.push(`provider ${epoch}`);
    }
    if (stillMissing.length > 0 && requests.length > 0 && decoded.every((row) => row == null)) {
      throw new Error('Could not read claimable rewards from chain. Retry in a few seconds.');
    }

    const operator = asAddress(by.operator);
    const operatorClean = operator && !sameAddress(operator, ZERO) ? operator : null;
    const stakerTotal = stakerPos.reduce((sum, p) => sum + BigInt(p.amount), 0n);
    const snap = {
      ants: asBig(by.ants)?.toString() ?? null,
      eth: null,
      transfersEnabled: asBool(by.transfers) ?? true,
      whitelisted: asBool(by.whitelist) ?? false,
      operator: operatorClean,
      agentId: resolvedAgent,
      identityRegistered: asBool(by.identity),
      registryBound: resolvedAgent !== 0,
      eligible: asBool(by.eligible) ?? resolvedAgent !== 0,
      minPoolStake: asBig(by.minPool)?.toString() ?? null,
      legacyEligibilityEnabled: asBool(by.legacyElig),
      legacyStake: '0',
      poolActiveStake: null,
      starter: null,
      staker: {
        total: stakerTotal.toString(),
        positions: stakerPos.map((p) => {
          const row = (hints.rows || []).find((r) => r.id === p.id);
          return { id: p.id, agentId: row?.agentId ?? 0, amount: p.amount, closed: Boolean(row && (row.closedAtEpoch !== 0 || row.withdrawn)) };
        }),
      },
      legacy: { seller: '0', buyer: '0' },
      locked: { locked: '0', claimable: '0', policy: null, pool: null },
    };
    writeWalletSnapshot(address, snap);
    return snap;
  });
}

function claimableTotal(rows) {
  return rows.reduce((sum, row) => (row.claimed ? sum : sum + BigInt(row.amount || '0')), 0n);
}

export async function hostedRewards(address) {
  const { stack } = clock();
  if (!isAddress(address) || sameAddress(address, ZERO)) {
    return emptyRewards(stack.currentEpoch, stack.effectiveEpoch);
  }
  const completed = completedEpochs(stack);
  seedCompletedFromHistory(address, completed, 0);
  let stored = loadStoredEpochs(address);
  const participant = await participantFor(address, Math.max(completed.length + 2, 8));
  const hasUnfilled = completed.some((epoch) => {
    const earnedBuyer = participant.buyer.some((row) => row.epoch === epoch);
    const earnedSeller = participant.seller.some((row) => row.epoch === epoch);
    return (earnedBuyer && !stored.buyer.has(epoch)) || (earnedSeller && !stored.seller.has(epoch));
  });
  const hasUnclaimed = [...stored.buyer.values(), ...stored.seller.values()].some((row) => !row.claimed);
  const snap = readWalletSnapshot(address);
  const stale = !snap || Date.now() - snap.fetchedAt > SNAPSHOT_TTL_MS;

  if (hasUnfilled || (hasUnclaimed && stale) || stale) {
    const rows = await positionsFor(address);
    try {
      await fillWalletSnapshot(address, { rows, agentId: snap?.agentId });
      stored = loadStoredEpochs(address);
    } catch (error) {
      stored = loadStoredEpochs(address);
      const canServe = !hasUnfilled || [...stored.buyer.keys()].length + [...stored.seller.keys()].length > 0;
      if (!canServe) throw error;
      console.error('[ants-hosted] rewards fill failed, serving stored epochs:', error.message);
    }
  }

  const fresh = readWalletSnapshot(address) || snap || {};
  const agentId = fresh.agentId || participant.seller.find((row) => row.agentId)?.agentId || 0;
  const operator = fresh.operator || null;
  const buyerRows = completed
    .map((epoch) => stored.buyer.get(epoch))
    .filter((row) => row && (row.claimed || BigInt(row.amount || '0') > 0n))
    .map((row) => ({ epoch: row.epoch, amount: row.claimed ? '0' : row.amount, claimed: row.claimed }));
  const sellerRows = completed
    .map((epoch) => stored.seller.get(epoch))
    .filter((row) => row && (row.claimed || BigInt(row.amount || '0') > 0n))
    .map((row) => ({ epoch: row.epoch, amount: row.claimed ? '0' : row.amount, claimed: row.claimed }));

  // Totals are unclaimed pending only (official envelope). Stored amount
  // stays on the row for claimed epochs so we never re-read it.
  const buyerTotal = claimableTotal([...stored.buyer.values()].filter((row) => completed.includes(row.epoch)));
  const sellerTotal = claimableTotal([...stored.seller.values()].filter((row) => completed.includes(row.epoch)));
  const staker = fresh.staker || { total: '0', positions: [] };
  const legacy = fresh.legacy || { seller: '0', buyer: '0' };
  const locked = fresh.locked || { locked: '0', claimable: '0', policy: null, pool: null };
  const stakerTotal = BigInt(staker.total || '0');
  const total = stakerTotal + sellerTotal + buyerTotal + BigInt(legacy.seller || '0') + BigInt(legacy.buyer || '0') + BigInt(locked.claimable || '0');

  return {
    currentEpoch: stack.currentEpoch,
    firstRewardedEpoch: stack.effectiveEpoch,
    staker: {
      total: stakerTotal.toString(),
      positions: (staker.positions || []).filter((p) => BigInt(p.amount || '0') > 0n),
    },
    sellerUsage: {
      total: sellerTotal.toString(),
      agentId,
      epochs: sellerRows,
      claimable: stack.phase === 'active' && agentId !== 0,
    },
    buyerUsage: {
      total: buyerTotal.toString(),
      epochs: buyerRows,
      operator,
      claimable: stack.phase === 'active' && (!operator || sameAddress(operator, address)),
      recipient: operator,
    },
    legacy: {
      seller: String(legacy.seller || '0'),
      buyer: String(legacy.buyer || '0'),
      contract: contractAddresses().legacyEmissions || null,
      buyerClaimable: !operator || sameAddress(operator, address),
    },
    locked,
    total: total.toString(),
  };
}

let refreshStarted = false;
export function startHostedRefresh() {
  if (refreshStarted) return;
  refreshStarted = true;
  const tick = async () => {
    try { await networkSnapshot(); } catch (error) {
      console.error('[ants-hosted] network snapshot failed:', error.message);
    }
    const { stack } = clock();
    try { await refreshPoolConfig(); } catch (error) {
      console.error('[ants-hosted] pool config refresh failed:', error.message);
    }
    try { await refreshEmissionsExtras(stack); } catch (error) {
      console.error('[ants-hosted] emissions refresh failed:', error.message);
    }
  };
  tick();
  setInterval(tick, 60_000);
}
