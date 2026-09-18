import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  useAccount,
  useWriteContract,
  usePublicClient,
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
import { fetchRewards, fetchSellers } from '../api';

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
];

const isValidAddress = (addr) => /^0x[a-fA-F0-9]{40}$/.test(addr);
const truncateAddress = (addr) => (addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '');
const formatNum = (n) => {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(2) + 'K';
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
};

function StakeANTS() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [rewards, setRewards] = useState(null);
  const [sellers, setSellers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [stakeBounds, setStakeBounds] = useState({ min: 1, max: 104 });

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

  const loadData = useCallback(async (addr, bustCache = false) => {
    setLoading(true);
    try {
      const [rewardsData, sellersData] = await Promise.all([
        fetchRewards(addr, bustCache),
        fetchSellers(),
      ]);
      setRewards(rewardsData);
      setSellers(sellersData.filter((s) => s.agentId));
      if (rewardsData?.contracts?.sellerPools && publicClient) {
        try {
          const [min, max] = await Promise.all([
            publicClient.readContract({ address: rewardsData.contracts.sellerPools, abi: SELLER_POOLS_ABI, functionName: 'minStakeEpochs' }),
            publicClient.readContract({ address: rewardsData.contracts.sellerPools, abi: SELLER_POOLS_ABI, functionName: 'MAX_STAKE_EPOCHS' }),
          ]);
          setStakeBounds({ min: Number(min) || 1, max: Number(max) || 104 });
        } catch {
          // Keep the 1..104 default (network defaults observed 2026-09) if the read fails.
        }
      }
    } catch (e) {
      console.error('Failed to load stake data:', e);
    } finally {
      setLoading(false);
    }
  }, [publicClient]);

  useEffect(() => {
    if (!isConnected || !address) {
      setRewards(null);
      return;
    }
    loadData(address);
  }, [isConnected, address, loadData]);

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
      setStatus({ key, phase: 'claiming', message: `Claiming epoch ${epoch} to your wallet…` });
      const hash = side === 'buyer'
        ? await sendTx({ address: r.contracts.usageRewards, abi: USAGE_REWARDS_ABI, functionName: 'claimBuyerReward', args: [displayAddress, epoch] })
        : await sendTx({ address: r.contracts.usageAccounting, abi: USAGE_ACCOUNTING_ABI, functionName: 'claimSellerEmissions', args: [[epoch]] });
      setStatus({ key, phase: 'done', message: `Claimed epoch ${epoch} to your wallet`, hash });
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
        if (!stakeAgentId) { setStatus({ key, phase: 'error', message: 'Pick a provider to stake into first.' }); return; }
        setStatus({ key, phase: 'staking', message: `Staking epoch ${epoch} into agent ${stakeAgentId} for ${lockEpochs} epoch(s)…` });
        const hash = await sendTx({ address: r.contracts.usageRewards, abi: USAGE_REWARDS_ABI, functionName: 'stakeBuyerReward', args: [displayAddress, epoch, stakeAgentId, lockEpochs] });
        setStatus({ key, phase: 'done', message: `Staked epoch ${epoch} into agent ${stakeAgentId} for ${lockEpochs} epoch(s)`, hash });
      } else {
        setStatus({ key, phase: 'staking', message: `Restaking epoch ${epoch} into your own agent pool for ${lockEpochs} epoch(s)…` });
        const hash = await sendTx({ address: r.contracts.usageRewards, abi: USAGE_REWARDS_ABI, functionName: 'stakeAgentReward', args: [r.agentId, epoch, lockEpochs] });
        setStatus({ key, phase: 'done', message: `Restaked epoch ${epoch} for ${lockEpochs} epoch(s)`, hash });
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
  const totalUnclaimed = buyerRows.reduce((s, e) => s + e.amount, 0) + sellerRows.reduce((s, e) => s + e.amount, 0);

  return (
    <div className="table-container" style={{ padding: '2rem' }}>
      <div style={{ maxWidth: '900px' }}>
        <div style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Layers size={24} style={{ color: 'var(--accent)' }} />
            Stake ANTS
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
            Recognized usage rewards since epoch {effectiveEpoch ?? '—'} — claim straight to
            your wallet, or stake into a seller pool (mints directly into the
            pool, no separate transfer step). Seller usage rewards always
            restake into your own agent's pool; buyer usage rewards can go
            to any registered provider.
          </p>
        </div>

        {!isConnected && (
          <div style={{ marginBottom: '2rem', background: 'var(--bg-secondary)', padding: '1.5rem', borderRadius: '12px' }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Search size={16} style={{ color: 'var(--accent)' }} />
              Look Up Any Address
            </h3>
            <form onSubmit={handleSearch} style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                type="text" value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
                placeholder="0x... Enter a Base address"
                style={{ flex: 1, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.5rem 0.75rem', color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: '0.875rem', outline: 'none' }}
              />
              <button type="submit" disabled={searchLoading}
                style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1rem', borderRadius: '8px', border: 'none', background: 'var(--accent)', color: 'white', fontWeight: 600, cursor: searchLoading ? 'wait' : 'pointer', fontSize: '0.875rem', whiteSpace: 'nowrap', opacity: searchLoading ? 0.7 : 1 }}>
                {searchLoading ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
                Search
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
            <p>Connect your wallet or search an address to view stakeable rewards.</p>
          </div>
        )}

        {isLoading && (
          <div style={{ textAlign: 'center', padding: '3rem 2rem', color: 'var(--text-secondary)' }}>
            <Loader2 size={32} className="spin" />
            <p style={{ marginTop: '1rem' }}>Loading rewards data...</p>
          </div>
        )}

        {(isConnected || searchAddress) && !isLoading && rewards && (
          <>
            <div style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--text-secondary)' }}>Viewing:</span>
              <a href={`https://basescan.org/address/${displayAddress}`} target="_blank" rel="noopener noreferrer"
                style={{ color: 'var(--info)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.25rem', fontFamily: 'monospace' }}>
                {displayAddress}<ExternalLink size={12} />
              </a>
              {!isConnected && searchAddress && <span style={{ color: 'var(--text-secondary)' }}>(read-only)</span>}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
              <StatCard label="Unclaimed Since Epoch" value={effectiveEpoch ?? '—'} sub={`${buyerRows.length + sellerRows.length} epoch(s) with rewards`} />
              <StatCard label="Total Unclaimed" value={formatNum(totalUnclaimed)} sub="ANTS" accent="var(--accent)" />
              <StatCard label="Current Epoch" value={rewards.currentEpoch ?? '—'} sub="" />
            </div>

            {buyerRows.length === 0 && sellerRows.length === 0 && (
              <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                No unclaimed recognized-usage rewards for this address since epoch {effectiveEpoch ?? '—'}.
              </div>
            )}

            {buyerRows.length > 0 && (
              <RewardTable
                title="Buyer Usage Rewards" icon={<Users size={16} />} side="buyer" rows={buyerRows}
                canAct={canAct} canClaim={canAct && rewards.buyerUsage?.claimable}
                claimNote={!rewards.buyerUsage?.claimable && rewards.buyerUsage?.recipient ? `Paid to deposits operator ${truncateAddress(rewards.buyerUsage.recipient)} — act from that wallet` : null}
                sellers={sellers} stakeBounds={stakeBounds}
                openStake={openStake} setOpenStake={setOpenStake}
                status={status} isRowBusy={isRowBusy} doClaim={doClaim} doStake={doStake}
              />
            )}

            {sellerRows.length > 0 && (
              <RewardTable
                title="Seller Usage Rewards" icon={<TrendingUp size={16} />} side="seller" rows={sellerRows}
                canAct={canAct} canClaim={canAct && rewards.sellerUsage?.claimable}
                claimNote={rewards.agentId === 0 ? 'Requires a registered seller agent' : null}
                sellers={sellers} stakeBounds={stakeBounds}
                openStake={openStake} setOpenStake={setOpenStake}
                status={status} isRowBusy={isRowBusy} doClaim={doClaim} doStake={doStake}
                agentId={rewards.agentId}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RewardTable({ title, icon, side, rows, canAct, canClaim, claimNote, sellers, stakeBounds, openStake, setOpenStake, status, isRowBusy, doClaim, doStake, agentId }) {
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
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Connect wallet</span>
                      ) : (
                        <div style={{ display: 'flex', gap: '0.375rem' }}>
                          {canClaim && (
                            <ActionButton onClick={() => doClaim(side, row.epoch)} disabled={busy} label="Claim" />
                          )}
                          <ActionButton
                            onClick={() => setOpenStake(isOpen ? null : { key, agentId: null, lockEpochs: stakeBounds.max })}
                            disabled={busy} label="Stake" variant="outline"
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

function StakePanel({ side, sellers, agentId, stakeBounds, value, onChange, onConfirm, busy }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem', padding: '0.75rem 0.5rem' }}>
      {side === 'buyer' ? (
        <select
          value={value?.agentId ?? ''}
          onChange={(e) => onChange({ ...value, agentId: e.target.value ? Number(e.target.value) : null })}
          style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.375rem 0.625rem', color: 'var(--text-primary)', fontSize: '0.8125rem' }}
        >
          <option value="">Choose a provider…</option>
          {sellers.map((s) => (
            <option key={s.agentId} value={s.agentId}>{s.name || `Agent #${s.agentId}`} (#{s.agentId})</option>
          ))}
        </select>
      ) : (
        <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
          Restakes into your own agent pool (#{agentId})
        </span>
      )}
      <label style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
        Lock
        <input
          type="number" min={stakeBounds.min} max={stakeBounds.max}
          value={value?.lockEpochs ?? stakeBounds.max}
          onChange={(e) => onChange({ ...value, lockEpochs: Math.min(stakeBounds.max, Math.max(stakeBounds.min, Number(e.target.value) || stakeBounds.min)) })}
          style={{ width: '5rem', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.375rem 0.5rem', color: 'var(--text-primary)', fontSize: '0.8125rem' }}
        />
        epoch(s) ({stakeBounds.min}–{stakeBounds.max})
      </label>
      <ActionButton onClick={onConfirm} disabled={busy || (side === 'buyer' && !value?.agentId)} label="Confirm Stake" />
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
