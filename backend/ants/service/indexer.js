/**
 * Read side for everything that is a list or a history: pools and their
 * per-epoch figures, a wallet's position history, per-epoch usage. It is
 * served by the Antscan indexer (`payments.crypto.explorerApiUrl`), never
 * reconstructed from RPC log scans. Every method returns plain JSON-shaped
 * data; amounts stay as decimal strings.
 */
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 15_000;
export class IndexerError extends Error {
    url;
    constructor(message, url) {
        super(message);
        this.url = url;
        this.name = 'IndexerError';
    }
}
const num = (value) => {
    const parsed = typeof value === 'number' ? value : Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
};
const str = (value) => (value === null || value === undefined ? '0' : String(value));
const lower = (value) => (typeof value === 'string' && value ? value.toLowerCase() : null);
/** `convert(value)`, or null when the field is absent. */
const optional = (value, convert) => (value === null || value === undefined ? null : convert(value));
const CLOSE_REASONS = ['split', 'merge', 'move', 'withdraw'];
function toStakingEpoch(row) {
    if (!row)
        return null;
    return {
        epoch: num(row['epoch']),
        totalPowerWeight: str(row['totalPowerWeight']),
        totalActiveStake: str(row['totalActiveStake']),
        totalSellerPoints: str(row['totalSellerPoints']),
        totalWeightedPoolPoints: str(row['totalWeightedPoolPoints']),
        totalBuyerPoints: str(row['totalBuyerPoints']),
        volumeUsdc: str(row['volumeUsdc']),
        requests: str(row['requests']),
        stakerBudget: str(row['stakerBudget']),
    };
}
function toPool(row) {
    return {
        agentId: num(row['agentId']),
        seller: lower(row['seller']),
        sellerName: typeof row['sellerName'] === 'string' ? row['sellerName'] : null,
        registered: row['registered'] === true,
        openPositions: num(row['openPositions']),
        totalPositions: num(row['totalPositions']),
        securityShareBps: str(row['securityShareBps']),
        activeStake: str(row['activeStake']),
        pendingStake: str(row['pendingStake']),
        weight: str(row['weight']),
        powerShareBps: num(row['powerShareBps']),
        lastWeight: str(row['lastWeight']),
        usagePoints: str(row['usagePoints']),
        weightedUsagePoints: str(row['weightedUsagePoints']),
        lastUsagePoints: str(row['lastUsagePoints']),
        volumeUsdc: str(row['volumeUsdc']),
        lastVolumeUsdc: str(row['lastVolumeUsdc']),
        lastEmission: str(row['lastEmission']),
        lastEmissionSettled: row['lastEmissionSettled'] === true,
        lastRewardPer1kPower: optional(row['lastRewardPer1kPower'], str),
        projectedEmission: str(row['projectedEmission']),
        projectedRewardPer1kPower: optional(row['projectedRewardPer1kPower'], str),
        firstStakeAt: optional(row['firstStakeAt'], num),
    };
}
function toPosition(row) {
    const closedBy = CLOSE_REASONS.find((reason) => reason === row['closedBy']) ?? null;
    return {
        id: num(row['id']),
        owner: lower(row['owner']) ?? '',
        agentId: num(row['agentId']),
        amount: str(row['amount']),
        weightAmount: str(row['weightAmount']),
        stakeStartEpoch: num(row['stakeStartEpoch']),
        stakeEndEpoch: num(row['stakeEndEpoch']),
        closedAtEpoch: num(row['closedAtEpoch']),
        closedBy,
        replacementIds: Array.isArray(row['replacementIds']) ? row['replacementIds'].map(num) : [],
        sourceId: optional(row['sourceId'], num),
        restaked: row['restaked'] === true,
        maxLocked: row['maxLocked'] === true,
        withdrawn: row['withdrawn'] === true,
        returnedAmount: str(row['returnedAmount']),
        slashedAmount: str(row['slashedAmount']),
        createdAt: num(row['createdAt']),
        closedAt: optional(row['closedAt'], num),
    };
}
const toSellerEpoch = (row) => ({
    seller: lower(row['seller']) ?? '',
    epoch: num(row['epoch']),
    agentId: optional(row['agentId'], num),
    volumeUsdc: str(row['volumeUsdc']),
    points: str(row['points']),
    weightedPoints: str(row['weightedPoints']),
    requests: str(row['requests']),
});
const toBuyerEpoch = (row) => ({
    buyer: lower(row['buyer']) ?? '',
    epoch: num(row['epoch']),
    volumeUsdc: str(row['volumeUsdc']),
    points: str(row['points']),
    weightedPoints: str(row['weightedPoints']),
    requests: str(row['requests']),
});
export class AntscanIndexer {
    fetchImpl;
    ttlMs;
    baseUrl;
    cache = new Map();
    constructor(baseUrl, fetchImpl = fetch, ttlMs = CACHE_TTL_MS) {
        this.fetchImpl = fetchImpl;
        this.ttlMs = ttlMs;
        this.baseUrl = baseUrl.replace(/\/$/, '');
    }
    get(path) {
        const hit = this.cache.get(path);
        if (hit && Date.now() - hit.at < this.ttlMs)
            return hit.value;
        const url = `${this.baseUrl}${path}`;
        const value = (async () => {
            let response;
            try {
                response = await this.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } });
            }
            catch (error) {
                throw new IndexerError(`Explorer unreachable: ${error.message}`, url);
            }
            if (!response.ok)
                throw new IndexerError(`Explorer responded with HTTP ${response.status}`, url);
            return await response.json();
        })();
        this.cache.set(path, { at: Date.now(), value });
        value.catch(() => { if (this.cache.get(path)?.value === value)
            this.cache.delete(path); });
        return value;
    }
    async pools() {
        const raw = await this.get('/api/staking/pools');
        return {
            currentEpoch: num(raw.currentEpoch),
            network: { current: toStakingEpoch(raw.network?.current ?? null), last: toStakingEpoch(raw.network?.last ?? null) },
            pools: (raw.pools ?? []).map(toPool),
        };
    }
    async pool(agentId, epochs = 8) {
        const raw = await this.get(`/api/staking/pools/${agentId}?epochs=${epochs}`);
        return {
            pool: raw.pool ? toPool(raw.pool) : null,
            epochs: (raw.epochs ?? []).map((row) => ({
                epoch: num(row['epoch']), weight: str(row['weight']), activeStake: str(row['activeStake']), usagePoints: str(row['usagePoints']), weightedUsagePoints: str(row['weightedUsagePoints']),
                volumeUsdc: str(row['volumeUsdc']), requests: str(row['requests']), settledEmission: str(row['settledEmission']), settled: row['settled'] === true,
            })),
            openPositions: num(raw.openPositions),
            stakers: num(raw.stakers),
        };
    }
    async positions(owner, includeClosed = true) {
        const raw = await this.get(`/api/staking/positions?owner=${owner.toLowerCase()}${includeClosed ? '&includeClosed=1' : ''}`);
        return (raw.positions ?? []).map(toPosition);
    }
    async stakingEpochs(limit = 8) {
        const raw = await this.get(`/api/staking/epochs?limit=${limit}`);
        return (raw ?? []).map((row) => toStakingEpoch(row));
    }
    async sellerEpochs(epochs = 3) {
        const raw = await this.get(`/api/staking/seller-epochs?epochs=${epochs}`);
        const bySeller = new Map();
        for (const row of (raw.rows ?? []).map(toSellerEpoch))
            bySeller.set(row.seller, [...(bySeller.get(row.seller) ?? []), row]);
        return bySeller;
    }
    async participant(address, epochs = 8) {
        const raw = await this.get(`/api/staking/participants/${address.toLowerCase()}?epochs=${epochs}`);
        return { address: address.toLowerCase(), currentEpoch: num(raw.currentEpoch), seller: (raw.seller ?? []).map(toSellerEpoch), buyer: (raw.buyer ?? []).map(toBuyerEpoch) };
    }
    async epochMetrics() {
        const raw = await this.get('/api/epochs');
        return (raw ?? []).map((row) => ({ epoch: num(row['epoch']), volumeUsdc: str(row['volumeUsdc']), requests: str(row['requests']) }));
    }
}
/** The indexer for a chain config; null when no explorer is configured (`explorerApiUrl: ''`). */
export function createIndexer(baseUrl, fetchImpl = fetch) {
    return baseUrl ? new AntscanIndexer(baseUrl, fetchImpl) : null;
}
//# sourceMappingURL=indexer.js.map