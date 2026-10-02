// Shared Multicall3 for hosted My Antseed wallet-connect fills only.
// Network pages do not use this. Same FallbackProvider construction as
// backend/server.js (quorum 1, 750ms stall) so we do not invent a third
// RPC stack.
import { Interface, JsonRpcProvider, FallbackProvider, FetchRequest, Network, Contract } from 'ethers';
import { resolveChainConfig } from '@antseed/node';

const cfg = resolveChainConfig('base-mainnet');
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const RPC_CALL_TIMEOUT_MS = 10_000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${ms}ms`);
      error.isTimeout = true;
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function buildFallbackProvider(rpcUrl, fallbackRpcUrls, evmChainId) {
  const network = evmChainId ? Network.from(evmChainId) : undefined;
  const opts = { batchMaxCount: 1, staticNetwork: network ? true : undefined };
  const makeProvider = (url) => {
    const request = new FetchRequest(url);
    request.timeout = 10_000;
    return new JsonRpcProvider(request, network, opts);
  };
  if (!fallbackRpcUrls || fallbackRpcUrls.length === 0) return makeProvider(rpcUrl);
  const urls = [rpcUrl, ...fallbackRpcUrls];
  const configs = urls.map((url, i) => ({ provider: makeProvider(url), priority: i + 1, stallTimeout: 750, weight: 1 }));
  return new FallbackProvider(configs, network, { quorum: 1 });
}

const provider = buildFallbackProvider(cfg.rpcUrl, cfg.fallbackRpcUrls, cfg.evmChainId);
const multicall3 = new Contract(MULTICALL3_ADDRESS, [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
], provider);

export const chainConfig = cfg;
export const usageRewardsAddress = cfg.usageRewardsAddress || null;
export const usageAccountingAddress = cfg.usageAccountingAddress || null;
export const depositsAddress = cfg.depositsContractAddress || null;
export const antsTokenAddress = cfg.antsTokenAddress || null;
export const sellerRegistryAddress = cfg.sellerRegistryAddress || null;
export const identityRegistryAddress = cfg.identityRegistryAddress || null;
export const sellerPoolsAddress = cfg.sellerPoolsAddress || null;
export const sellerPoolsRewardsAddress = cfg.sellerPoolsRewardsAddress || null;
export const emissionsGateAddress = cfg.emissionsGateAddress || null;

export const usageRewardsIface = new Interface([
  'function agentEpochClaimed(uint256 agentId, uint256 epoch) view returns (bool)',
  'function pendingAgentReward(uint256 agentId, uint256 epoch) view returns (uint256)',
  'function buyerEpochClaimed(address buyer, uint256 epoch) view returns (bool)',
  'function pendingBuyerReward(address buyer, uint256 epoch) view returns (uint256)',
]);
export const usageAccountingIface = new Interface([
  'function sellerPointsByEpoch(uint256 epoch, address seller) view returns (uint256)',
  'function buyerPointsByEpoch(uint256 epoch, address buyer) view returns (uint256)',
  'function pendingEmissions(address account, uint256[] epochs) view returns (uint256 seller, uint256 buyer)',
]);
export const depositsIface = new Interface([
  'function getOperator(address account) view returns (address)',
]);
export const antsTokenIface = new Interface([
  'function balanceOf(address account) view returns (uint256)',
  'function transfersEnabled() view returns (bool)',
  'function transferWhitelist(address account) view returns (bool)',
]);
export const sellerRegistryIface = new Interface([
  'function getAgentId(address seller) view returns (uint256)',
  'function isStakedAboveMin(address seller) view returns (bool)',
  'function minSellerPoolStake() view returns (uint256)',
  'function legacyStakeEligibilityEnabled() view returns (bool)',
]);
export const identityIface = new Interface([
  'function isRegistered(address account) view returns (bool)',
]);
export const poolsIface = new Interface([
  'function minStakeEpochs() view returns (uint256)',
  'function MAX_STAKE_EPOCHS() view returns (uint256)',
  'function stakeActivationDelay() view returns (uint256)',
  'function maxSlashBps() view returns (uint256)',
  'function minEarlyExitSlashBps() view returns (uint256)',
  'function restakedRewardWeightBonusBps() view returns (uint256)',
  'function moveWeightPenaltyBps() view returns (uint256)',
  'function poolActiveStakeAtEpoch(uint256 agentId, uint256 epoch) view returns (uint256)',
]);
export const poolRewardsIface = new Interface([
  'function pendingIndexedStakerReward(uint256 positionId) view returns (uint256)',
]);
export const gateIface = new Interface([
  'function initialEmission() view returns (uint256)',
  'function cumulativeEmissionThrough(uint256 epochExclusive) view returns (uint256)',
  'function currentEmissionRate() view returns (uint256)',
  'function getEpochEmission(uint256 epoch) view returns (uint256)',
  'function shareDenominator() view returns (uint256)',
  'function minterEpochBudget(bytes32 minterId, uint256 epoch) view returns (uint256)',
  'function emissionsReserve() view returns (address)',
  'function legacyEscrow() view returns (address)',
  'function minters(bytes32 minterId) view returns (address controller, uint32 shareBps, bool editable)',
]);

export async function multicallView(requests, options = {}) {
  if (requests.length === 0) return [];
  const chunkSize = options.chunkSize ?? 80;
  const results = new Array(requests.length).fill(null);
  const run = async (offset, size) => {
    const chunk = requests.slice(offset, offset + size);
    if (chunk.length === 0) return;
    const calls = chunk.map((r) => ({
      target: r.target,
      allowFailure: true,
      callData: r.iface.encodeFunctionData(r.method, r.args),
    }));
    let returned;
    try {
      returned = await withTimeout(
        multicall3.getFunction('aggregate3').staticCall(calls),
        RPC_CALL_TIMEOUT_MS,
        'multicall aggregate3',
      );
    } catch (error) {
      if (error?.isTimeout || chunk.length === 1) return;
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
  for (let offset = 0; offset < requests.length; offset += chunkSize) {
    await run(offset, Math.min(chunkSize, requests.length - offset));
  }
  return results;
}

export function asBig(decoded, index = 0) {
  const value = decoded?.[index];
  return typeof value === 'bigint' ? value : null;
}

export function asBool(decoded, index = 0) {
  const value = decoded?.[index];
  return typeof value === 'boolean' ? value : null;
}

export function asAddress(decoded, index = 0) {
  const value = decoded?.[index];
  return typeof value === 'string' ? value : null;
}
