import { formatUnits, decodeAbiParameters } from 'viem';

const RPC_URLS = [
  'https://base-mainnet.public.blastapi.io',
  'https://base.drpc.org',
  'https://base-rpc.publicnode.com',
  'https://base.gateway.tenderly.co',
  'https://mainnet.base.org',
];

let currentRpcIndex = 0;

function getRpcUrl() {
  const url = RPC_URLS[currentRpcIndex];
  currentRpcIndex = (currentRpcIndex + 1) % RPC_URLS.length;
  return url;
}

const ADDRESSES = {
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  registry: '0xf33fC901BFa97326379A369401F4490E231B69B0',
  deposits: '0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2',
  channels: '0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d',
  staking: '0x3652E6B22919bd322A25723B94BB207602E5c8e6',
  stats: '0x15649ff076BFa5e37e24EE3154a00503149954Fd',
  emissions: '0xF13bE52c4A3afC6AE29536f073588d01A0564088',
  antsToken: '0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263',
  identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
};

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function rawCall(url, to, data, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_call',
          params: [{ to, data }, 'latest'],
          id: 1,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (body.includes('rate') || body.includes('limit') || res.status === 429) {
          throw new Error('rate limited');
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const json = await res.json();
      if (json.error) {
        if (json.error.message?.includes('rate') || json.error.message?.includes('limit')) {
          throw new Error('rate limited');
        }
        throw new Error(json.error.message);
      }
      return json.result;
    } catch (e) {
      if (attempt < retries && e.message?.toLowerCase().includes('rate')) {
        await sleep(300 + attempt * 400);
        continue;
      }
      throw e;
    }
  }
  throw new Error('exhausted retries');
}

function hexToNumber(hex) {
  return BigInt(hex);
}

// Request calls, retrying each on rate limit with fallback RPCs
async function batchCall(calls) {
  const results = {};
  for (const { key, address, data } of calls) {
    let lastError = null;
    for (let rpcIdx = 0; rpcIdx < RPC_URLS.length; rpcIdx++) {
      try {
        const url = getRpcUrl();
        const hex = await rawCall(url, address, data, 1);
        results[key] = hex;
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        await sleep(200);
      }
    }
    if (lastError) {
      results[key] = null;
    }
    await sleep(80);
  }
  return results;
}

export async function fetchOnChainData() {
  const data = {
    timestamp: Date.now(),
    rpcUrl: RPC_URLS[0],
    contracts: ADDRESSES,
    ants: {},
    emissions: {},
    stats: {},
    deposits: {},
    staking: {},
    usdc: {},
  };

  const depositsPadded = ADDRESSES.deposits.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const channelsPadded = ADDRESSES.channels.toLowerCase().replace(/^0x/, '').padStart(64, '0');

  // ─── Batch 1: core reads ───
  const batch1 = await batchCall([
    { key: 'antsSupply', address: ADDRESSES.antsToken, data: '0x18160ddd' },
    { key: 'usdcDeposits', address: ADDRESSES.usdc, data: `0x70a08231${depositsPadded}` },
    { key: 'usdcChannels', address: ADDRESSES.usdc, data: `0x70a08231${channelsPadded}` },
    { key: 'epoch', address: ADDRESSES.emissions, data: '0x5b1391de' },
    { key: 'minted', address: ADDRESSES.emissions, data: '0x5422874a' },
    { key: 'perEpoch', address: ADDRESSES.emissions, data: '0x4be5da91' },
    { key: 'startTime', address: ADDRESSES.emissions, data: '0xd2736f3b' },
  ]);

  if (batch1.antsSupply) {
    data.ants.totalSupply = Number(formatUnits(hexToNumber(batch1.antsSupply), 18));
    data.ants.maxSupply = 1_040_000_000;
  }
  if (batch1.usdcDeposits) {
    data.usdc.depositsBalance = Number(formatUnits(hexToNumber(batch1.usdcDeposits), 6));
  }
  if (batch1.usdcChannels) {
    data.usdc.channelsBalance = Number(formatUnits(hexToNumber(batch1.usdcChannels), 6));
  }
  if (batch1.epoch) data.emissions.currentEpoch = Number(hexToNumber(batch1.epoch));
  if (batch1.minted) data.emissions.totalMinted = Number(formatUnits(hexToNumber(batch1.minted), 18));
  if (batch1.perEpoch) data.emissions.emissionsPerEpoch = Number(formatUnits(hexToNumber(batch1.perEpoch), 18));
  if (batch1.startTime) data.emissions.startTime = Number(hexToNumber(batch1.startTime));

  // ─── Batch 2: stats / staking / deposits ───
  const batch2 = await batchCall([
    { key: 'statsReq', address: ADDRESSES.stats, data: '0x8e9d3b40' },
    { key: 'statsChan', address: ADDRESSES.stats, data: '0xb32c65c9' },
    { key: 'statsAgents', address: ADDRESSES.stats, data: '0x06a352a5' },
    { key: 'statsGlobal', address: ADDRESSES.stats, data: '0x4df7e3d0' },
    { key: 'staked', address: ADDRESSES.staking, data: '0x3eaaf86b' },
    { key: 'stakerCount', address: ADDRESSES.staking, data: '0xe86ab3e9' },
    { key: 'depositVol', address: ADDRESSES.deposits, data: '0x68e4c07e' },
  ]);

  if (batch2.statsReq) data.stats.requests = Number(hexToNumber(batch2.statsReq));
  if (batch2.statsChan) data.stats.channels = Number(hexToNumber(batch2.statsChan));
  if (batch2.statsAgents) data.stats.agents = Number(hexToNumber(batch2.statsAgents));

  if (batch2.statsGlobal && batch2.statsGlobal !== '0x') {
    try {
      const decoded = decodeAbiParameters(
        [
          { type: 'uint256', name: 'channels' },
          { type: 'uint256', name: 'requests' },
          { type: 'uint256', name: 'settlements' },
          { type: 'uint256', name: 'volumeUSDC' },
        ],
        batch2.statsGlobal
      );
      data.stats.channels = Number(decoded[0]);
      data.stats.requests = Number(decoded[1]);
      data.stats.settlements = Number(decoded[2]);
      data.stats.volumeUSDC = Number(formatUnits(decoded[3], 6));
    } catch (_) {}
  }

  if (batch2.staked) data.staking.totalStakedUSDC = Number(formatUnits(hexToNumber(batch2.staked), 6));
  if (batch2.stakerCount) data.staking.stakerCount = Number(hexToNumber(batch2.stakerCount));
  if (batch2.depositVol) data.deposits.totalVolumeUSDC = Number(formatUnits(hexToNumber(batch2.depositVol), 6));

  return data;
}
