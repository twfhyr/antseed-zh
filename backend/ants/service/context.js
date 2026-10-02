import { FetchRequest, JsonRpcProvider, ZeroAddress } from 'ethers';
import { RotatingJsonRpcProvider } from './rpc-provider.js';
import { createIndexer } from './indexer.js';
import { ANTSTokenClient, DepositsClient, EmissionsClient, EmissionsGateClient, IdentityClient, PointsPolicyRegistryClient, PositionInitClient, RegistryClient, SellerPoolsClient, SellerPoolsRewardsClient, SellerRegistryClient, SellerRewardsPoolClient, StakingClient, UsageAccountingClient, UsageRewardsClient, WashTradingRegistryClient, resolveLegacyContractAddresses, } from '@antseed/node/payments';
function sameAddress(a, b) {
    return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}
export class MissingContractError extends Error {
    constructor(name, chainId) {
        super(`${name} address is not configured for chain '${chainId}'. Set payments.crypto.${name}Address or upgrade @antseed/cli.`);
        this.name = 'MissingContractError';
    }
}
/**
 * One wallet's view of the ANTS contracts. Lazily builds SDK clients from the
 * resolved chain configuration and caches the stack resolution so a burst of
 * dashboard reads does not re-query the registry pointers each time.
 */
export class AntsContext {
    chain;
    address;
    signer;
    stackTtlMs;
    stackCache = null;
    clients = new Map();
    probeRpc;
    rpcSelection = null;
    sharedProvider = null;
    indexerClient;
    rpcOrder = null;
    constructor(options) {
        this.chain = options.chain;
        this.address = options.address;
        this.signer = options.signer;
        this.stackTtlMs = options.stackTtlMs ?? 15_000;
        this.probeRpc = options.probeRpc ?? probeRpcEndpoint;
    }
    /**
     * Rank the configured endpoints once by a short `eth_call` burst and route
     * reads through one rotating provider in that order (see
     * `RotatingJsonRpcProvider`). The public Base gateways differ a lot in how
     * hard they throttle a burst (Tenderly rejects about a third, nodies none)
     * and any of them can stall, so the order is a hint and the provider still
     * moves off an endpoint that throttles at run time.
     */
    selectRpc() {
        if (!this.rpcSelection) {
            this.rpcSelection = (async () => {
                const fallbacks = this.chain.fallbackRpcUrls ?? [];
                if (fallbacks.length === 0)
                    return;
                const candidates = [this.chain.rpcUrl, ...fallbacks];
                const scores = await Promise.all(candidates.map(async (url, index) => ({ url, index, score: await this.probeRpc(url).catch(() => null) })));
                const usable = scores
                    .filter((entry) => entry.score !== null)
                    .sort((a, b) => a.score - b.score || a.index - b.index);
                if (usable.length === 0)
                    return;
                const unusable = scores.filter((entry) => entry.score === null);
                const ordered = [...usable, ...unusable].map((entry) => entry.url);
                this.rpcOrder = ordered;
                this.chain = { ...this.chain, rpcUrl: ordered[0], fallbackRpcUrls: ordered.slice(1) };
                this.clients.clear();
                this.sharedProvider = null;
            })();
        }
        return this.rpcSelection;
    }
    /** Explorer-backed indexer for lists and history; null when `explorerApiUrl` is empty. */
    indexer() {
        if (this.indexerClient === undefined)
            this.indexerClient = createIndexer(this.chain.explorerApiUrl);
        return this.indexerClient;
    }
    requireSigner() {
        if (!this.signer)
            throw new Error('This action needs the node wallet; no signer is available in read-only mode.');
        return this.signer;
    }
    base(contractAddress) {
        return {
            rpcUrl: this.chain.rpcUrl,
            ...(this.chain.fallbackRpcUrls && this.chain.fallbackRpcUrls.length > 0 ? { fallbackRpcUrls: this.chain.fallbackRpcUrls } : {}),
            contractAddress,
            evmChainId: this.chain.evmChainId,
        };
    }
    cached(key, build) {
        let client = this.clients.get(key);
        if (!client) {
            client = build();
            const shared = this.provider();
            if (typeof client.withProvider === 'function') {
                client.withProvider(shared);
            }
            this.clients.set(key, client);
        }
        return client;
    }
    /**
     * One rotating provider shared by every client, in the order `selectRpc`
     * chose (configured order before that), replacing the ethers failover
     * provider each client would otherwise build.
     */
    provider() {
        if (!this.sharedProvider) {
            this.sharedProvider = new RotatingJsonRpcProvider(this.rpcOrder ?? [this.chain.rpcUrl, ...(this.chain.fallbackRpcUrls ?? [])], this.chain.evmChainId);
        }
        return this.sharedProvider;
    }
    optional(key, address, build) {
        if (!address || sameAddress(address, ZeroAddress))
            return null;
        return this.cached(`${key}:${address.toLowerCase()}`, () => build(address));
    }
    required(name, key, address, build) {
        const client = this.optional(key, address, build);
        if (!client)
            throw new MissingContractError(name, this.chain.chainId);
        return client;
    }
    registry() {
        return this.required('registryContract', 'registry', this.chain.registryContractAddress, (address) => new RegistryClient(this.base(address)));
    }
    antsToken() {
        return this.required('antsToken', 'ants', this.chain.antsTokenAddress, (address) => new ANTSTokenClient(this.base(address)));
    }
    identity() {
        return this.optional('identity', this.chain.identityRegistryAddress, (address) => new IdentityClient(this.base(address)));
    }
    deposits() {
        return this.optional('deposits', this.chain.depositsContractAddress, (address) => new DepositsClient({
            ...this.base(address), usdcAddress: this.chain.usdcContractAddress ?? ZeroAddress,
        }));
    }
    gate() {
        return this.optional('gate', this.chain.emissionsGateAddress, (address) => new EmissionsGateClient(this.base(address)));
    }
    pools() {
        return this.optional('pools', this.chain.sellerPoolsAddress, (address) => new SellerPoolsClient({
            ...this.base(address), antsTokenAddress: this.chain.antsTokenAddress ?? ZeroAddress,
        }));
    }
    requirePools() {
        const pools = this.pools();
        if (!pools)
            throw new MissingContractError('sellerPools', this.chain.chainId);
        return pools;
    }
    poolRewards() {
        return this.optional('poolRewards', this.chain.sellerPoolsRewardsAddress, (address) => new SellerPoolsRewardsClient(this.base(address)));
    }
    requirePoolRewards() {
        const rewards = this.poolRewards();
        if (!rewards)
            throw new MissingContractError('sellerPoolsRewards', this.chain.chainId);
        return rewards;
    }
    sellerRegistry() {
        return this.optional('sellerRegistry', this.chain.sellerRegistryAddress, (address) => new SellerRegistryClient(this.base(address)));
    }
    usageAccounting() {
        return this.optional('usageAccounting', this.chain.usageAccountingAddress, (address) => new UsageAccountingClient(this.base(address)));
    }
    usageRewards() {
        return this.optional('usageRewards', this.chain.usageRewardsAddress, (address) => new UsageRewardsClient(this.base(address)));
    }
    positionInit() {
        return this.optional('positionInit', this.chain.positionInitAddress, (address) => new PositionInitClient(this.base(address)));
    }
    washRegistry() {
        return this.optional('wash', this.chain.washTradingRegistryAddress, (address) => new WashTradingRegistryClient(this.base(address)));
    }
    pointsPolicyRegistry() {
        return this.optional('policies', this.chain.pointsPolicyRegistryAddress, (address) => new PointsPolicyRegistryClient(this.base(address)));
    }
    legacyEmissionsAt(address) {
        return this.optional('legacyEmissions', address ?? undefined, (target) => new EmissionsClient(this.base(target)));
    }
    legacyStakingAt(address) {
        return this.optional('legacyStaking', address ?? undefined, (target) => new StakingClient({
            ...this.base(target), usdcAddress: this.chain.usdcContractAddress ?? ZeroAddress,
        }));
    }
    lockedPoolAt(address) {
        return this.optional('lockedPool', address ?? undefined, (target) => new SellerRewardsPoolClient(this.base(target)));
    }
    /** Address book for display. */
    addresses() {
        const entries = [
            ['registry', this.chain.registryContractAddress],
            ['antsToken', this.chain.antsTokenAddress],
            ['emissionsGate', this.chain.emissionsGateAddress],
            ['sellerPools', this.chain.sellerPoolsAddress],
            ['sellerPoolsRewards', this.chain.sellerPoolsRewardsAddress],
            ['sellerRegistry', this.chain.sellerRegistryAddress],
            ['usageAccounting', this.chain.usageAccountingAddress],
            ['usageRewards', this.chain.usageRewardsAddress],
            ['positionInit', this.chain.positionInitAddress],
            ['pointsPolicyRegistry', this.chain.pointsPolicyRegistryAddress],
            ['washTradingRegistry', this.chain.washTradingRegistryAddress],
            ['legacyEmissionsEscrow', this.chain.legacyEmissionsEscrowAddress],
            ['emissions', this.chain.emissionsContractAddress],
            ['staking', this.chain.stakingContractAddress],
            ['legacyEmissions', this.chain.legacyEmissionsContractAddress],
            ['legacyStaking', this.chain.legacyStakingContractAddress],
            ['legacyEmissionsV1', this.chain.legacyEmissionsV1ContractAddress],
            ['deposits', this.chain.depositsContractAddress],
            ['channels', this.chain.channelsContractAddress],
            ['identityRegistry', this.chain.identityRegistryAddress],
            ['usdc', this.chain.usdcContractAddress],
        ];
        return Object.fromEntries(entries.filter((entry) => !!entry[1]));
    }
    invalidate() { this.stackCache = null; }
    /** Determine which protocol phase the chain is in and where legacy claims live. */
    async stack() {
        if (this.stackCache && Date.now() - this.stackCache.resolvedAt < this.stackTtlMs)
            return this.stackCache;
        await this.selectRpc();
        const registry = this.registry();
        const [emissions, staking] = await Promise.all([registry.emissions(), registry.staking()]);
        const registryPointers = { emissions, staking };
        const deployed = !!this.chain.usageAccountingAddress && !!this.chain.sellerRegistryAddress;
        const active = deployed && sameAddress(emissions, this.chain.usageAccountingAddress) && sameAddress(staking, this.chain.sellerRegistryAddress);
        const phase = active ? 'active' : deployed ? 'deployed' : 'legacy';
        let legacyEmissions;
        let legacyStaking;
        let legacyEmissionsV1;
        if (phase === 'active') {
            const legacy = resolveLegacyContractAddresses(this.chain);
            legacyEmissions = legacy.legacyEmissionsContractAddress ?? null;
            legacyStaking = legacy.legacyStakingContractAddress ?? null;
            legacyEmissionsV1 = legacy.legacyEmissionsV1ContractAddress ?? null;
        }
        else {
            legacyEmissions = this.chain.emissionsContractAddress ?? emissions;
            legacyStaking = this.chain.stakingContractAddress ?? staking;
            legacyEmissionsV1 = this.chain.legacyEmissionsContractAddress ?? null;
        }
        const gate = this.gate();
        let currentEpoch;
        let effectiveEpoch = null;
        let genesis;
        let epochDuration;
        if (gate) {
            [currentEpoch, effectiveEpoch, genesis, epochDuration] = await Promise.all([gate.currentEpoch(), gate.effectiveEpoch(), gate.genesis(), gate.epochDuration()]);
        }
        else {
            const legacy = this.legacyEmissionsAt(legacyEmissions);
            if (!legacy)
                throw new MissingContractError('emissionsContract', this.chain.chainId);
            const [info, legacyGenesis] = await Promise.all([legacy.getEpochInfo(), legacy.getGenesis()]);
            currentEpoch = info.epoch;
            epochDuration = info.epochDuration;
            genesis = legacyGenesis;
        }
        let lockedRewardsPool = null;
        const legacy = this.legacyEmissionsAt(legacyEmissions);
        if (legacy) {
            try {
                const pool = await legacy.sellerRewardsPool();
                lockedRewardsPool = sameAddress(pool, ZeroAddress) ? null : pool;
            }
            catch {
                lockedRewardsPool = null;
            }
        }
        this.stackCache = {
            phase, currentEpoch, effectiveEpoch, genesis, epochDuration, registryPointers,
            legacyEmissions, legacyStaking, legacyEmissionsV1, lockedRewardsPool, resolvedAt: Date.now(),
        };
        return this.stackCache;
    }
    /** Epoch ranges that can be claimed: legacy epochs end at the effective epoch; recognized epochs start there. */
    async claimableEpochs() {
        const stack = await this.stack();
        const boundary = stack.phase === 'active' && stack.effectiveEpoch !== null ? Math.min(stack.currentEpoch, stack.effectiveEpoch) : stack.currentEpoch;
        const legacy = Array.from({ length: Math.max(0, boundary) }, (_, epoch) => epoch);
        const recognized = stack.phase === 'active' && stack.effectiveEpoch !== null
            ? Array.from({ length: Math.max(0, stack.currentEpoch - stack.effectiveEpoch) }, (_, index) => stack.effectiveEpoch + index)
            : [];
        return { legacy, recognized };
    }
}
const RPC_PROBE_TIMEOUT_MS = 4_000;
const RPC_PROBE_CALLS = 8;
/** Multicall3 `getBlockNumber()`: a cheap `eth_call`, which is what gateways actually meter (Tenderly lets `eth_blockNumber` through and throttles `eth_call`). */
const RPC_PROBE_CALL = { to: '0xcA11bde05977b3631167028862bE2a173976CA11', data: '0x42cbb15c' };
/**
 * Score `url` with a burst of parallel `eth_call`s: null when
 * none answer, otherwise the failure count weighted heavily plus the median
 * latency in seconds, so a throttling gateway ranks below a slower clean one.
 */
export async function probeRpcEndpoint(url) {
    const request = new FetchRequest(url);
    request.timeout = RPC_PROBE_TIMEOUT_MS;
    request.setThrottleParams({ maxAttempts: 1 });
    const provider = new JsonRpcProvider(request, undefined, { staticNetwork: true, batchMaxCount: 1 });
    try {
        const latencies = await Promise.all(Array.from({ length: RPC_PROBE_CALLS }, async () => {
            const started = Date.now();
            try {
                await provider.send('eth_call', [RPC_PROBE_CALL, 'latest']);
                return Date.now() - started;
            }
            catch {
                return null;
            }
        }));
        const answered = latencies.filter((value) => value !== null).sort((a, b) => a - b);
        if (answered.length === 0)
            return null;
        const failures = RPC_PROBE_CALLS - answered.length;
        return failures * 10 + answered[Math.floor(answered.length / 2)] / 1000;
    }
    finally {
        provider.destroy();
    }
}
//# sourceMappingURL=context.js.map