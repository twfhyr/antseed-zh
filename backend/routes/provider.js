import db from '../database.js';
import { asyncHandler } from '../lib/async.js';
import { fetchJsonWithRetry } from '../lib/http.js';
import { parsePositiveInt, requireAddress } from '../lib/validation.js';

const EMPTY_USAGE = {
  totalRequests: 0,
  totalInputTokens: '0',
  totalOutputTokens: '0',
  totalSettlements: 0,
  uniqueSellers: 0,
  activeChannels: 0,
  channels: [],
};

export function registerProviderRoutes(app, { providerBase, emissionsCfg }) {
  app.get('/api/provider/models', asyncHandler(async (_req, res) => {
    const json = await fetchJsonWithRetry(`${providerBase}/models`);
    res.json(json.data || []);
  }));

  app.get('/api/channels', asyncHandler(async (_req, res) => {
    const url = `${providerBase.replace(/\/v1$/, '')}/v1/_antseed/channels?all=1`;
    try {
      const body = await fetchJsonWithRetry(url);
      res.json({ channels: body.channels ?? [] });
    } catch {
      res.json({ channels: [] });
    }
  }));

  app.get('/api/buyer-usage', asyncHandler(async (_req, res) => {
    const url = `${providerBase.replace(/\/v1$/, '')}/v1/_antseed/buyer-usage`;
    try {
      const body = await fetchJsonWithRetry(url);
      res.json(body.totals ?? EMPTY_USAGE);
    } catch {
      res.json(EMPTY_USAGE);
    }
  }));

  app.get('/api/network-stats', asyncHandler(async (_req, res) => {
    const statsUrl = emissionsCfg.networkStatsUrl;
    if (!statsUrl) {
      return res.json({ totals: { activePeers: 0, totalRequests: '0', totalInputTokens: '0', totalOutputTokens: '0', totalSettlements: 0 } });
    }

    const body = await fetchJsonWithRetry(`${statsUrl.replace(/\/$/, '')}/stats`);
    const peers = Array.isArray(body.peers) ? body.peers : [];
    const activePeers = peers.filter((peer) => peer.onChainStats).length;
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

    let totalRequests = 0n;
    let totalInputTokens = 0n;
    let totalOutputTokens = 0n;
    let totalSettlements = 0;
    for (const peer of peers) {
      const stats = peer.onChainStats;
      if (!stats) continue;
      try { totalRequests += BigInt(stats.totalRequests ?? '0'); } catch {}
      try { totalInputTokens += BigInt(stats.totalInputTokens ?? '0'); } catch {}
      try { totalOutputTokens += BigInt(stats.totalOutputTokens ?? '0'); } catch {}
      totalSettlements += Number(stats.settlementCount ?? 0);
    }

    res.json({
      totals: {
        activePeers,
        totalRequests: totalRequests.toString(),
        totalInputTokens: totalInputTokens.toString(),
        totalOutputTokens: totalOutputTokens.toString(),
        totalSettlements,
      },
    });
  }));

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
      evmAddress: emissionsCfg.buyerEvmAddress,
    });
  });

  app.get('/api/deposits/balance', asyncHandler(async (req, res) => {
    const address = requireAddress(req.query.address);
    const bal = await emissionsCfg.depositsClient.getBuyerBalance(address);
    const creditLimit = await emissionsCfg.depositsClient.getBuyerCreditLimit(address);
    const available = Number(bal.available) / 1e6;
    const reserved = Number(bal.reserved) / 1e6;
    res.json({
      evmAddress: address,
      available: available.toFixed(2),
      reserved: reserved.toFixed(2),
      total: (available + reserved).toFixed(2),
      creditLimit: (Number(creditLimit) / 1e6).toFixed(2),
    });
  }));

  app.get('/api/deposits/operator', asyncHandler(async (req, res) => {
    const address = requireAddress(req.query.address);
    const operator = await emissionsCfg.depositsClient.getOperator(address);
    res.json({ operator });
  }));

  app.get('/api/deposits/spending', asyncHandler(async (req, res) => {
    const buyerAddr = requireAddress(req.query.address);
    const days = parsePositiveInt(req.query.days, 7, { min: 1, max: 30 });
    const cacheKey = `spending:${buyerAddr}:${days}`;
    const ttlMs = 5 * 60 * 1000;
    const cached = db.prepare('SELECT data, fetched_at FROM buyer_channels WHERE address = ?').get(cacheKey);
    if (cached && Date.now() - cached.fetched_at < ttlMs) {
      return res.json(JSON.parse(cached.data));
    }

    const { createPublicClient, http } = await import('viem');
    const { base } = await import('viem/chains');
    const client = createPublicClient({ chain: base, transport: http(emissionsCfg.rpcUrl) });
    const channelsAddr = emissionsCfg.channelsContractAddress;
    const currentBlock = await client.getBlockNumber();
    const blockChunk = 50000n;
    const chunks = Math.min(days, 14);
    const channels = [];

    for (let i = 0; i < chunks; i += 1) {
      const to = currentBlock - BigInt(i) * blockChunk;
      const from = to - blockChunk + 1n;
      const logs = await client.getLogs({
        address: channelsAddr,
        event: {
          type: 'event',
          name: 'Reserved',
          inputs: [
            { name: 'channelId', type: 'bytes32', indexed: true },
            { name: 'buyer', type: 'address', indexed: true },
            { name: 'seller', type: 'address', indexed: true },
            { name: 'maxAmount', type: 'uint128', indexed: false },
          ],
        },
        args: { buyer: buyerAddr },
        fromBlock: from,
        toBlock: to,
      });

      for (const log of logs) {
        const block = await client.getBlock({ blockNumber: log.blockNumber });
        const raw = await client.readContract({
          address: channelsAddr,
          abi: [{
            name: 'channels', type: 'function', stateMutability: 'view',
            inputs: [{ name: 'channelId', type: 'bytes32' }],
            outputs: [{ name: '', type: 'tuple', components: [
              { name: 'buyer', type: 'address' },
              { name: 'seller', type: 'address' },
              { name: 'deposit', type: 'uint128' },
              { name: 'settled', type: 'uint128' },
              { name: 'metadataHash', type: 'bytes32' },
              { name: 'deadline', type: 'uint256' },
              { name: 'settledAt', type: 'uint256' },
              { name: 'closeRequestedAt', type: 'uint256' },
              { name: 'status', type: 'uint8' },
            ] }],
          }],
          functionName: 'channels',
          args: [log.args.channelId],
        });

        channels.push({
          channelId: log.args.channelId,
          seller: raw.seller,
          deposit: Number(raw.deposit) / 1e6,
          settled: Number(raw.settled) / 1e6,
          status: Number(raw.status),
          reservedAt: Number(block.timestamp),
          settledAt: Number(raw.settledAt),
          closeRequestedAt: Number(raw.closeRequestedAt),
        });
      }
    }

    const byDay = {};
    const bySeller = {};
    let totalSpent = 0;
    let totalReserved = 0;
    let activeCount = 0;

    for (const channel of channels) {
      const day = new Date(channel.reservedAt * 1000).toISOString().slice(0, 10);
      byDay[day] = (byDay[day] || 0) + channel.settled;
      bySeller[channel.seller] = (bySeller[channel.seller] || 0) + channel.settled;
      totalSpent += channel.settled;
      totalReserved += channel.deposit;
      if (channel.status === 1) activeCount += 1;
    }

    const data = {
      days,
      totalChannels: channels.length,
      activeChannels: activeCount,
      totalSpent: +totalSpent.toFixed(4),
      totalReserved: +totalReserved.toFixed(4),
      dailyBreakdown: Object.entries(byDay)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, spent]) => ({ date, spent: +spent.toFixed(4) })),
      sellerBreakdown: Object.entries(bySeller)
        .sort(([, a], [, b]) => b - a)
        .map(([seller, spent]) => ({ seller, spent: +spent.toFixed(4) })),
      channels,
    };

    db.prepare('INSERT OR REPLACE INTO buyer_channels (address, data, fetched_at) VALUES (?, ?, ?)').run(
      cacheKey,
      JSON.stringify(data),
      Date.now()
    );

    res.json(data);
  }));
}
