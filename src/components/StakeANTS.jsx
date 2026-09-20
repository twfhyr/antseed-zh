import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  useAccount,
  useWriteContract,
  usePublicClient,
  useWalletClient,
} from 'wagmi';
import {
  Layers,
  Loader2,
  AlertCircle,
  CheckCircle,
  ExternalLink,
  Zap,
  Search,
  Wallet,
  TrendingUp,
  Users,
} from 'lucide-react';
import { fetchRewards, fetchSellers, fetchLantsMarket } from '../api';
import { useI18n } from '../i18n/index.jsx';
import { createAndPostListing, fulfillListing, isProviderActivationStake } from '../lib/listLants';

// ─── ABIs (Base mainnet, recognized-usage era) — same contracts ClaimANTS.jsx
// uses; only the functions this component actually calls are declared. ───
const USAGE_REWARDS_ABI = [
  {
    name: 'claimBuyerReward', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'buyer', type: 'address' }, { name: 'epoch', type: 'uint256' }], outputs: [],
  },
  {
    name: 'stakeBuyerReward', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'buyer', type: 'address' }, { name: 'epoch', type: 'uint256' },
      { name: 'stakeAgentId', type: 'uint256' }, { name: 'stakeEpochs', type: 'uint256' },
    ],
    outputs: [{ name: 'newPositionId', type: 'uint256' }],
  },
  {
    // Seller-side restake — always into the caller's OWN agent pool
    // (`_prepareAgentReward` checks msg.sender is authorized for `agentId`
    // on-chain), unlike stakeBuyerReward's arbitrary stakeAgentId — so this
    // has no destination picker, just a lock-length one.
    name: 'stakeAgentReward', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' }, { name: 'epoch', type: 'uint256' },
      { name: 'stakeEpochs', type: 'uint256' },
    ],
    outputs: [{ name: 'newPositionId', type: 'uint256' }],
  },
];
const USAGE_ACCOUNTING_ABI = [
  {
    name: 'claimSellerEmissions', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'epochs', type: 'uint256[]' }], outputs: [],
  },
];
const SELLER_POOLS_ABI = [
  { name: 'minStakeEpochs', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'MAX_STAKE_EPOCHS', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  {
    name: 'stakerPositionCount', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'staker', type: 'address' }], outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'stakerPositionIds', type: 'function', stateMutability: 'view',
    inputs: [
      { name: 'staker', type: 'address' },
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256[]' }],
  },
  {
    name: 'positions', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'positionId', type: 'uint256' }],
    outputs: [
      { name: 'owner', type: 'address' },
      { name: 'agentId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
      { name: 'weightAmount', type: 'uint256' },
      { name: 'stakeStartEpoch', type: 'uint64' },
      { name: 'stakeEndEpoch', type: 'uint64' },
      { name: 'closedAtEpoch', type: 'uint64' },
      { name: 'withdrawn', type: 'bool' },
    ],
  },
];

const isValidAddress = (addr) => /^0x[a-fA-F0-9]{40}$/.test(addr);
const truncateAddress = (addr) => (addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '');
const formatNum = (n) => {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(2) + 'K';
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
};
const formatAnts = (n) => {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
};
const toNumber = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};
const weiToAnts = (wei) => {
  if (wei === undefined || wei === null) return null;
  try {
    return Number(wei) / 1e18;
  } catch {
    return null;
  }
};
const formatUsd = (n) => {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (abs >= 0.01) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  return `$${n.toPrecision(3)}`;
};
const formatListing = (listing) => {
  if (!listing) return '—';
  if (listing.usd != null) return formatUsd(listing.usd);
  if (listing.unit != null && listing.symbol) {
    return `${listing.unit.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${listing.symbol}`;
  }
  return '—';
};

function sellerForAgent(sellers, agentId) {
  if (agentId == null) return null;
  const id = String(agentId);
  return sellers.find((s) => s.agentId != null && String(s.agentId) === id) || null;
}

function positionState(p, currentEpoch) {
  if (p.withdrawn) return 'withdrawn';
  if (p.closedAtEpoch) return 'closed';
  if (currentEpoch == null) return null;
  if (currentEpoch < p.stakeStartEpoch) return 'pending';
  if (currentEpoch < p.stakeEndEpoch) return 'active';
  return 'matured';
}

function unpackPosition(id, result) {
  if (!result) return null;
  const owner = result.owner ?? result[0];
  const agentId = toNumber(result.agentId ?? result[1]);
  const amount = weiToAnts(result.amount ?? result[2]);
  const weightAmount = weiToAnts(result.weightAmount ?? result[3]);
  const stakeStartEpoch = toNumber(result.stakeStartEpoch ?? result[4]);
  const stakeEndEpoch = toNumber(result.stakeEndEpoch ?? result[5]);
  const closedAtEpoch = toNumber(result.closedAtEpoch ?? result[6]);
  const withdrawn = !!(result.withdrawn ?? result[7]);
  if (agentId == null || stakeStartEpoch == null || stakeEndEpoch == null) return null;
  return {
    id,
    owner,
    agentId,
    amount,
    weightAmount,
    stakeStartEpoch,
    stakeEndEpoch,
    closedAtEpoch: closedAtEpoch || 0,
    withdrawn,
  };
}

async function readLantsPositions(publicClient, poolsAddress, owner) {
  const count = toNumber(await publicClient.readContract({
    address: poolsAddress,
    abi: SELLER_POOLS_ABI,
    functionName: 'stakerPositionCount',
    args: [owner],
  }));
  if (!count) return [];
  const ids = [];
  for (let offset = 0; offset < count; offset += 256) {
    const page = await publicClient.readContract({
      address: poolsAddress,
      abi: SELLER_POOLS_ABI,
      functionName: 'stakerPositionIds',
      args: [owner, offset, 256],
    });
    ids.push(...(page || []).map((x) => Number(x)));
  }
  if (ids.length === 0) return [];
  const results = await publicClient.multicall({
    contracts: ids.map((id) => ({
      address: poolsAddress,
      abi: SELLER_POOLS_ABI,
      functionName: 'positions',
      args: [id],
    })),
    allowFailure: true,
  });
  return ids
    .map((id, i) => {
      const row = results[i];
      const result = row && typeof row === 'object' && 'status' in row
        ? (row.status === 'success' ? row.result : null)
        : row;
      if (!result) return null;
      return unpackPosition(id, result);
    })
    .filter((p) => p && !p.withdrawn && !p.closedAtEpoch);
}

function StakeANTS() {
  const { t, lang } = useI18n();
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { writeContractAsync } = useWriteContract();

  const [rewards, setRewards] = useState(null);
  const [sellers, setSellers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [stakeBounds, setStakeBounds] = useState({ min: 1, max: 104 });
  const [positions, setPositions] = useState(null);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [positionsError, setPositionsError] = useState(false);
  const [market, setMarket] = useState(null);
  const [marketLoading, setMarketLoading] = useState(true);
  const [marketError, setMarketError] = useState(false);
  const [marketTab, setMarketTab] = useState('listed'); // 'listed' | 'all' | 'mine'
  const [marketPage, setMarketPage] = useState(1);
  const [marketSort, setMarketSort] = useState('id');
  const [marketFilters, setMarketFilters] = useState({ agentId: '', minAmount: '', maxAmount: '', minLockDays: '', maxLockDays: '' });
  const [filterDraft, setFilterDraft] = useState(marketFilters);
  const MARKET_PAGE_SIZE = 10;
  const [listForm, setListForm] = useState(null); // { id, price, days, phase, message }
  const [buyState, setBuyState] = useState(null); // { id, phase, message }

  const [searchInput, setSearchInput] = useState('');
  const [searchAddress, setSearchAddress] = useState(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(null);

  // { key: `${side}-${epoch}`, agentId, lockEpochs }
  const [openStake, setOpenStake] = useState(null);
  const [status, setStatus] = useState(null); // { key, phase, message, hash }

  const displayAddress = isConnected ? address : searchAddress;
  const isLoading = isConnected ? loading : searchLoading;
  const canAct = isConnected && !!address && !!displayAddress
    && address.toLowerCase() === displayAddress.toLowerCase();

  const loadPositions = useCallback(async (addr, poolsAddress) => {
    setPositionsError(false);
    if (!addr || !poolsAddress || !publicClient) {
      setPositions([]);
      if (addr && !publicClient) setPositionsError(true);
      return;
    }
    setPositionsLoading(true);
    try {
      const rows = await readLantsPositions(publicClient, poolsAddress, addr);
      setPositions(rows);
    } catch (e) {
      console.error('Failed to load lANTS positions:', e);
      setPositions([]);
      setPositionsError(true);
    } finally {
      setPositionsLoading(false);
    }
  }, [publicClient]);

  const loadData = useCallback(async (addr, bustCache = false) => {
    setLoading(true);
    setPositions(null);
    try {
      const [rewardsData, sellersData] = await Promise.all([
        fetchRewards(addr, bustCache),
        fetchSellers(),
      ]);
      setRewards(rewardsData);
      setSellers(sellersData.filter((s) => s.agentId));
      const poolsAddress = rewardsData?.contracts?.sellerPools;
      if (poolsAddress && publicClient) {
        try {
          const [min, max] = await Promise.all([
            publicClient.readContract({ address: poolsAddress, abi: SELLER_POOLS_ABI, functionName: 'minStakeEpochs' }),
            publicClient.readContract({ address: poolsAddress, abi: SELLER_POOLS_ABI, functionName: 'MAX_STAKE_EPOCHS' }),
          ]);
          setStakeBounds({ min: Number(min) || 1, max: Number(max) || 104 });
        } catch {
          // Keep the 1..104 default (network defaults observed 2026-09) if the read fails.
        }
      }
      await loadPositions(addr, poolsAddress);
    } catch (e) {
      console.error('Failed to load stake data:', e);
      setPositions([]);
      setPositionsError(true);
    } finally {
      setLoading(false);
    }
  }, [publicClient, loadPositions]);

  useEffect(() => {
    if (!isConnected || !address) {
      setRewards(null);
      setPositions(null);
      return;
    }
    loadData(address);
  }, [isConnected, address, loadData]);

  const marketQuery = useMemo(() => ({
    page: marketPage,
    pageSize: MARKET_PAGE_SIZE,
    sort: marketSort,
    listed: marketTab === 'listed' ? '1' : undefined,
    owner: marketTab === 'mine' ? address : undefined,
    agentId: marketFilters.agentId || undefined,
    minAmount: marketFilters.minAmount || undefined,
    maxAmount: marketFilters.maxAmount || undefined,
    minLockDays: marketFilters.minLockDays || undefined,
    maxLockDays: marketFilters.maxLockDays || undefined,
  }), [marketPage, marketSort, marketTab, address, marketFilters]);

  useEffect(() => {
    if (marketTab === 'mine' && !address) return;
    let cancelled = false;
    setMarketLoading(true);
    setMarketError(false);
    fetchLantsMarket(marketQuery)
      .then((data) => {
        if (cancelled) return;
        setMarket(data);
        if (marketTab === 'listed' && (data?.listedCount || 0) === 0) setMarketTab('all');
      })
      .catch((e) => {
        console.error('Failed to load lANTS market:', e);
        if (!cancelled) {
          setMarket(null);
          setMarketError(true);
        }
      })
      .finally(() => { if (!cancelled) setMarketLoading(false); });
    return () => { cancelled = true; };
  }, [marketQuery, marketTab, address]);

  // Any filter/tab/sort change should snap back to page 1 -- otherwise a
  // narrower result set can leave the view on a now-empty page.
  const resetToFirstPage = (fn) => (...args) => { setMarketPage(1); fn(...args); };
  const setMarketTabAndReset = resetToFirstPage(setMarketTab);
  const setMarketSortAndReset = resetToFirstPage(setMarketSort);
  const setMarketFiltersAndReset = resetToFirstPage(setMarketFilters);

  const handleSearch = async (e) => {
    e?.preventDefault();
    const addr = searchInput.trim();
    if (!isValidAddress(addr)) {
      setSearchError(t('stake.invalidAddress'));
      return;
    }
    setSearchError(null);
    setSearchAddress(addr);
    setSearchLoading(true);
    await loadData(addr, true);
    setSearchLoading(false);
  };

  const buyerRows = useMemo(
    () => (rewards?.buyerUsage?.epochs || []).filter((e) => e.amount > 0 && !e.claimed).sort((a, b) => b.epoch - a.epoch),
    [rewards]
  );
  const sellerRows = useMemo(
    () => (rewards?.sellerUsage?.epochs || []).filter((e) => e.amount > 0 && !e.claimed).sort((a, b) => b.epoch - a.epoch),
    [rewards]
  );
  // Filtering, sorting, pagination, and activation-stake exclusion all
  // happen server-side now (backend/server.js paginateMarketItems) -- this
  // is already exactly the page to show.
  const marketItems = market?.items || [];

  const doList = async (position) => {
    const contract = market?.contract || rewards?.contracts?.sellerPools;
    if (!walletClient || !address || !contract) {
      setListForm((f) => ({ ...(f || { id: position.id, price: '', days: 30 }), phase: 'error', message: t('stake.listNeedWallet') }));
      return;
    }
    const price = Number(listForm?.price);
    if (!(price > 0)) {
      setListForm((f) => ({ ...f, phase: 'error', message: t('stake.listPrice') }));
      return;
    }
    try {
      setListForm((f) => ({ ...f, phase: 'listing', message: t('stake.listing') }));
      await createAndPostListing({
        walletClient,
        account: address,
        contract,
        tokenId: position.id,
        priceEth: price,
        durationDays: listForm?.days || 30,
      });
      setListForm({ id: position.id, price: String(price), days: listForm?.days || 30, phase: 'done', message: t('stake.listedOk') });
      fetchLantsMarket({ ...marketQuery, wait: '1' }).then(setMarket).catch(() => {});
    } catch (e) {
      setListForm((f) => ({ ...f, phase: 'error', message: e.shortMessage || e.message }));
    }
  };

  const doBuy = async (position) => {
    if (!walletClient || !address) {
      setBuyState({ id: position.id, phase: 'error', message: t('stake.buyNeedWallet') });
      return;
    }
    try {
      setBuyState({ id: position.id, phase: 'buying', message: t('stake.buying') });
      await fulfillListing({ walletClient, account: address, tokenId: position.id });
      setBuyState({ id: position.id, phase: 'done', message: t('stake.boughtOk') });
      fetchLantsMarket({ ...marketQuery, wait: '1' }).then(setMarket).catch(() => {});
    } catch (e) {
      setBuyState({ id: position.id, phase: 'error', message: e.shortMessage || e.message });
    }
  };

  const sendTx = async (request) => {
    const hash = await writeContractAsync(request);
    if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  };

  const rowKey = (side, epoch) => `${side}-${epoch}`;

  const doClaim = async (side, epoch) => {
    const key = rowKey(side, epoch);
    const r = rewards;
    try {
      setStatus({ key, phase: 'claiming', message: t('stake.claiming', { epoch }) });
      const hash = side === 'buyer'
        ? await sendTx({ address: r.contracts.usageRewards, abi: USAGE_REWARDS_ABI, functionName: 'claimBuyerReward', args: [displayAddress, epoch] })
        : await sendTx({ address: r.contracts.usageAccounting, abi: USAGE_ACCOUNTING_ABI, functionName: 'claimSellerEmissions', args: [[epoch]] });
      setStatus({ key, phase: 'done', message: t('stake.claimed', { epoch }), hash });
      loadData(displayAddress, true);
    } catch (e) {
      setStatus({ key, phase: 'error', message: e.shortMessage || e.message });
    }
  };

  const doStake = async (side, epoch) => {
    const key = rowKey(side, epoch);
    const r = rewards;
    const lockEpochs = openStake?.lockEpochs ?? stakeBounds.max;
    try {
      if (side === 'buyer') {
        const stakeAgentId = openStake?.agentId;
        if (!stakeAgentId) { setStatus({ key, phase: 'error', message: t('stake.pickProvider') }); return; }
        setStatus({ key, phase: 'staking', message: t('stake.stakingBuyer', { epoch, agent: stakeAgentId, lock: lockEpochs }) });
        const hash = await sendTx({ address: r.contracts.usageRewards, abi: USAGE_REWARDS_ABI, functionName: 'stakeBuyerReward', args: [displayAddress, epoch, stakeAgentId, lockEpochs] });
        setStatus({ key, phase: 'done', message: t('stake.stakedBuyer', { epoch, agent: stakeAgentId, lock: lockEpochs }), hash });
      } else {
        setStatus({ key, phase: 'staking', message: t('stake.stakingSeller', { epoch, lock: lockEpochs }) });
        const hash = await sendTx({ address: r.contracts.usageRewards, abi: USAGE_REWARDS_ABI, functionName: 'stakeAgentReward', args: [r.agentId, epoch, lockEpochs] });
        setStatus({ key, phase: 'done', message: t('stake.stakedSeller', { epoch, lock: lockEpochs }), hash });
      }
      setOpenStake(null);
      loadData(displayAddress, true);
    } catch (e) {
      setStatus({ key, phase: 'error', message: e.shortMessage || e.message });
    }
  };

  const isRowBusy = (side, epoch) => {
    const s = status;
    return !!s && s.key === rowKey(side, epoch) && s.phase !== 'done' && s.phase !== 'error';
  };

  const effectiveEpoch = rewards?.effectiveEpoch;
  const currentEpoch = rewards?.currentEpoch;
  const totalUnclaimed = buyerRows.reduce((s, e) => s + e.amount, 0) + sellerRows.reduce((s, e) => s + e.amount, 0);
  const totalStaked = (positions || []).reduce((s, p) => s + (p.amount || 0), 0);
  const poolsAddress = rewards?.contracts?.sellerPools || market?.contract;

  return (
    <div className="table-container" style={{ padding: '2rem' }}>
      <div style={{ maxWidth: '960px' }}>
        <div style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Layers size={24} style={{ color: 'var(--accent)' }} />
            {t('stake.title')}
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
            {t('stake.blurb')}
          </p>
        </div>

        <div style={{ marginBottom: '2.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
            <h3 style={{ fontSize: '1.125rem', fontWeight: 600 }}>{t('stake.marketTitle')}</h3>
            {market?.collectionUrl && (
              <a href={market.collectionUrl} target="_blank" rel="noopener noreferrer"
                style={{ color: 'var(--info)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.8125rem' }}>
                {t('stake.collectionLink')}
                <ExternalLink size={12} />
              </a>
            )}
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1rem' }}>
            {t('stake.marketBlurb')}
          </p>

          {marketLoading && (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
              <Loader2 size={24} className="spin" />
              <p style={{ marginTop: '0.75rem', fontSize: '0.875rem' }}>{t('stake.marketLoading')}</p>
            </div>
          )}
          {marketError && !marketLoading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--warning)', fontSize: '0.875rem' }}>
              <AlertCircle size={14} />
              <span>{t('stake.marketError')}</span>
            </div>
          )}
          {!marketLoading && market && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginBottom: '1rem' }}>
                <StatCard
                  label={t('stake.floorPerAnt')}
                  value={formatUsd(market.floorPerAntUsd)}
                  sub={market.floorTokenId != null ? `#${market.floorTokenId}` : ''}
                  accent="var(--clay)"
                />
                <StatCard label={t('stake.listed')} value={market.listedCount ?? '—'} sub="" />
                <StatCard label={t('stake.collectionNfts')} value={market.totalNfts ?? '—'} sub="" />
              </div>
              {market.activationHidden > 0 && (
                <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                  {t('stake.activationHidden', { n: market.activationHidden })}
                </div>
              )}
              {market.listedCount === 0 && (
                <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
                  {t('stake.noneListed')}
                </div>
              )}
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                <FilterChip active={marketTab === 'listed'} onClick={() => setMarketTabAndReset('listed')} label={t('stake.filterListed')} />
                <FilterChip active={marketTab === 'all'} onClick={() => setMarketTabAndReset('all')} label={t('stake.filterAll')} />
                {isConnected && address && (
                  <FilterChip active={marketTab === 'mine'} onClick={() => setMarketTabAndReset('mine')} label={t('stake.filterMine')} />
                )}
              </div>

              <div className="lants-filters">
                <label>
                  {t('stake.filterSeller')}
                  <select
                    value={filterDraft.agentId}
                    onChange={(e) => setFilterDraft({ ...filterDraft, agentId: e.target.value })}
                  >
                    <option value="">{t('stake.filterAnySeller')}</option>
                    {(market.sellers || []).map((s) => (
                      <option key={s.agentId} value={s.agentId}>{s.name || t('stake.agent', { id: s.agentId })}</option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('stake.filterAmount')}
                  <div className="lants-filters__range">
                    <input type="number" min="0" placeholder={t('stake.min')} value={filterDraft.minAmount}
                      onChange={(e) => setFilterDraft({ ...filterDraft, minAmount: e.target.value })} />
                    <input type="number" min="0" placeholder={t('stake.max')} value={filterDraft.maxAmount}
                      onChange={(e) => setFilterDraft({ ...filterDraft, maxAmount: e.target.value })} />
                  </div>
                </label>
                <label>
                  {t('stake.filterLockDays')}
                  <div className="lants-filters__range">
                    <input type="number" min="0" placeholder={t('stake.min')} value={filterDraft.minLockDays}
                      onChange={(e) => setFilterDraft({ ...filterDraft, minLockDays: e.target.value })} />
                    <input type="number" min="0" placeholder={t('stake.max')} value={filterDraft.maxLockDays}
                      onChange={(e) => setFilterDraft({ ...filterDraft, maxLockDays: e.target.value })} />
                  </div>
                </label>
                <label>
                  {t('stake.sortBy')}
                  <select value={marketSort} onChange={(e) => setMarketSortAndReset(e.target.value)}>
                    <option value="id">{t('stake.sortId')}</option>
                    <option value="amount">{t('stake.sortAmount')}</option>
                    <option value="lockDays">{t('stake.sortLockDays')}</option>
                    <option value="daysRemaining">{t('stake.sortRemaining')}</option>
                    <option value="price">{t('stake.sortPrice')}</option>
                  </select>
                </label>
                <button type="button" className="lants-filters__apply" onClick={() => setMarketFiltersAndReset(filterDraft)}>
                  {t('stake.filterApply')}
                </button>
              </div>

              {marketItems.length === 0 && (
                <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', margin: '1rem 0' }}>
                  {marketTab === 'mine' ? t('stake.mineEmpty') : t('stake.noneMatch')}
                </div>
              )}
              {marketItems.length > 0 && (
                <div className="lants-nft-grid">
                  {marketItems.map((p) => (
                    <LantsNftCard
                      key={`m-${p.id}`}
                      position={p}
                      seller={p.sellerName ? { name: p.sellerName } : sellerForAgent(sellers, p.agentId)}
                      currentEpoch={market.currentEpoch ?? currentEpoch}
                      genesis={market.genesis}
                      epochDuration={market.epochDuration}
                      poolsAddress={poolsAddress}
                      t={t}
                      lang={lang}
                      listing={p.listing}
                      openseaUrl={p.openseaUrl}
                      listForm={listForm}
                      setListForm={setListForm}
                      onList={() => doList(p)}
                      canList={!!(isConnected && address && p.owner && address.toLowerCase() === p.owner.toLowerCase() && !p.listed && !isProviderActivationStake(p.amount))}
                      onBuy={() => doBuy(p)}
                      canBuy={!!(isConnected && address && p.owner && address.toLowerCase() !== p.owner.toLowerCase() && p.listed && p.fulfillableHere)}
                      buyState={buyState?.id === p.id ? buyState : null}
                    />
                  ))}
                </div>
              )}
              {market.total > MARKET_PAGE_SIZE && (
                <MarketPager
                  page={marketPage}
                  pageSize={MARKET_PAGE_SIZE}
                  total={market.total}
                  onChange={setMarketPage}
                  t={t}
                />
              )}
            </>
          )}
        </div>

        <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '0.75rem' }}>{t('stake.positions')}</h3>

        {!isConnected && (
          <div style={{ marginBottom: '2rem', background: 'var(--bg-secondary)', padding: '1.5rem', borderRadius: '12px' }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Search size={16} style={{ color: 'var(--accent)' }} />
              {t('stake.lookup')}
            </h3>
            <form onSubmit={handleSearch} style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                type="text" value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
                placeholder={t('stake.placeholder')}
                style={{ flex: 1, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.5rem 0.75rem', color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: '0.875rem', outline: 'none' }}
              />
              <button type="submit" disabled={searchLoading}
                style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1rem', borderRadius: '8px', border: 'none', background: 'var(--accent)', color: 'white', fontWeight: 600, cursor: searchLoading ? 'wait' : 'pointer', fontSize: '0.875rem', whiteSpace: 'nowrap', opacity: searchLoading ? 0.7 : 1 }}>
                {searchLoading ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
                {t('stake.search')}
              </button>
            </form>
            {searchError && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.75rem', color: 'var(--danger)', fontSize: '0.875rem' }}>
                <AlertCircle size={14} /><span>{searchError}</span>
              </div>
            )}
          </div>
        )}

        {!isConnected && !searchAddress && !searchLoading && (
          <div style={{ textAlign: 'center', padding: '3rem 2rem', color: 'var(--text-secondary)' }}>
            <Wallet size={48} style={{ marginBottom: '1rem', opacity: 0.5 }} />
            <p>{t('stake.connectPrompt')}</p>
          </div>
        )}

        {isLoading && (
          <div style={{ textAlign: 'center', padding: '3rem 2rem', color: 'var(--text-secondary)' }}>
            <Loader2 size={32} className="spin" />
            <p style={{ marginTop: '1rem' }}>{t('stake.loading')}</p>
          </div>
        )}

        {(isConnected || searchAddress) && !isLoading && rewards && (
          <>
            <div style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--text-secondary)' }}>{t('stake.viewing')}:</span>
              <a href={`https://basescan.org/address/${displayAddress}`} target="_blank" rel="noopener noreferrer"
                style={{ color: 'var(--info)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.25rem', fontFamily: 'monospace' }}>
                {displayAddress}<ExternalLink size={12} />
              </a>
              {!isConnected && searchAddress && <span style={{ color: 'var(--text-secondary)' }}>{t('stake.readonly')}</span>}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
              <StatCard
                label={t('stake.positions')}
                value={positionsError ? '—' : (positions == null || positionsLoading ? '…' : positions.length)}
                sub={positionsLoading ? t('stake.loadingPositions') : ''}
              />
              <StatCard
                label={t('stake.totalStaked')}
                value={positionsError ? '—' : (positions == null || positionsLoading ? '…' : formatAnts(totalStaked))}
                sub="ANTS"
                accent="var(--clay)"
              />
              <StatCard label={t('stake.currentEpoch')} value={currentEpoch ?? '—'} sub="" />
            </div>

            {positionsError && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', color: 'var(--warning)', fontSize: '0.875rem' }}>
                <AlertCircle size={14} />
                <span>{t('stake.positionsError')}</span>
              </div>
            )}

            {positionsLoading && (
              <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                <Loader2 size={24} className="spin" />
                <p style={{ marginTop: '0.75rem', fontSize: '0.875rem' }}>{t('stake.loadingPositions')}</p>
              </div>
            )}

            {!positionsLoading && !positionsError && positions && positions.length === 0 && (
              <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                {t('stake.noPositions')}
              </div>
            )}

            {!positionsLoading && positions && positions.length > 0 && (
              <div className="lants-nft-grid">
                {positions.map((p) => (
                  <LantsNftCard
                    key={p.id}
                    position={p}
                    seller={sellerForAgent(sellers, p.agentId)}
                    currentEpoch={currentEpoch}
                    genesis={market?.genesis}
                    epochDuration={market?.epochDuration}
                    poolsAddress={poolsAddress}
                    t={t}
                    lang={lang}
                    openseaUrl={poolsAddress ? `https://opensea.io/item/base/${poolsAddress}/${p.id}` : null}
                    listForm={listForm}
                    setListForm={setListForm}
                    onList={() => doList(p)}
                    canList={!!(canAct && !isProviderActivationStake(p.amount))}
                    activation={isProviderActivationStake(p.amount)}
                  />
                ))}
              </div>
            )}

            <div style={{ marginTop: '2.5rem', marginBottom: '1.5rem' }}>
              <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '0.5rem' }}>{t('stake.rewardsTitle')}</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                {t('stake.rewardsBlurb', { epoch: effectiveEpoch ?? '—' })}
              </p>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
              <StatCard
                label={t('stake.unclaimedSince')}
                value={effectiveEpoch ?? '—'}
                sub={t('stake.epochsWithRewards', { n: buyerRows.length + sellerRows.length })}
              />
              <StatCard label={t('stake.totalUnclaimed')} value={formatNum(totalUnclaimed)} sub="ANTS" accent="var(--accent)" />
            </div>

            {buyerRows.length === 0 && sellerRows.length === 0 && (
              <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                {t('stake.noUnclaimed', { epoch: effectiveEpoch ?? '—' })}
              </div>
            )}

            {buyerRows.length > 0 && (
              <RewardTable
                title={t('stake.buyerRewards')} icon={<Users size={16} />} side="buyer" rows={buyerRows}
                canAct={canAct} canClaim={canAct && rewards.buyerUsage?.claimable}
                claimNote={!rewards.buyerUsage?.claimable && rewards.buyerUsage?.recipient ? t('stake.paidToOperator', { addr: truncateAddress(rewards.buyerUsage.recipient) }) : null}
                sellers={sellers} stakeBounds={stakeBounds}
                openStake={openStake} setOpenStake={setOpenStake}
                status={status} isRowBusy={isRowBusy} doClaim={doClaim} doStake={doStake}
                t={t}
              />
            )}

            {sellerRows.length > 0 && (
              <RewardTable
                title={t('stake.sellerRewards')} icon={<TrendingUp size={16} />} side="seller" rows={sellerRows}
                canAct={canAct} canClaim={canAct && rewards.sellerUsage?.claimable}
                claimNote={rewards.agentId === 0 ? t('stake.needsAgent') : null}
                sellers={sellers} stakeBounds={stakeBounds}
                openStake={openStake} setOpenStake={setOpenStake}
                status={status} isRowBusy={isRowBusy} doClaim={doClaim} doStake={doStake}
                agentId={rewards.agentId}
                t={t}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function LantsNftCard({ position: p, seller, currentEpoch, genesis, epochDuration, t, lang, listing, openseaUrl, listForm, setListForm, onList, canList, onBuy, canBuy, buyState, activation }) {
  const sellerName = seller?.name || (p.agentId != null ? t('stake.agent', { id: p.agentId }) : '—');
  const state = (p.stakeStartEpoch != null && p.stakeEndEpoch != null) ? positionState(p, currentEpoch) : null;
  const dates = epochDates(p.stakeStartEpoch, p.stakeEndEpoch, genesis, epochDuration);
  const lockDays = p.lockDays ?? dates.lockDays;
  const daysRemaining = p.daysRemaining ?? dates.daysRemaining;
  const startDate = p.startDate ?? dates.startDate;
  const endDate = p.endDate ?? dates.endDate;
  const sea = openseaUrl || (poolsAddress ? `https://opensea.io/item/base/${poolsAddress}/${p.id}` : null);
  const perAnt = listing?.perAntUsd != null
    ? t('stake.perAnt', { price: formatUsd(listing.perAntUsd) })
    : null;
  const open = listForm?.id === p.id;
  const listingBusy = open && listForm?.phase === 'listing';

  return (
    <figure className="lants-nft">
      <LantsNftArt
        position={p}
        sellerName={sellerName}
        state={state}
        lockDays={lockDays}
        daysRemaining={daysRemaining}
        startDate={startDate}
        endDate={endDate}
        t={t}
        lang={lang}
        listingLabel={listing ? formatListing(listing) : null}
      />
      <figcaption className="lants-nft__caption">
        {listing && (
          <div className="lants-nft__price">
            <span>{t('stake.listedPrice')}: {formatListing(listing)}</span>
            {perAnt && <span>{perAnt}</span>}
          </div>
        )}
        {activation && (
          <div style={{ color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>{t('stake.activationStake')}</div>
        )}
        <div className="lants-nft__links">
          {canList && setListForm && (
            <button
              type="button"
              className="lants-nft__listbtn"
              onClick={() => setListForm(open ? null : { id: p.id, price: '', days: 30, phase: null, message: null })}
            >
              {t('stake.listOnSite')}
            </button>
          )}
          {canBuy && onBuy && (
            <button
              type="button"
              className="lants-nft__listbtn"
              onClick={onBuy}
              disabled={buyState?.phase === 'buying'}
            >
              {buyState?.phase === 'buying' ? <Loader2 size={12} className="spin" /> : null}
              {t('stake.buyOnSite')}
            </button>
          )}
          {sea && (
            <a href={sea} target="_blank" rel="noopener noreferrer">
              {listing ? t('stake.buyOnOpensea') : t('stake.sellOnOpensea')}
              <ExternalLink size={11} />
            </a>
          )}
        </div>
        {buyState?.message && (
          <div style={{ color: buyState.phase === 'error' ? 'var(--danger)' : 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.25rem' }}>
            {buyState.message}
          </div>
        )}
        {open && canList && (
          <div className="lants-nft__listform">
            <label>
              {t('stake.listPrice')}
              <input
                type="number" min="0" step="0.0001"
                value={listForm.price}
                onChange={(e) => setListForm({ ...listForm, price: e.target.value, phase: null })}
              />
            </label>
            <label>
              {t('stake.listDays')}
              <input
                type="number" min="1" max="365"
                value={listForm.days}
                onChange={(e) => setListForm({ ...listForm, days: Number(e.target.value) || 30, phase: null })}
              />
            </label>
            <button type="button" onClick={onList} disabled={listingBusy}>
              {listingBusy ? <Loader2 size={12} className="spin" /> : null}
              {t('stake.listConfirm')}
            </button>
            <button type="button" onClick={() => setListForm(null)}>{t('stake.listCancel')}</button>
            {listForm.message && (
              <div style={{ color: listForm.phase === 'error' ? 'var(--danger)' : 'var(--text-secondary)', gridColumn: '1 / -1' }}>
                {listForm.message}
              </div>
            )}
          </div>
        )}
      </figcaption>
    </figure>
  );
}

const localeForLang = (lang) => (lang === 'en' ? 'en-US' : 'zh-CN');
const dateFmt = (d, lang) => (d ? new Date(d).toLocaleDateString(localeForLang(lang), { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

/** Uniswap-V3-style position NFT: unique blobs per id, items printed on the card. */
function LantsNftArt({ position: p, sellerName, state, lockDays, daysRemaining, startDate, endDate, t, lang, listingLabel }) {
  const uid = `lants-${p.id}`;
  const palette = nftPalette(p.agentId, p.id);
  const name = fitName(sellerName, 18);
  const stateLabel = state ? t(`stake.state.${state}`) : '—';
  const remainingLabel = daysRemaining == null
    ? '—'
    : daysRemaining === 0
      ? t('stake.unlocked')
      : t('stake.daysLeft', { n: daysRemaining });

  return (
    <svg
      className="lants-nft__svg"
      viewBox="0 0 290 470"
      role="img"
      aria-label={t('stake.nftAlt', { id: p.id })}
    >
      <defs>
        <clipPath id={`${uid}-clip`}>
          <rect width="290" height="470" rx="42" ry="42" />
        </clipPath>
        <filter id={`${uid}-blur`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="36" />
        </filter>
        <linearGradient id={`${uid}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={palette.bg} />
          <stop offset="100%" stopColor="#0a0a0c" />
        </linearGradient>
      </defs>
      <g clipPath={`url(#${uid}-clip)`}>
        <rect width="290" height="470" fill={`url(#${uid}-bg)`} />
        <circle cx="90" cy="120" r="120" fill={palette.a} filter={`url(#${uid}-blur)`} opacity="0.85" />
        <circle cx="200" cy="150" r="100" fill={palette.b} filter={`url(#${uid}-blur)`} opacity="0.75" />
        <circle cx="150" cy="210" r="90" fill={palette.c} filter={`url(#${uid}-blur)`} opacity="0.7" />
        <rect width="290" height="470" fill="rgba(0,0,0,0.18)" />
      </g>
      <text x="28" y="42" fill="rgba(255,255,255,0.7)" fontSize="13" fontFamily="Geist, system-ui, sans-serif" letterSpacing="0.18em">
        lANTS
      </text>
      <text x="262" y="42" fill="rgba(255,255,255,0.7)" fontSize="13" fontFamily="Geist Mono, ui-monospace, monospace" textAnchor="end">
        {`#${p.id}`}
      </text>
      {/* Uniswap-LP-style: a curve from the start-date pole (top-left) to
          the end-date pole (bottom-right), on a faint x/y axis -- fills
          the card's previously-blank middle, sitting above the name. */}
      <g>
        <line x1="30" y1="86" x2="30" y2="254" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
        <line x1="30" y1="254" x2="260" y2="254" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
        <path
          d="M 34 118 C 110 150, 180 200, 256 238"
          fill="none"
          stroke="rgba(255,255,255,0.6)"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <circle cx="34" cy="118" r="6" fill={palette.a} stroke="#0a0a0c" strokeWidth="2" />
        <circle cx="256" cy="238" r="6" fill={palette.b} stroke="#0a0a0c" strokeWidth="2" />
        <text x="34" y="100" fill="rgba(255,255,255,0.5)" fontSize="8" fontFamily="Geist, system-ui, sans-serif" letterSpacing="0.08em">{t('stake.calStart').toUpperCase()}</text>
        <text x="34" y="112" fill="#ffffff" fontSize="10.5" fontFamily="Geist Mono, ui-monospace, monospace">{dateFmt(startDate, lang)}</text>
        <text x="256" y="260" fill="rgba(255,255,255,0.5)" fontSize="8" fontFamily="Geist, system-ui, sans-serif" letterSpacing="0.08em" textAnchor="end">{t('stake.calEnd').toUpperCase()}</text>
        <text x="256" y="272" fill="#ffffff" fontSize="10.5" fontFamily="Geist Mono, ui-monospace, monospace" textAnchor="end">{dateFmt(endDate, lang)}</text>
      </g>
      <text x="28" y="300" fill="#ffffff" fontSize={name.length > 14 ? 20 : 24} fontWeight="700" fontFamily="Geist, system-ui, sans-serif">
        {name}
      </text>
      <text x="28" y="322" fill="rgba(255,255,255,0.55)" fontSize="12" fontFamily="Geist Mono, ui-monospace, monospace">
        {t('stake.agent', { id: p.agentId })}
      </text>
      <text x="28" y="358" fill="#D79627" fontSize="22" fontWeight="700" fontFamily="Geist, system-ui, sans-serif">
        {`${formatAnts(p.amount)} ANTS`}
      </text>
      <text x="28" y="400" fill="rgba(255,255,255,0.75)" fontSize="13" fontFamily="Geist, system-ui, sans-serif">
        {lockDays != null
          ? `${t('stake.lockedForDays', { n: lockDays })}, ${remainingLabel}`
          : (listingLabel || '—')}
      </text>
      <text x="262" y="400" fill={stateColor(state)} fontSize="12" fontWeight="600" fontFamily="Geist, system-ui, sans-serif" textAnchor="end">
        {stateLabel.toUpperCase()}
      </text>
    </svg>
  );
}

function nftPalette(agentId, positionId) {
  const h1 = ((agentId * 47) + (positionId * 13)) % 360;
  const h2 = (h1 + 38) % 360;
  const h3 = (h1 + 196) % 360;
  return {
    bg: `hsl(${h1}, 42%, 10%)`,
    a: `hsl(${h1}, 78%, 54%)`,
    b: `hsl(${h2}, 82%, 48%)`,
    c: `hsl(${h3}, 70%, 46%)`,
  };
}

/** epoch N starts at genesis + N*epochDuration (seconds) -- mirrors backend/server.js's epochToDate. */
function epochDates(startEpoch, endEpoch, genesis, epochDuration) {
  if (genesis == null || !epochDuration) return { startDate: null, endDate: null, lockDays: null, daysRemaining: null };
  const startDate = startEpoch != null ? new Date((Number(genesis) + startEpoch * epochDuration) * 1000).toISOString() : null;
  const endDate = endEpoch != null ? new Date((Number(genesis) + endEpoch * epochDuration) * 1000).toISOString() : null;
  const lockDays = (startEpoch != null && endEpoch != null) ? Math.round((endEpoch - startEpoch) * epochDuration / 86400) : null;
  const daysRemaining = endDate != null ? Math.max(0, Math.ceil((new Date(endDate).getTime() - Date.now()) / 86400000)) : null;
  return { startDate, endDate, lockDays, daysRemaining };
}

function fitName(name, max) {
  if (!name) return '';
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

function stateColor(state) {
  if (state === 'active') return '#10B981';
  if (state === 'pending') return '#D79627';
  if (state === 'matured') return '#24CD95';
  return 'rgba(255,255,255,0.55)';
}

function RewardTable({ title, icon, side, rows, canAct, canClaim, claimNote, sellers, stakeBounds, openStake, setOpenStake, status, isRowBusy, doClaim, doStake, agentId, t }) {
  return (
    <div style={{ marginBottom: '2rem' }}>
      <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span style={{ color: 'var(--accent)' }}>{icon}</span>{title}
      </h3>
      {claimNote && <div style={{ fontSize: '0.75rem', color: 'var(--warning)', marginBottom: '0.5rem' }}>{claimNote}</div>}
      <div style={{ overflowX: 'auto' }}>
        <table className="table" style={{ minWidth: '600px' }}>
          <thead>
            <tr><th>Epoch</th><th>Points</th><th>ANTS</th><th>Action</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const key = `${side}-${row.epoch}`;
              const isOpen = openStake?.key === key;
              const busy = isRowBusy(side, row.epoch);
              const rowStatus = status?.key === key ? status : null;
              return (
                <React.Fragment key={row.epoch}>
                  <tr>
                    <td>Epoch {row.epoch}</td>
                    <td>{formatNum(row.points)}</td>
                    <td style={{ fontWeight: 600 }}>{row.amount.toFixed(4)}</td>
                    <td>
                      {!canAct ? (
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{t('stake.connectWallet')}</span>
                      ) : (
                        <div style={{ display: 'flex', gap: '0.375rem' }}>
                          {canClaim && (
                            <ActionButton onClick={() => doClaim(side, row.epoch)} disabled={busy} label={t('stake.claim')} />
                          )}
                          <ActionButton
                            onClick={() => setOpenStake(isOpen ? null : { key, agentId: null, lockEpochs: stakeBounds.max })}
                            disabled={busy} label={t('stake.stakeAction')} variant="outline"
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={4} style={{ background: 'var(--bg-secondary)', borderRadius: '8px' }}>
                        <StakePanel
                          side={side} sellers={sellers} agentId={agentId}
                          stakeBounds={stakeBounds}
                          value={openStake}
                          onChange={setOpenStake}
                          onConfirm={() => doStake(side, row.epoch)}
                          busy={busy}
                          t={t}
                        />
                      </td>
                    </tr>
                  )}
                  {rowStatus && (
                    <tr>
                      <td colSpan={4} style={{ fontSize: '0.8125rem', paddingTop: 0 }}>
                        <StatusLine s={rowStatus} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StakePanel({ side, sellers, agentId, stakeBounds, value, onChange, onConfirm, busy, t }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem', padding: '0.75rem 0.5rem' }}>
      {side === 'buyer' ? (
        <select
          value={value?.agentId ?? ''}
          onChange={(e) => onChange({ ...value, agentId: e.target.value ? Number(e.target.value) : null })}
          style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.375rem 0.625rem', color: 'var(--text-primary)', fontSize: '0.8125rem' }}
        >
          <option value="">{t('stake.chooseProvider')}</option>
          {sellers.map((s) => (
            <option key={s.agentId} value={s.agentId}>{s.name || t('stake.agent', { id: s.agentId })} (#{s.agentId})</option>
          ))}
        </select>
      ) : (
        <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
          {t('stake.restakeOwn', { id: agentId })}
        </span>
      )}
      <label style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
        {t('stake.lockInput')}
        <input
          type="number" min={stakeBounds.min} max={stakeBounds.max}
          value={value?.lockEpochs ?? stakeBounds.max}
          onChange={(e) => onChange({ ...value, lockEpochs: Math.min(stakeBounds.max, Math.max(stakeBounds.min, Number(e.target.value) || stakeBounds.min)) })}
          style={{ width: '5rem', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.375rem 0.5rem', color: 'var(--text-primary)', fontSize: '0.8125rem' }}
        />
        {t('stake.lockEpochsHint', { min: stakeBounds.min, max: stakeBounds.max })}
      </label>
      <ActionButton onClick={onConfirm} disabled={busy || (side === 'buyer' && !value?.agentId)} label={t('stake.confirmStake')} />
    </div>
  );
}

function ActionButton({ onClick, disabled, label, variant }) {
  const outline = variant === 'outline';
  return (
    <button
      onClick={onClick} disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.375rem',
        padding: '0.375rem 0.875rem', borderRadius: '6px',
        border: outline ? '1px solid var(--border)' : 'none',
        background: outline ? 'var(--bg-primary)' : 'var(--accent)',
        color: outline ? 'var(--text-primary)' : 'white',
        fontWeight: 600, cursor: disabled ? 'wait' : 'pointer', fontSize: '0.75rem',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {disabled ? <Loader2 size={12} className="spin" /> : <Zap size={12} />}
      {label}
    </button>
  );
}

function StatusLine({ s }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: s.phase === 'error' ? 'var(--danger)' : 'var(--text-secondary)' }}>
      {s.phase === 'error' && <AlertCircle size={14} />}
      {s.phase === 'done' && <CheckCircle size={14} style={{ color: 'var(--accent)' }} />}
      {(s.phase === 'claiming' || s.phase === 'staking') && <Loader2 size={14} className="spin" />}
      <span>{s.message}</span>
      {s.hash && (
        <a href={`https://basescan.org/tx/${s.hash}`} target="_blank" rel="noopener noreferrer"
          style={{ color: 'var(--info)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontFamily: 'monospace' }}>
          {truncateAddress(s.hash)}<ExternalLink size={10} />
        </a>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '0.35rem 0.85rem',
        borderRadius: '999px',
        border: active ? '1px solid var(--accent)' : '1px solid var(--border)',
        background: active ? 'var(--accent-dim)' : 'var(--bg-secondary)',
        color: active ? 'var(--accent)' : 'var(--text-secondary)',
        fontSize: '0.8125rem',
        fontWeight: 600,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function MarketPager({ page, pageSize, total, onChange, t }) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="lants-pager">
      <button type="button" onClick={() => onChange(Math.max(1, page - 1))} disabled={page <= 1}>
        {t('stake.pagePrev')}
      </button>
      <span>{t('stake.pageOf', { page, count: pageCount })}</span>
      <button type="button" onClick={() => onChange(Math.min(pageCount, page + 1))} disabled={page >= pageCount}>
        {t('stake.pageNext')}
      </button>
    </div>
  );
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>{label}</div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: accent || 'var(--text-primary)' }}>{value}</div>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>{sub}</div>
    </div>
  );
}

export default StakeANTS;
