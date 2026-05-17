import React, { useState, useEffect } from 'react';
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
} from 'wagmi';
import {
  Award,
  Loader2,
  AlertCircle,
  CheckCircle,
  ExternalLink,
  Zap,
  TrendingUp,
  ShieldAlert,
  Search,
  Wallet,
} from 'lucide-react';
import { fetchEmissionsEpochInfo, fetchEmissionsPending, fetchEmissionsBalance } from '../api';

const EMISSIONS_CONTRACT = '0xF13bE52c4A3afC6AE29536f073588d01A0564088';
const EMISSIONS_V1_CONTRACT = '0x36877fBa8Fa333aa46a1c57b66D132E4995C86b5';

// Emissions ABI for claim functions
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

function ClaimANTS() {
  const { address, isConnected } = useAccount();
  
  // Data states
  const [epochInfo, setEpochInfo] = useState(null);
  const [pendingData, setPendingData] = useState(null);
  const [balance, setBalance] = useState(null);
  const [loading, setLoading] = useState(false);
  
  // Claim states
  const [claimType, setClaimType] = useState('buyer');
  const [claimEpochs, setClaimEpochs] = useState([]);
  
 // Search states (for non-connected users)
 const [searchInput, setSearchInput] = useState('');
 const [searchAddress, setSearchAddress] = useState(null);
 const [searchData, setSearchData] = useState(null);
 const [searchBalance, setSearchBalance] = useState(null);
 const [searchLoading, setSearchLoading] = useState(false);
 const [searchError, setSearchError] = useState(null);

 // Buyer channel address (for buyer emissions tracked under a different address)
 const [buyerAddresses, setBuyerAddresses] = useState([]);
 const [buyerAddressInput, setBuyerAddressInput] = useState('');

  // Wagmi write hook
  const { 
    data: hash, 
    isPending: isClaiming, 
    writeContract, 
    error: writeError,
    reset: resetWrite,
  } = useWriteContract();

  const { isLoading: isConfirming, isSuccess: isConfirmed, isError: isConfirmError } = 
    useWaitForTransactionReceipt({ hash });

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

  // ── Load data for connected wallet ──
 const loadData = async (addr, bustCache = false) => {
 setLoading(true);
 try {
 const info = await fetchEmissionsEpochInfo();
 setEpochInfo(info);

 if (info.currentEpoch > 0) {
 const epochs = Array.from({ length: Math.min(info.currentEpoch + 1, 52) }, (_, i) => i);
 const pending = await fetchEmissionsPending(addr, epochs, bustCache, buyerAddresses);
 setPendingData(pending);
 }

 const bal = await fetchEmissionsBalance(addr);
 setBalance(bal);
 } catch (e) {
 console.error('Failed to load emissions data:', e);
 } finally {
 setLoading(false);
 }
 };

 useEffect(() => {
 if (!isConnected || !address) {
 setPendingData(null);
 setBalance(null);
 return;
 }
 (async () => {
 try {
 const resp = await fetch(`/api/operator-buyers?operator=${address.toLowerCase()}`);
 const rows = await resp.json();
 if (rows.length > 0) {
 setBuyerAddresses(rows.map(r => r.buyer));
 }
 } catch {}
 })();
 loadData(address);
 }, [isConnected, address]);

  // ── Reset write state when claim type changes ──
  useEffect(() => {
    resetWrite();
  }, [claimType, resetWrite]);

  // ── Reload data after successful claim ──
  useEffect(() => {
    if (isConfirmed) {
      const addr = isConnected ? address : searchAddress;
      if (addr) loadData(addr, true);
    }
  }, [isConfirmed]);

  // ── Search function ──
 const handleSearch = async (e) => {
 e?.preventDefault();
 const addr = searchInput.trim();
 if (!isValidAddress(addr)) {
 setSearchError('Invalid address format. Must be 0x followed by 40 hex characters.');
 return;
 }
 setSearchAddress(addr);
 setSearchLoading(true);
 setSearchError(null);
 setSearchData(null);
 setSearchBalance(null);

 try {
 const resp = await fetch(`/api/operator-buyers?operator=${addr.toLowerCase()}`);
 const rows = await resp.json();
 if (rows.length > 0) {
 setBuyerAddresses(rows.map(r => r.buyer));
 }
 } catch {}

 try {
 const info = await fetchEmissionsEpochInfo();
 setEpochInfo(info);

 if (info.currentEpoch > 0) {
 const epochs = Array.from({ length: Math.min(info.currentEpoch + 1, 52) }, (_, i) => i);
        const pending = await fetchEmissionsPending(addr, epochs, true, buyerAddresses);
        setSearchData(pending);
      }
      
      const bal = await fetchEmissionsBalance(addr);
      setSearchBalance(bal);
    } catch (e) {
      setSearchError(e.message || 'Failed to load data for this address');
    } finally {
      setSearchLoading(false);
    }
  };

  // ── Claim handler ──
const handleClaim = () => {
  if (!isConnected || !address || claimEpochs.length === 0) return;

  const v2Epochs = claimEpochs.filter(e => e >= 4);
  const v1Epochs = claimEpochs.filter(e => e < 4);

  const doClaim = (contract, epochs, type) => {
    if (epochs.length === 0) return;
    if (type === 'buyer') {
      writeContract({ address: contract, abi: EMISSIONS_ABI, functionName: 'claimBuyerEmissions', args: [address, epochs] });
    } else {
      writeContract({ address: contract, abi: EMISSIONS_ABI, functionName: 'claimSellerEmissions', args: [epochs] });
    }
  };

  if (v1Epochs.length > 0) {
    doClaim(EMISSIONS_V1_CONTRACT, v1Epochs, claimType);
  }
  if (v2Epochs.length > 0) {
    doClaim(EMISSIONS_CONTRACT, v2Epochs, claimType);
  }
};

// ── Per-epoch claim handler ──
const handleClaimEpoch = (epochData, type) => {
  if (!isConnected || !address) return;

  const contract = epochData.epoch < 4 ? EMISSIONS_V1_CONTRACT : EMISSIONS_CONTRACT;

  if (type === 'seller') {
    writeContract({ address: contract, abi: EMISSIONS_ABI, functionName: 'claimSellerEmissions', args: [[epochData.epoch]] });
  } else {
    writeContract({ address: contract, abi: EMISSIONS_ABI, functionName: 'claimBuyerEmissions', args: [address, [epochData.epoch]] });
  }
};

  // ── Derived state ──
  const displayAddress = isConnected ? address : searchAddress;
  const displayData = isConnected ? pendingData : searchData;
  const displayBalance = isConnected ? balance : searchBalance;
  const isLoading = isConnected ? loading : searchLoading;
  const error = isConnected ? null : searchError;

  // Calculate claimable epochs (FIX: based on points > 0 AND not claimed, not pending amount)
  const claimableEpochs = displayData?.epochs?.filter((e) => {
    const pts = claimType === 'buyer' ? e.buyerPoints : e.sellerPoints;
    const claimed = claimType === 'buyer' ? e.buyerClaimed : e.sellerClaimed;
    return pts > 0 && !claimed;
  }) || [];

  const hasClaimable = claimableEpochs.length > 0;
  const totalPoints = claimableEpochs.reduce((sum, e) => 
    sum + (claimType === 'buyer' ? e.buyerPoints : e.sellerPoints), 0
  );

  // Update claimEpochs when claimableEpochs changes
  useEffect(() => {
    setClaimEpochs(claimableEpochs.map(e => e.epoch));
  }, [claimableEpochs]);

  // Transaction error message
  const txError = writeError?.message || (isConfirmError ? 'Transaction failed on chain' : null);

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
 Check and claim your ANTS emissions on Base mainnet
 </p>
 </div>
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
                    flex: 1,
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    padding: '0.5rem 0.75rem',
                    color: 'var(--text-primary)',
                    fontFamily: 'monospace',
                    fontSize: '0.875rem',
                    outline: 'none',
                  }}
                />
                <button
                  type="submit"
                  disabled={searchLoading}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.375rem',
                    padding: '0.5rem 1rem',
                    borderRadius: '8px',
                    border: 'none',
                    background: 'var(--accent)',
                    color: 'white',
                    fontWeight: 600,
                    cursor: searchLoading ? 'wait' : 'pointer',
                    fontSize: '0.875rem',
                    whiteSpace: 'nowrap',
                    opacity: searchLoading ? 0.7 : 1,
                  }}
                >
                  {searchLoading ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
                  Search
                </button>
              </form>
              {error && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.75rem', color: 'var(--danger)', fontSize: '0.875rem' }}>
                  <AlertCircle size={14} />
                  <span>{error}</span>
                </div>
              )}
            </div>
          </div>
        )}

 {/* Not connected and no search yet */}
 {!isConnected && !searchAddress && !searchLoading && (
 <div style={{ textAlign: 'center', padding: '3rem 2rem', color: 'var(--text-secondary)' }}>
 <Wallet size={48} style={{ marginBottom: '1rem', opacity: 0.5 }} />
 <p>Connect your wallet or search an address to view ANTS emissions.</p>
 <p style={{ fontSize: '0.8rem', marginTop: '0.5rem', opacity: 0.7 }}>
 Supports MetaMask, Coinbase Wallet, Rainbow, and other wallets on Base.
 </p>
 </div>
 )}

 {/* Buyer channel address input */}
 {(isConnected || searchAddress) && (
 <div style={{ marginBottom: '1rem' }}>
 <div style={{ background: 'var(--bg-secondary)', padding: '1rem', borderRadius: '12px' }}>
 <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: buyerAddresses.length > 0 ? '0.5rem' : 0 }}>
 <Wallet size={14} style={{ color: 'var(--accent)' }} />
 <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>Buyer Addresses</span>
 <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>- signer wallet for buyer points (Deposits operator mapping)</span>
 </div>
 {buyerAddresses.length > 0 && (
 <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginBottom: '0.5rem' }}>
 {buyerAddresses.map((ba) => (
 <span key={ba} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', background: 'var(--bg-primary)', padding: '0.25rem 0.5rem', borderRadius: '6px', fontSize: '0.75rem', fontFamily: 'monospace' }}>
 {truncateAddress(ba)}
 <button onClick={async () => {
 setBuyerAddresses(prev => prev.filter(a => a !== ba));
 const op = displayAddress.toLowerCase();
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
 flex: 1,
 background: 'var(--bg-primary)',
 border: '1px solid var(--border)',
 borderRadius: '6px',
 padding: '0.375rem 0.625rem',
 color: 'var(--text-primary)',
 fontFamily: 'monospace',
 fontSize: '0.75rem',
 outline: 'none',
 }}
 onKeyDown={async (e) => {
 if (e.key === 'Enter') {
 e.preventDefault();
 const addr = buyerAddressInput.trim();
 if (isValidAddress(addr) && !buyerAddresses.includes(addr)) {
 setBuyerAddresses(prev => [...prev, addr]);
 setBuyerAddressInput('');
 const op = displayAddress.toLowerCase();
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
 setBuyerAddresses(prev => [...prev, addr]);
 setBuyerAddressInput('');
 const op = displayAddress.toLowerCase();
 if (op) {
 try { await fetch('/api/operator-buyers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operator: op, buyer: addr.toLowerCase() }) }); } catch {}
 }
 }
 }}
 disabled={!isValidAddress(buyerAddressInput.trim()) || buyerAddresses.includes(buyerAddressInput.trim())}
 style={{
 padding: '0.375rem 0.75rem',
 borderRadius: '6px',
 border: 'none',
 background: isValidAddress(buyerAddressInput.trim()) && !buyerAddresses.includes(buyerAddressInput.trim()) ? 'var(--accent)' : 'var(--border)',
 color: isValidAddress(buyerAddressInput.trim()) && !buyerAddresses.includes(buyerAddressInput.trim()) ? 'white' : 'var(--text-secondary)',
 fontWeight: 600,
 cursor: isValidAddress(buyerAddressInput.trim()) && !buyerAddresses.includes(buyerAddressInput.trim()) ? 'pointer' : 'not-allowed',
 fontSize: '0.75rem',
 whiteSpace: 'nowrap',
 }}
 >
 Add
 </button>
 </div>
 </div>
 </div>
 )}

        {/* Loading state */}
        {isLoading && (
          <div style={{ textAlign: 'center', padding: '3rem 2rem', color: 'var(--text-secondary)' }}>
            <Loader2 size={32} className="spin" />
            <p style={{ marginTop: '1rem' }}>Loading emissions data...</p>
          </div>
        )}

        {/* Data display */}
        {(isConnected || searchAddress) && !isLoading && (
          <>
            {/* Address display */}
            <div style={{ marginBottom: '1.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Viewing:</span>
                <a
                  href={`https://basescan.org/address/${displayAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ 
                    color: 'var(--info)', 
                    textDecoration: 'none', 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '0.25rem', 
                    fontFamily: 'monospace' 
                  }}
                >
                  {displayAddress}
                  <ExternalLink size={12} />
                </a>
                {!isConnected && searchAddress && (
                  <span style={{ color: 'var(--text-secondary)' }}>(read-only)</span>
                )}
              </div>
            </div>

            {/* Stats row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
              <StatCard 
                label="ANTS Balance" 
                value={displayBalance ? formatNum(displayBalance.ants) : '—'} 
                sub="ANTS" 
              />
              <StatCard 
                label="Buyer Pending" 
                value={displayData ? formatNum(parseFloat(displayData.buyer)) : '—'} 
                sub="ANTS" 
                accent="var(--info)" 
              />
              <StatCard 
                label="Seller Pending" 
                value={displayData ? formatNum(parseFloat(displayData.seller)) : '—'} 
                sub="ANTS" 
                accent="var(--warning)" 
              />
              <StatCard 
                label="Current Epoch" 
                value={epochInfo?.currentEpoch ?? '—'} 
                sub={epochInfo ? `${formatNum(epochInfo.currentEmission)} ANTS/epoch` : ''} 
              />
            </div>

            {/* Claim type selector */}
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', background: 'var(--bg-secondary)', padding: '0.5rem', borderRadius: '10px', width: 'fit-content' }}>
              <button
                onClick={() => setClaimType('buyer')}
                style={{ 
                  border: 'none', 
                  background: claimType === 'buyer' ? 'var(--accent)' : 'transparent', 
                  color: claimType === 'buyer' ? 'white' : 'var(--text-secondary)', 
                  padding: '0.5rem 1rem', 
                  borderRadius: '8px', 
                  cursor: 'pointer', 
                  fontWeight: 500,
                  fontSize: '0.875rem',
                }}
              >
                Buyer Emissions
              </button>
              <button
                onClick={() => setClaimType('seller')}
                style={{ 
                  border: 'none', 
                  background: claimType === 'seller' ? 'var(--accent)' : 'transparent', 
                  color: claimType === 'seller' ? 'white' : 'var(--text-secondary)', 
                  padding: '0.5rem 1rem', 
                  borderRadius: '8px', 
                  cursor: 'pointer', 
                  fontWeight: 500,
                  fontSize: '0.875rem',
                }}
              >
                Seller Emissions
              </button>
            </div>

            {/* Seller warning */}
            {claimType === 'seller' && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.2)', padding: '0.875rem 1rem', borderRadius: '10px', color: 'var(--warning)', fontSize: '0.875rem', marginBottom: '1.25rem' }}>
                <ShieldAlert size={16} style={{ flexShrink: 0, marginTop: '0.1rem' }} />
                <span>Seller emissions may be routed to a locked Provider Pool while validation is strengthened. Claim transaction will succeed but tokens may not be immediately transferable.</span>
              </div>
            )}

            {/* Claim action box */}
            <div style={{ background: 'var(--bg-secondary)', padding: '1.5rem', borderRadius: '12px', marginBottom: '1.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
                <div>
                  <div style={{ fontSize: '1.125rem', fontWeight: 700 }}>
                    {totalPoints.toLocaleString()} points in {claimableEpochs.length} unclaimed {claimType} epochs
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                    {claimType === 'seller' 
                      ? 'Seller emissions: Contract may route to Provider Pool'
                      : 'Buyer emissions: Direct claim to wallet'
                    }
                  </div>
                </div>
                
                {isConnected ? (
                  <button
                    onClick={handleClaim}
                    disabled={!hasClaimable || isClaiming || isConfirming}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      padding: '0.625rem 1.5rem',
                      borderRadius: '10px',
                      border: 'none',
                      background: hasClaimable ? 'var(--accent)' : 'var(--border)',
                      color: hasClaimable ? 'white' : 'var(--text-secondary)',
                      fontWeight: 600,
                      cursor: hasClaimable && !isClaiming && !isConfirming ? 'pointer' : 'not-allowed',
                      fontSize: '0.875rem',
                      opacity: hasClaimable && !isClaiming && !isConfirming ? 1 : 0.5,
                    }}
                  >
                    {isClaiming || isConfirming ? (
                      <Loader2 size={16} className="spin" />
                    ) : (
                      <Zap size={16} />
                    )}
                    {isClaiming ? 'Confirm in wallet...' : isConfirming ? 'Confirming...' : 'Claim ANTS'}
                  </button>
                ) : (
                  <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                    Connect wallet to claim
                  </div>
                )}
              </div>

              {/* Transaction status */}
              {hash && (
                <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem' }}>
                  {isConfirming && <Loader2 size={14} className="spin" style={{ color: 'var(--info)' }} />}
                  {isConfirmed && <CheckCircle size={14} style={{ color: 'var(--accent)' }} />}
                  {isConfirmError && <AlertCircle size={14} style={{ color: 'var(--danger)' }} />}
                  <a
                    href={`https://basescan.org/tx/${hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--info)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
                  >
                    {isConfirming ? 'Transaction pending' : isConfirmed ? 'Claim successful!' : 'Claim failed'} — {truncateAddress(hash)}
                    <ExternalLink size={12} />
                  </a>
                </div>
              )}

              {txError && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '1rem', color: 'var(--danger)', fontSize: '0.875rem' }}>
                  <AlertCircle size={14} />
                  <span>{txError.includes('user rejected') ? 'Transaction rejected' : txError}</span>
                </div>
              )}
            </div>

            {/* Epoch breakdown table */}
            <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>Epoch Breakdown</h3>
            {displayData?.epochs?.length > 0 ? (
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
                    {[...displayData.epochs]
                      .reverse()
                      .map((e) => {
                        const totalAnts = (e.sellerReward || 0) + (e.buyerReward || 0);
                        const isCurrentEpoch = e.isCurrentEpoch;
                        const sellerClaimable = !isCurrentEpoch && e.sellerReward > 0 && !e.sellerClaimed;
                        const buyerClaimable = !isCurrentEpoch && e.buyerReward > 0 && !e.buyerClaimed;

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
                              ) : e.buyerClaimed ? (
                                <span className="status-badge offline" style={{ fontSize: '0.75rem' }}>Claimed</span>
                              ) : buyerClaimable && isConnected ? (
                                <button
                                  onClick={() => handleClaimEpoch(e, 'buyer')}
                                  disabled={isClaiming || isConfirming}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '0.25rem',
                                    padding: '0.25rem 0.625rem',
                                    borderRadius: '6px',
                                    border: 'none',
                                    background: 'var(--accent)',
                                    color: 'white',
                                    fontWeight: 600,
                                    cursor: isClaiming || isConfirming ? 'wait' : 'pointer',
                                    fontSize: '0.75rem',
                                    opacity: isClaiming || isConfirming ? 0.5 : 1,
                                  }}
                                >
                                  <Zap size={12} />
                                  Claim
                                </button>
                              ) : buyerClaimable && !isConnected ? (
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Connect wallet</span>
                              ) : (
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>—</span>
                              )}
                            </td>
                            <td>
                              {isCurrentEpoch ? (
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>Ongoing</span>
                              ) : e.sellerClaimed ? (
                                <span className="status-badge offline" style={{ fontSize: '0.75rem' }}>Claimed</span>
                              ) : sellerClaimable && isConnected ? (
                                <button
                                  onClick={() => handleClaimEpoch(e, 'seller')}
                                  disabled={isClaiming || isConfirming}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '0.25rem',
                                    padding: '0.25rem 0.625rem',
                                    borderRadius: '6px',
                                    border: 'none',
                                    background: 'var(--accent)',
                                    color: 'white',
                                    fontWeight: 600,
                                    cursor: isClaiming || isConfirming ? 'wait' : 'pointer',
                                    fontSize: '0.75rem',
                                    opacity: isClaiming || isConfirming ? 0.5 : 1,
                                  }}
                                >
                                  <Zap size={12} />
                                  Claim
                                </button>
                              ) : sellerClaimable && !isConnected ? (
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
            ) : (
              <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                No emissions recorded yet. Start using the network to earn ANTS.
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

export default ClaimANTS;
