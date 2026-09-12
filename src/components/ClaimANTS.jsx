import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  useAccount,
  useWriteContract,
  usePublicClient,
} from 'wagmi';
import {
  Award,
  Loader2,
  AlertCircle,
  CheckCircle,
  ExternalLink,
  Zap,
  Lock,
  Layers,
  TrendingUp,
  Users,
  Search,
  Wallet,
} from 'lucide-react';
import { fetchEmissionsEpochInfo, fetchEmissionsPending, fetchEmissionsBalance, fetchRewards } from '../api';

// ─── Claim ABIs (Base mainnet, recognized-usage era + legacy) ───
const USAGE_ACCOUNTING_ABI = [
  {
    name: 'claimSellerEmissions',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'epochs', type: 'uint256[]' }],
    outputs: [],
  },
];
const USAGE_REWARDS_ABI = [
  {
    name: 'claimBuyerReward',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'buyer', type: 'address' },
      { name: 'epoch', type: 'uint256' },
    ],
    outputs: [],
  },
];
const SELLER_POOLS_REWARDS_ABI = [
  {
    name: 'poolRewardIndexNextEpoch',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'initialIndexEpoch',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'indexPoolRewards',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'maxEpochs', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'pendingIndexedStakerReward',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'positionId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'claimStakerRewardsBatch',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'positionIds', type: 'uint256[]' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [],
  },
];
const SELLER_POOLS_ABI = [
  {
    name: 'currentEpoch',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
];
const LOCKED_POOL_ABI = [
  {
    name: 'claim',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'recipient', type: 'address' }],
    outputs: [],
  },
];
// Legacy emissions (V2 for epochs >= 4, V1 before the migration)
const EMISSIONS_ABI = [
  {
    name: 'claimSellerEmissions',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'epochs', type: 'uint256[]' }],
    outputs: [],
  },
  {
    name: 'claimBuyerEmissions',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'buyer', type: 'address' },
      { name: 'epochs', type: 'uint256[]' },
    ],
    outputs: [],
  },
];

const BUCKET_LABELS = {
  staker: 'Staker',
  sellerUsage: 'Seller Usage',
  buyerUsage: 'Buyer Usage',
  legacy: 'Legacy Emissions',
  locked: 'Locked Rewards',
  all: 'All Buckets',
};

function ClaimANTS() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  // Data states
  const [epochInfo, setEpochInfo] = useState(null);
  const [rewards, setRewards] = useState(null);
  const [legacyPending, setLegacyPending] = useState(null);
  const [balance, setBalance] = useState(null);
  const [loading, setLoading] = useState(false);

  // Claim status: { bucket, phase: 'preparing'|'claiming'|'done'|'error', message, hashes: [] }
  const [claimStatus, setClaimStatus] = useState(null);
  const claimErrorRef = useRef(false);

  // Search states (for non-connected users)
  const [searchInput, setSearchInput] = useState('');
  const [searchAddress, setSearchAddress] = useState(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(null);

  // Buyer channel addresses (legacy buyer emissions tracked under signer wallets)
  const [buyerAddresses, setBuyerAddresses] = useState([]);
  const [buyerAddressInput, setBuyerAddressInput] = useState('');

  // ── Helpers ──
  const formatNum = (n) => {
    if (n === undefined || n === null || Number.isNaN(n)) return '—';
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(2) + 'K';
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  };

  const truncateAddress = (addr) => addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '';
  const isValidAddress = (addr) => /^0x[a-fA-F0-9]{40}$/.test(addr);

  // ── Load rewards + legacy epoch table ──
  const loadData = useCallback(async (addr, bustCache = false, buyerAddrs = []) => {
    setLoading(true);
    try {
      const [info, rewardsData, bal] = await Promise.all([
        fetchEmissionsEpochInfo(),
        fetchRewards(addr, bustCache),
        fetchEmissionsBalance(addr),
      ]);
      setEpochInfo(info);
      setRewards(rewardsData);
      setBalance(bal);

      // Legacy table covers epochs 0..boundary-1 (frozen once the recognized
      // era starts); during the legacy era it also shows the ongoing epoch.
      const boundary = info.effectiveEpoch != null
        ? Math.min(info.currentEpoch, info.effectiveEpoch)
        : Math.min(info.currentEpoch + 1, 52);
      const epochs = Array.from({ length: boundary }, (_, i) => i);
      if (epochs.length > 0) {
        const pending = await fetchEmissionsPending(addr, epochs, bustCache, buyerAddrs);
        setLegacyPending(pending);
      } else {
        setLegacyPending(null);
      }
    } catch (e) {
      console.error('Failed to load rewards data:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBuyerAddresses = useCallback(async (operatorAddr) => {
    try {
      const resp = await fetch(`/api/operator-buyers?operator=${operatorAddr.toLowerCase()}`);
      const rows = await resp.json();
      if (Array.isArray(rows) && rows.length > 0) {
        setBuyerAddresses(rows.map((r) => r.buyer));
        return rows.map((r) => r.buyer);
      }
    } catch {}
    return [];
  }, []);

  useEffect(() => {
    if (!isConnected || !address) {
      setRewards(null);
      setBalance(null);
      setLegacyPending(null);
      return;
    }
    (async () => {
      const addrs = await loadBuyerAddresses(address);
      loadData(address, false, addrs);
    })();
  }, [isConnected, address, loadData, loadBuyerAddresses]);

  // ── Search ──
  const handleSearch = async (e) => {
    e?.preventDefault();
    const addr = searchInput.trim();
    if (!isValidAddress(addr)) {
      setSearchError('Invalid address format. Must be 0x followed by 40 hex characters.');
      return;
    }
    setSearchError(null);
    setSearchAddress(addr);
    setSearchLoading(true);
    const addrs = await loadBuyerAddresses(addr);
    await loadData(addr, true, addrs);
    setSearchLoading(false);
  };

  // ── Derived state ──
  const displayAddress = isConnected ? address : searchAddress;
  const isLoading = isConnected ? loading : searchLoading;
  const canClaim = isConnected && !!address && !!displayAddress
    && address.toLowerCase() === displayAddress.toLowerCase();

  const sellerEpochsClaimable = (rewards?.sellerUsage?.epochs || []).filter((e) => e.amount > 0 && !e.claimed);
  const buyerEpochsClaimable = (rewards?.buyerUsage?.epochs || []).filter((e) => e.amount > 0 && !e.claimed);
  const stakerPending = rewards?.staker?.positions || [];

  const hasStaker = canClaim && stakerPending.length > 0;
  const hasSellerUsage = canClaim && !!rewards?.sellerUsage?.claimable && sellerEpochsClaimable.length > 0;
  const hasBuyerUsage = canClaim && !!rewards?.buyerUsage?.claimable && buyerEpochsClaimable.length > 0;
  const hasLocked = canClaim && (rewards?.locked?.claimable || 0) > 0;
  // Epoch 4 exists in BOTH legacy emissions contracts (V1 partial + V2 partial),
  // so claimability and claim routing must be per-contract around the migration boundary.
  const epochPendingV1 = (e, type) => (type === 'seller' ? e.sellerRewardV1 : e.buyerRewardV1) || 0;
  const epochPendingV2 = (e, type) => (type === 'seller' ? e.sellerRewardV2 : e.buyerRewardV2) || 0;
  const legacyEpochClaimable = (e, type) => {
    if (e.isCurrentEpoch) return false;
    const total = type === 'seller' ? e.sellerReward : e.buyerReward;
    if (!(total > 0)) return false;
    if (e.epoch === 4) return epochPendingV1(e, type) > 0 || epochPendingV2(e, type) > 0;
    return type === 'seller' ? !e.sellerClaimed : !e.buyerClaimed;
  };
  const legacyClaimableSeller = (legacyPending?.epochs || []).filter((e) => legacyEpochClaimable(e, 'seller'));
  const legacyClaimableBuyer = (legacyPending?.epochs || []).filter((e) => legacyEpochClaimable(e, 'buyer'));
  const hasLegacy = canClaim && (legacyClaimableSeller.length > 0 || legacyClaimableBuyer.length > 0);

  const totalClaimable = rewards?.total || 0;
  const anyClaimable = hasStaker || hasSellerUsage || hasBuyerUsage || hasLegacy || hasLocked;

  // ── Shared tx helper ──
  const sendTx = async (request) => {
    const hash = await writeContractAsync(request);
    if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  };

  // ── Staker: index pool rewards up to each position's target epoch, then batch claim ──
  const claimStaker = async () => {
    const r = rewards;
    if (!r?.contracts?.sellerPoolsRewards || stakerPending.length === 0) return false;
    const spr = r.contracts.sellerPoolsRewards;
    const pools = r.contracts.sellerPools;
    const label = 'staker';
    try {
      setClaimStatus({ bucket: label, phase: 'preparing', message: 'Preparing pool reward indexes…', hashes: [] });
      const currentEpoch = Number(await publicClient.readContract({
        address: pools, abi: SELLER_POOLS_ABI, functionName: 'currentEpoch',
      }));
      const hashes = [];
      for (const agentId of new Set(stakerPending.map((p) => p.agentId))) {
        const targets = stakerPending.filter((p) => p.agentId === agentId);
        const targetEpoch = targets.reduce(
          (latest, t) => Math.max(latest, Math.min(currentEpoch, t.closedAtEpoch || currentEpoch)), 0);
        let cursor = Number(await publicClient.readContract({
          address: spr, abi: SELLER_POOLS_REWARDS_ABI, functionName: 'poolRewardIndexNextEpoch', args: [agentId],
        })) || Number(await publicClient.readContract({
          address: spr, abi: SELLER_POOLS_REWARDS_ABI, functionName: 'initialIndexEpoch',
        }));
        let guard = 0;
        while (cursor < targetEpoch && guard++ < 60) {
          setClaimStatus({ bucket: label, phase: 'preparing', message: `Indexing pool ${agentId} rewards (epochs ${cursor}…${Math.min(targetEpoch, cursor + 16) - 1})`, hashes });
          const maxEpochs = Math.min(16, targetEpoch - cursor);
          const hash = await sendTx({ address: spr, abi: SELLER_POOLS_REWARDS_ABI, functionName: 'indexPoolRewards', args: [agentId, maxEpochs] });
          hashes.push(hash);
          const next = Number(await publicClient.readContract({
            address: spr, abi: SELLER_POOLS_REWARDS_ABI, functionName: 'poolRewardIndexNextEpoch', args: [agentId],
          }));
          if (next <= cursor) throw new Error('Reward indexing made no progress; retry later.');
          cursor = next;
        }
      }
      const ids = [];
      for (const p of stakerPending) {
        const pending = await publicClient.readContract({
          address: spr, abi: SELLER_POOLS_REWARDS_ABI, functionName: 'pendingIndexedStakerReward', args: [p.id],
        });
        if (pending > 0n) ids.push(p.id);
      }
      if (ids.length === 0) {
        claimErrorRef.current = true;
        setClaimStatus({ bucket: label, phase: 'error', message: 'Rewards are not indexed yet; retry after the next epoch.', hashes });
        return false;
      }
      for (let offset = 0; offset < ids.length; offset += 32) {
        const batch = ids.slice(offset, offset + 32);
        setClaimStatus({ bucket: label, phase: 'claiming', message: `Claiming staker rewards for position(s) ${batch.join(', ')}`, hashes });
        const hash = await sendTx({ address: spr, abi: SELLER_POOLS_REWARDS_ABI, functionName: 'claimStakerRewardsBatch', args: [batch, address] });
        hashes.push(hash);
      }
      setClaimStatus({ bucket: label, phase: 'done', message: `Staker rewards claimed for ${ids.length} position(s)`, hashes });
      return true;
    } catch (e) {
      claimErrorRef.current = true;
      setClaimStatus({ bucket: label, phase: 'error', message: e.shortMessage || e.message, hashes: [] });
      return false;
    }
  };

  // ── Seller usage: claimSellerEmissions(epochs) on UsageAccounting ──
  const claimSellerUsage = async (epochsArg) => {
    const r = rewards;
    if (!r?.contracts?.usageAccounting) return false;
    const epochs = epochsArg ?? sellerEpochsClaimable.map((e) => e.epoch);
    if (epochs.length === 0) return false;
    const label = 'sellerUsage';
    try {
      setClaimStatus({ bucket: label, phase: 'claiming', message: `Claiming seller usage rewards for epoch(s) ${epochs.join(', ')}`, hashes: [] });
      const hashes = [];
      for (let offset = 0; offset < epochs.length; offset += 16) {
        const batch = epochs.slice(offset, offset + 16);
        const hash = await sendTx({ address: r.contracts.usageAccounting, abi: USAGE_ACCOUNTING_ABI, functionName: 'claimSellerEmissions', args: [batch] });
        hashes.push(hash);
      }
      setClaimStatus({ bucket: label, phase: 'done', message: `Seller usage rewards claimed for epoch(s) ${epochs.join(', ')}`, hashes });
      return true;
    } catch (e) {
      claimErrorRef.current = true;
      setClaimStatus({ bucket: label, phase: 'error', message: e.shortMessage || e.message, hashes: [] });
      return false;
    }
  };

  // ── Buyer usage: claimBuyerReward(buyer, epoch) per epoch (deposits operator) ──
  const claimBuyerUsage = async (epochsArg) => {
    const r = rewards;
    if (!r?.contracts?.usageRewards) return false;
    const epochs = epochsArg ?? buyerEpochsClaimable.map((e) => e.epoch);
    if (epochs.length === 0) return false;
    const label = 'buyerUsage';
    try {
      const hashes = [];
      for (const epoch of epochs) {
        setClaimStatus({ bucket: label, phase: 'claiming', message: `Claiming buyer usage reward for epoch ${epoch}`, hashes });
        const hash = await sendTx({ address: r.contracts.usageRewards, abi: USAGE_REWARDS_ABI, functionName: 'claimBuyerReward', args: [displayAddress, epoch] });
        hashes.push(hash);
      }
      setClaimStatus({ bucket: label, phase: 'done', message: `Buyer usage rewards claimed for epoch(s) ${epochs.join(', ')}`, hashes });
      return true;
    } catch (e) {
      claimErrorRef.current = true;
      setClaimStatus({ bucket: label, phase: 'error', message: e.shortMessage || e.message, hashes: [] });
      return false;
    }
  };

  // ── Legacy: per-contract routing around the epoch-4 migration boundary ───
  const claimLegacy = async (type) => {
    const r = rewards;
    if (!r?.contracts?.legacyEmissions) return false;
    const claimable = type === 'buyer' ? legacyClaimableBuyer : legacyClaimableSeller;
    if (claimable.length === 0) return false;
    const v1Contract = r.contracts.legacyEmissionsV1 || r.contracts.legacyEmissions;
    const v1Epochs = claimable
      .filter((e) => e.epoch < 4 || (e.epoch === 4 && epochPendingV1(e, type) > 0))
      .map((e) => e.epoch);
    const v2Epochs = claimable
      .filter((e) => e.epoch > 4 || (e.epoch === 4 && (epochPendingV2(e, type) > 0 || e.sellerRewardV1 === undefined)))
      .map((e) => e.epoch);
    const label = 'legacy';
    try {
      const hashes = [];
      const run = async (contract, epochList) => {
        if (epochList.length === 0) return;
        setClaimStatus({
          bucket: label, phase: 'claiming',
          message: `Claiming legacy ${type} emissions for epoch(s) ${epochList.join(', ')}`,
          hashes,
        });
        const args = type === 'buyer' ? [displayAddress, epochList] : [epochList];
        const hash = await sendTx({
          address: contract, abi: EMISSIONS_ABI,
          functionName: type === 'buyer' ? 'claimBuyerEmissions' : 'claimSellerEmissions',
          args,
        });
        hashes.push(hash);
      };
      await run(v1Contract, v1Epochs);
      await run(r.contracts.legacyEmissions, v2Epochs);
      setClaimStatus({ bucket: label, phase: 'done', message: `Legacy ${type} emissions claimed`, hashes });
      return true;
    } catch (e) {
      claimErrorRef.current = true;
      setClaimStatus({ bucket: label, phase: 'error', message: e.shortMessage || e.message, hashes: [] });
      return false;
    }
  };

  // ── Locked (M002): claim(recipient) on SellerRewardsPool ───
  const claimLocked = async () => {
    const r = rewards;
    if (!r?.locked?.pool || !(r.locked.claimable > 0)) return false;
    const label = 'locked';
    try {
      setClaimStatus({ bucket: label, phase: 'claiming', message: `Releasing ${formatNum(r.locked.claimable)} ANTS from the locked legacy rewards pool`, hashes: [] });
      const hash = await sendTx({ address: r.locked.pool, abi: LOCKED_POOL_ABI, functionName: 'claim', args: [address] });
      setClaimStatus({ bucket: label, phase: 'done', message: 'Locked rewards released', hashes: [hash] });
      return true;
    } catch (e) {
      claimErrorRef.current = true;
      setClaimStatus({ bucket: label, phase: 'error', message: e.shortMessage || e.message, hashes: [] });
      return false;
    }
  };

  // ── Per-epoch legacy claim (V1 for epochs < 4, both contracts for epoch 4, V2 above) ───
  const claimLegacyEpoch = async (epochData, type) => {
    const r = rewards;
    if (!r?.contracts?.legacyEmissions) return;
    const v1Contract = r.contracts.legacyEmissionsV1 || r.contracts.legacyEmissions;
    const hasBreakdown = epochData.epoch === 4 && epochData.sellerRewardV1 !== undefined;
    const useV1 = epochData.epoch < 4 || (hasBreakdown && epochPendingV1(epochData, type) > 0);
    const useV2 = epochData.epoch > 4 || (hasBreakdown ? epochPendingV2(epochData, type) > 0 : epochData.epoch === 4);
    const label = 'legacy';
    const args = (contractEpochs) => (type === 'buyer' ? [displayAddress, contractEpochs] : [contractEpochs]);
    try {
      const hashes = [];
      const claimOne = async (contract, message) => {
        setClaimStatus({ bucket: label, phase: 'claiming', message, hashes });
        const hash = await sendTx({
          address: contract, abi: EMISSIONS_ABI,
          functionName: type === 'buyer' ? 'claimBuyerEmissions' : 'claimSellerEmissions',
          args: args([epochData.epoch]),
        });
        hashes.push(hash);
      };
      if (useV1) await claimOne(v1Contract, `Claiming legacy ${type} emission for epoch ${epochData.epoch} (V1 contract)`);
      if (useV2) await claimOne(r.contracts.legacyEmissions, `Claiming legacy ${type} emission for epoch ${epochData.epoch}${useV1 ? ' (V2 contract)' : ''}`);
      setClaimStatus({
        bucket: label, phase: 'done',
        message: `Legacy ${type} emission claimed for epoch ${epochData.epoch}`,
        hashes,
      });
    } catch (e) {
      setClaimStatus({ bucket: label, phase: 'error', message: e.shortMessage || e.message, hashes: [] });
    }
  };

  // ── Claim all buckets in sequence (official ANTS dashboard flow) ───
  const claimAll = async () => {
    if (!canClaim) return;
    claimErrorRef.current = false;
    setClaimStatus({ bucket: 'all', phase: 'preparing', message: 'Claiming all reward buckets…', hashes: [] });
    let claimedAny = false;
    const run = async (fn) => {
      if (claimErrorRef.current) return;
      claimedAny = (await fn()) || claimedAny;
    };
    if (hasStaker) await run(claimStaker);
    if (hasSellerUsage) await run(() => claimSellerUsage());
    if (hasBuyerUsage) await run(() => claimBuyerUsage());
    if (hasLegacy) {
      await run(() => claimLegacy('seller'));
      await run(() => claimLegacy('buyer'));
    }
    if (hasLocked) await run(claimLocked);
    if (claimErrorRef.current) return;
    if (claimedAny) {
      await loadData(displayAddress, true, buyerAddresses);
      setClaimStatus({ bucket: 'all', phase: 'done', message: 'All reward buckets claimed', hashes: [] });
    } else {
      setClaimStatus({ bucket: 'all', phase: 'done', message: 'Nothing to claim', hashes: [] });
    }
  };

  // Reload after a successful single-bucket claim
  useEffect(() => {
    if (claimStatus?.phase === 'done' && claimStatus.bucket !== 'all' && displayAddress) {
      loadData(displayAddress, true, buyerAddresses);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimStatus?.phase, claimStatus?.bucket]);

  // ── Recognized-era epoch rows (merged seller + buyer) ───
  const recognizedRows = useMemo(() => {
    const map = new Map();
    for (const e of rewards?.sellerUsage?.epochs || []) {
      map.set(e.epoch, { epoch: e.epoch, seller: e });
    }
    for (const e of rewards?.buyerUsage?.epochs || []) {
      const row = map.get(e.epoch) || { epoch: e.epoch };
      row.buyer = e;
      map.set(e.epoch, row);
    }
    return [...map.values()].sort((a, b) => b.epoch - a.epoch);
  }, [rewards]);

  const isBucketBusy = (bucket) =>
    !!claimStatus && claimStatus.phase !== 'done' && claimStatus.phase !== 'error'
    && (claimStatus.bucket === bucket || claimStatus.bucket === 'all');

  return (
    <div className="table-container" style={{ padding: '2rem' }}>
      <div style={{ maxWidth: '900px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Award size={24} style={{ color: 'var(--accent)' }} />
              Claim ANTS
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              Five reward buckets on Base mainnet — staking, recognized usage (since epoch {rewards?.effectiveEpoch ?? epochInfo?.effectiveEpoch ?? '—'}), legacy emissions
            </p>
          </div>
          {canClaim && anyClaimable && (
            <button
              onClick={claimAll}
              disabled={!anyClaimable || isBucketBusy('all')}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                padding: '0.625rem 1.5rem', borderRadius: '10px', border: 'none',
                background: 'var(--accent)', color: 'white', fontWeight: 600,
                cursor: isBucketBusy('all') ? 'wait' : 'pointer', fontSize: '0.875rem',
                opacity: isBucketBusy('all') ? 0.7 : 1,
              }}
            >
              {isBucketBusy('all') ? <Loader2 size={16} className="spin" /> : <Zap size={16} />}
              Claim All
            </button>
          )}
        </div>

        {/* Search section for non-connected users */}
        {!isConnected && (
          <div style={{ marginBottom: '2rem' }}>
            <div style={{ background: 'var(--bg-secondary)', padding: '1.5rem', borderRadius: '12px' }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Search size={16} style={{ color: 'var(--accent)' }} />
                Look Up Any Address
              </h3>
              <form onSubmit={handleSearch} style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="0x... Enter a Base address"
                  style={{
                    flex: 1, background: 'var(--bg-primary)', border: '1px solid var(--border)',
                    borderRadius: '8px', padding: '0.5rem 0.75rem', color: 'var(--text-primary)',
                    fontFamily: 'monospace', fontSize: '0.875rem', outline: 'none',
                  }}
                />
                <button
                  type="submit"
                  disabled={searchLoading}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.375rem',
                    padding: '0.5rem 1rem', borderRadius: '8px', border: 'none',
                    background: 'var(--accent)', color: 'white', fontWeight: 600,
                    cursor: searchLoading ? 'wait' : 'pointer', fontSize: '0.875rem',
                    whiteSpace: 'nowrap', opacity: searchLoading ? 0.7 : 1,
                  }}
                >
                  {searchLoading ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
                  Search
                </button>
              </form>
              {searchError && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.75rem', color: 'var(--danger)', fontSize: '0.875rem' }}>
                  <AlertCircle size={14} />
                  <span>{searchError}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Not connected and no search yet */}
        {!isConnected && !searchAddress && !searchLoading && (
          <div style={{ textAlign: 'center', padding: '3rem 2rem', color: 'var(--text-secondary)' }}>
            <Wallet size={48} style={{ marginBottom: '1rem', opacity: 0.5 }} />
            <p>Connect your wallet or search an address to view ANTS rewards.</p>
            <p style={{ fontSize: '0.8rem', marginTop: '0.5rem', opacity: 0.7 }}>
              Supports MetaMask, Coinbase Wallet, Rainbow, and other wallets on Base.
            </p>
          </div>
        )}

        {/* Loading state */}
        {isLoading && (
          <div style={{ textAlign: 'center', padding: '3rem 2rem', color: 'var(--text-secondary)' }}>
            <Loader2 size={32} className="spin" />
            <p style={{ marginTop: '1rem' }}>Loading rewards data...</p>
          </div>
        )}

        {/* Data display */}
        {(isConnected || searchAddress) && !isLoading && (
          <>
            {/* Address display */}
            <div style={{ marginBottom: '1.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Viewing:</span>
                <a
                  href={`https://basescan.org/address/${displayAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--info)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.25rem', fontFamily: 'monospace' }}
                >
                  {displayAddress}
                  <ExternalLink size={12} />
                </a>
                {!isConnected && searchAddress && (
                  <span style={{ color: 'var(--text-secondary)' }}>(read-only)</span>
                )}
                {rewards?.agentId ? (
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>· agent #{rewards.agentId}</span>
                ) : null}
              </div>
            </div>

            {/* Stats row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
              <StatCard label="ANTS Balance" value={balance ? formatNum(balance.ants) : '—'} sub="ANTS" />
              <StatCard label="Total Claimable" value={formatNum(totalClaimable)} sub="ANTS" accent="var(--accent)" />
              <StatCard label="Current Epoch" value={epochInfo?.currentEpoch ?? '—'} sub={epochInfo ? `${formatNum(epochInfo.currentEmission)} ANTS/epoch` : ''} />
              <StatCard
                label="Recognized Since"
                value={rewards?.effectiveEpoch ?? epochInfo?.effectiveEpoch ?? '—'}
                sub={rewards?.phase === 'active' ? 'usage era active' : 'era pending'}
              />
            </div>

            {/* Claim status */}
            {claimStatus && (
              <div style={{ background: 'var(--bg-secondary)', padding: '1rem 1.25rem', borderRadius: '12px', marginBottom: '1.5rem', display: 'flex', alignItems: 'flex-start', gap: '0.625rem', flexWrap: 'wrap', fontSize: '0.875rem' }}>
                {claimStatus.phase === 'error' && <AlertCircle size={16} style={{ color: 'var(--danger)', flexShrink: 0 }} />}
                {claimStatus.phase === 'done' && <CheckCircle size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
                {(claimStatus.phase === 'preparing' || claimStatus.phase === 'claiming') && <Loader2 size={16} className="spin" style={{ color: 'var(--info)', flexShrink: 0 }} />}
                <span style={{ fontWeight: 600, marginRight: '0.5rem' }}>{BUCKET_LABELS[claimStatus.bucket]}</span>
                <span style={{ color: claimStatus.phase === 'error' ? 'var(--danger)' : 'var(--text-secondary)' }}>{claimStatus.message}</span>
                {claimStatus.hashes?.length > 0 && (
                  <span style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    {claimStatus.hashes.map((h) => (
                      <a
                        key={h}
                        href={`https://basescan.org/tx/${h}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: 'var(--info)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontFamily: 'monospace' }}
                      >
                        {truncateAddress(h)}
                        <ExternalLink size={10} />
                      </a>
                    ))}
                  </span>
                )}
              </div>
            )}

            {/* Reward buckets */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
              <BucketCard
                title="Staker"
                icon={<Layers size={16} />}
                description="Rewards on locked ANTS (lANTS) positions in seller pools"
                amount={rewards?.staker?.total || 0}
                detail={stakerPending.length > 0 ? `${stakerPending.length} position(s): ${stakerPending.map((p) => `#${p.id}`).join(', ')}` : null}
                claimable={hasStaker}
                busy={isBucketBusy('staker')}
                onClaim={claimStaker}
                canClaim={canClaim}
              />
              <BucketCard
                title="Seller Usage"
                icon={<TrendingUp size={16} />}
                description={`Recognized usage points × pool power (epoch ${rewards?.effectiveEpoch ?? '—'}+)`}
                amount={rewards?.sellerUsage?.total || 0}
                detail={sellerEpochsClaimable.length > 0 ? `${sellerEpochsClaimable.length} unclaimed epoch(s): ${sellerEpochsClaimable.map((e) => e.epoch).join(', ')}` : null}
                claimable={hasSellerUsage}
                busy={isBucketBusy('sellerUsage')}
                onClaim={() => claimSellerUsage()}
                canClaim={canClaim}
                note={rewards?.phase === 'active' && !rewards?.sellerUsage?.claimable ? 'Requires a registered seller agent' : null}
              />
              <BucketCard
                title="Buyer Usage"
                icon={<Users size={16} />}
                description="Recognized buyer usage rewards — paid to the deposits operator"
                amount={rewards?.buyerUsage?.total || 0}
                detail={buyerEpochsClaimable.length > 0 ? `${buyerEpochsClaimable.length} unclaimed epoch(s): ${buyerEpochsClaimable.map((e) => e.epoch).join(', ')}` : null}
                claimable={hasBuyerUsage}
                busy={isBucketBusy('buyerUsage')}
                onClaim={() => claimBuyerUsage()}
                canClaim={canClaim}
                note={rewards?.buyerUsage?.recipient && !rewards?.buyerUsage?.claimable
                  ? `Paid to operator ${truncateAddress(rewards.buyerUsage.recipient)} — claim from that wallet`
                  : null}
              />
              <BucketCard
                title="Legacy Emissions"
                icon={<Award size={16} />}
                description={`Buyer and seller emissions from epochs 0–${(rewards?.effectiveEpoch ?? 1) - 1}`}
                amount={(rewards?.legacy?.seller || 0) + (rewards?.legacy?.buyer || 0)}
                detail={`Seller ${formatNum(rewards?.legacy?.seller || 0)} · Buyer ${formatNum(rewards?.legacy?.buyer || 0)}`}
                claimable={canClaim && legacyClaimableSeller.length > 0}
                busy={isBucketBusy('legacy')}
                onClaim={() => claimLegacy('seller')}
                secondaryClaim={canClaim && legacyClaimableBuyer.length > 0 ? { label: 'Claim Buyer', onClick: () => claimLegacy('buyer') } : null}
                canClaim={canClaim}
              />
              <BucketCard
                title="Locked Rewards"
                icon={<Lock size={16} />}
                description="M002 releases 10% of cumulative locked legacy seller ANTS"
                amount={rewards?.locked?.claimable || 0}
                detail={(rewards?.locked?.locked || 0) > 0 ? `${formatNum(rewards.locked.locked)} ANTS still locked` : null}
                claimable={hasLocked}
                busy={isBucketBusy('locked')}
                onClaim={claimLocked}
                canClaim={canClaim}
              />
            </div>

            {/* Recognized usage epoch breakdown */}
            {recognizedRows.length > 0 && (
              <>
                <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>Recognized Usage Epochs</h3>
                <div style={{ overflowX: 'auto', marginBottom: '2rem' }}>
                  <table className="table" style={{ minWidth: '700px' }}>
                    <thead>
                      <tr>
                        <th>Epoch</th>
                        <th>Seller Points</th>
                        <th>Seller ANTS</th>
                        <th>Seller Claim</th>
                        <th>Buyer Points</th>
                        <th>Buyer ANTS</th>
                        <th>Buyer Claim</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recognizedRows.map((row) => {
                        const sellerClaimable = !!row.seller && row.seller.amount > 0 && !row.seller.claimed;
                        const buyerClaimable = !!row.buyer && row.buyer.amount > 0 && !row.buyer.claimed;
                        return (
                          <tr key={row.epoch}>
                            <td>Epoch {row.epoch}</td>
                            <td>{row.seller ? formatNum(row.seller.points) : '—'}</td>
                            <td style={{ fontWeight: 600 }}>{row.seller && row.seller.amount > 0 ? row.seller.amount.toFixed(4) : '—'}</td>
                            <td>
                              {!row.seller ? '—' : row.seller.claimed ? (
                                <span className="status-badge offline" style={{ fontSize: '0.75rem' }}>Claimed</span>
                              ) : sellerClaimable && canClaim ? (
                                <button
                                  onClick={() => claimSellerUsage([row.epoch])}
                                  disabled={isBucketBusy('sellerUsage')}
                                  style={{
                                    display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
                                    padding: '0.25rem 0.625rem', borderRadius: '6px', border: 'none',
                                    background: 'var(--accent)', color: 'white', fontWeight: 600,
                                    cursor: isBucketBusy('sellerUsage') ? 'wait' : 'pointer',
                                    fontSize: '0.75rem', opacity: isBucketBusy('sellerUsage') ? 0.5 : 1,
                                  }}
                                >
                                  <Zap size={12} />
                                  Claim
                                </button>
                              ) : sellerClaimable && !canClaim ? (
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Connect wallet</span>
                              ) : (
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>—</span>
                              )}
                            </td>
                            <td>{row.buyer ? formatNum(row.buyer.points) : '—'}</td>
                            <td style={{ fontWeight: 600 }}>{row.buyer && row.buyer.amount > 0 ? row.buyer.amount.toFixed(4) : '—'}</td>
                            <td>
                              {!row.buyer ? '—' : row.buyer.claimed ? (
                                <span className="status-badge offline" style={{ fontSize: '0.75rem' }}>Claimed</span>
                              ) : buyerClaimable && canClaim && rewards?.buyerUsage?.claimable ? (
                                <button
                                  onClick={() => claimBuyerUsage([row.epoch])}
                                  disabled={isBucketBusy('buyerUsage')}
                                  style={{
                                    display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
                                    padding: '0.25rem 0.625rem', borderRadius: '6px', border: 'none',
                                    background: 'var(--accent)', color: 'white', fontWeight: 600,
                                    cursor: isBucketBusy('buyerUsage') ? 'wait' : 'pointer',
                                    fontSize: '0.75rem', opacity: isBucketBusy('buyerUsage') ? 0.5 : 1,
                                  }}
                                >
                                  <Zap size={12} />
                                  Claim
                                </button>
                              ) : buyerClaimable && !canClaim ? (
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Connect wallet</span>
                              ) : (
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* Buyer addresses (legacy buyer emissions tracked under signer wallets) */}
            {(isConnected || searchAddress) && (
              <div style={{ marginBottom: '1.5rem' }}>
                <div style={{ background: 'var(--bg-secondary)', padding: '1rem', borderRadius: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: buyerAddresses.length > 0 ? '0.5rem' : 0 }}>
                    <Wallet size={14} style={{ color: 'var(--accent)' }} />
                    <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>Buyer Addresses</span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>- signer wallets for legacy buyer points (Deposits operator mapping)</span>
                  </div>
                  {buyerAddresses.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginBottom: '0.5rem' }}>
                      {buyerAddresses.map((ba) => (
                        <span key={ba} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', background: 'var(--bg-primary)', padding: '0.25rem 0.5rem', borderRadius: '6px', fontSize: '0.75rem', fontFamily: 'monospace' }}>
                          {truncateAddress(ba)}
                          <button onClick={async () => {
                            const next = buyerAddresses.filter((a) => a !== ba);
                            setBuyerAddresses(next);
                            const op = displayAddress?.toLowerCase();
                            if (op) {
                              try { await fetch('/api/operator-buyers', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operator: op, buyer: ba.toLowerCase() }) }); } catch {}
                            }
                          }} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.75rem', padding: 0, lineHeight: 1 }}>&times;</button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '0.375rem' }}>
                    <input
                      type="text"
                      value={buyerAddressInput}
                      onChange={(e) => setBuyerAddressInput(e.target.value)}
                      placeholder="0x... add a buyer address"
                      style={{
                        flex: 1, background: 'var(--bg-primary)', border: '1px solid var(--border)',
                        borderRadius: '6px', padding: '0.375rem 0.625rem', color: 'var(--text-primary)',
                        fontFamily: 'monospace', fontSize: '0.75rem', outline: 'none',
                      }}
                      onKeyDown={async (e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const addr = buyerAddressInput.trim();
                          if (isValidAddress(addr) && !buyerAddresses.includes(addr)) {
                            setBuyerAddresses((prev) => [...prev, addr]);
                            setBuyerAddressInput('');
                            const op = displayAddress?.toLowerCase();
                            if (op) {
                              try { await fetch('/api/operator-buyers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operator: op, buyer: addr.toLowerCase() }) }); } catch {}
                            }
                          }
                        }
                      }}
                    />
                    <button
                      onClick={async () => {
                        const addr = buyerAddressInput.trim();
                        if (isValidAddress(addr) && !buyerAddresses.includes(addr)) {
                          setBuyerAddresses((prev) => [...prev, addr]);
                          setBuyerAddressInput('');
                          const op = displayAddress?.toLowerCase();
                          if (op) {
                            try { await fetch('/api/operator-buyers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operator: op, buyer: addr.toLowerCase() }) }); } catch {}
                          }
                        }
                      }}
                      disabled={!isValidAddress(buyerAddressInput.trim()) || buyerAddresses.includes(buyerAddressInput.trim())}
                      style={{
                        padding: '0.375rem 0.75rem', borderRadius: '6px', border: 'none',
                        background: isValidAddress(buyerAddressInput.trim()) && !buyerAddresses.includes(buyerAddressInput.trim()) ? 'var(--accent)' : 'var(--border)',
                        color: isValidAddress(buyerAddressInput.trim()) && !buyerAddresses.includes(buyerAddressInput.trim()) ? 'white' : 'var(--text-secondary)',
                        fontWeight: 600,
                        cursor: isValidAddress(buyerAddressInput.trim()) && !buyerAddresses.includes(buyerAddressInput.trim()) ? 'pointer' : 'not-allowed',
                        fontSize: '0.75rem', whiteSpace: 'nowrap',
                      }}
                    >
                      Add
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Legacy epoch breakdown */}
            <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>Legacy Epoch Breakdown</h3>
            {legacyPending?.epochs?.length > 0 ? (
              <div style={{ overflowX: 'auto' }}>
                <table className="table" style={{ minWidth: '700px' }}>
                  <thead>
                    <tr>
                      <th>Epoch</th>
                      <th>Buyer Points</th>
                      <th>Seller Points</th>
                      <th>ANTS</th>
                      <th>Buyer Claim</th>
                      <th>Seller Claim</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...legacyPending.epochs]
                      .reverse()
                      .map((e) => {
                        const totalAnts = (e.sellerReward || 0) + (e.buyerReward || 0);
                        const isCurrentEpoch = e.isCurrentEpoch;
                        const sellerClaimable = legacyEpochClaimable(e, 'seller');
                        const buyerClaimable = legacyEpochClaimable(e, 'buyer');

                        return (
                          <tr key={e.epoch}>
                            <td>
                              Epoch {e.epoch}
                              {isCurrentEpoch && <span style={{ color: 'var(--accent)', fontSize: '0.7rem', marginLeft: '0.375rem' }}>current</span>}
                            </td>
                            <td>{e.buyerPoints.toLocaleString()}</td>
                            <td>{e.sellerPoints.toLocaleString()}</td>
                            <td style={{ fontWeight: 600 }}>{totalAnts > 0 ? totalAnts.toFixed(4) : '—'}</td>
                            <td>
                              {isCurrentEpoch ? (
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>Ongoing</span>
                              ) : buyerClaimable && canClaim ? (
                                <button
                                  onClick={() => claimLegacyEpoch(e, 'buyer')}
                                  disabled={isBucketBusy('legacy')}
                                  style={{
                                    display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
                                    padding: '0.25rem 0.625rem', borderRadius: '6px', border: 'none',
                                    background: 'var(--accent)', color: 'white', fontWeight: 600,
                                    cursor: isBucketBusy('legacy') ? 'wait' : 'pointer',
                                    fontSize: '0.75rem', opacity: isBucketBusy('legacy') ? 0.5 : 1,
                                  }}
                                >
                                  <Zap size={12} />
                                  Claim
                                </button>
                              ) : buyerClaimable && !canClaim ? (
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Connect wallet</span>
                              ) : e.buyerClaimed ? (
                                <span className="status-badge offline" style={{ fontSize: '0.75rem' }}>Claimed</span>
                              ) : (
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>—</span>
                              )}
                            </td>
                            <td>
                              {isCurrentEpoch ? (
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>Ongoing</span>
                              ) : sellerClaimable && canClaim ? (
                                <button
                                  onClick={() => claimLegacyEpoch(e, 'seller')}
                                  disabled={isBucketBusy('legacy')}
                                  style={{
                                    display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
                                    padding: '0.25rem 0.625rem', borderRadius: '6px', border: 'none',
                                    background: 'var(--accent)', color: 'white', fontWeight: 600,
                                    cursor: isBucketBusy('legacy') ? 'wait' : 'pointer',
                                    fontSize: '0.75rem', opacity: isBucketBusy('legacy') ? 0.5 : 1,
                                  }}
                                >
                                  <Zap size={12} />
                                  Claim
                                </button>
                              ) : sellerClaimable && !canClaim ? (
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Connect wallet</span>
                              ) : e.sellerClaimed ? (
                                <span className="status-badge offline" style={{ fontSize: '0.75rem' }}>Claimed</span>
                              ) : (
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                No legacy emissions recorded for this address.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>
        {label}
      </div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: accent || 'var(--text-primary)' }}>{value}</div>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>{sub}</div>
    </div>
  );
}

function BucketCard({ title, icon, description, amount, detail, note, claimable, busy, onClaim, secondaryClaim, canClaim }) {
  return (
    <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>{icon}</span>
        <span style={{ fontSize: '1rem', fontWeight: 700 }}>{title}</span>
      </div>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{description}</div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: amount > 0 ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
        {formatNumCard(amount)}
        <span style={{ fontSize: '0.75rem', fontWeight: 400, color: 'var(--text-secondary)', marginLeft: '0.25rem' }}>ANTS</span>
      </div>
      {detail && <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{detail}</div>}
      {note && (
        <div style={{ fontSize: '0.75rem', color: 'var(--warning)' }}>{note}</div>
      )}
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: 'auto', paddingTop: '0.25rem' }}>
        {claimable ? (
          <button
            onClick={onClaim}
            disabled={busy}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.375rem',
              padding: '0.5rem 1rem', borderRadius: '8px', border: 'none',
              background: 'var(--accent)', color: 'white', fontWeight: 600,
              cursor: busy ? 'wait' : 'pointer', fontSize: '0.8125rem',
              opacity: busy ? 0.7 : 1,
            }}
          >
            {busy ? <Loader2 size={14} className="spin" /> : <Zap size={14} />}
            {busy ? 'Working…' : 'Claim'}
          </button>
        ) : (
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', alignSelf: 'center' }}>
            {amount > 0 ? (canClaim ? 'Nothing new to claim' : 'Connect wallet to claim') : 'Nothing to claim'}
          </span>
        )}
        {secondaryClaim && (
          <button
            onClick={secondaryClaim.onClick}
            disabled={busy}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.375rem',
              padding: '0.5rem 1rem', borderRadius: '8px', border: 'none',
              background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontWeight: 600,
              cursor: busy ? 'wait' : 'pointer', fontSize: '0.8125rem',
              opacity: busy ? 0.7 : 1,
            }}
          >
            {secondaryClaim.label}
          </button>
        )}
      </div>
    </div>
  );
}

function formatNumCard(n) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(2) + 'K';
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export default ClaimANTS;
