import React, { useState, useEffect } from 'react';
import { fetchChainStats } from '../api';
import { ShieldCheck } from 'lucide-react';

function ANTSInfo() {
  const [chainData, setChainData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const data = await fetchChainStats();
        setChainData(data);
        setError(null);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const formatNum = (n) => {
    if (n === undefined || n === null || Number.isNaN(n)) return '—';
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(2) + 'K';
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  };

  if (loading) {
    return (
      <div className="table-container" style={{ padding: '2rem' }}>
        <div style={{ color: 'var(--text-secondary)' }}>Loading on-chain data from Base mainnet...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="table-container" style={{ padding: '2rem' }}>
        <div style={{ color: 'var(--danger)' }}>Error fetching on-chain data: {error}</div>
      </div>
    );
  }

  const cd = chainData || {};
  const ants = cd.ants || {};
  const emissions = cd.emissions || {};
  const stats = cd.stats || {};
  const deposits = cd.deposits || {};
  const staking = cd.staking || {};
  const usdc = cd.usdc || {};

  return (
    <div className="table-container" style={{ padding: '2rem' }}>
      <div style={{ maxWidth: '900px' }}>
        <h2 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>$ANTS On-Chain</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
          Real data from Base mainnet via {cd.rpcUrl || 'public RPC'}
        </p>

        {/* Legend */}
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.25rem', fontSize: '0.75rem', color: 'var(--accent)', background: 'rgba(16,185,129,0.1)', padding: '0.5rem 0.75rem', borderRadius: '8px', border: '1px solid rgba(16,185,129,0.2)' }}>
          <ShieldCheck size={14} />
          <span><b>Verified on-chain</b> — directly read from Base mainnet smart contracts</span>
        </div>

        {/* Key metrics */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
          <StatCard label="Current Supply" value={formatNum(ants.totalSupply)} sub="ANTS" verified={ants.totalSupply !== undefined} />
          <StatCard label="Max Supply" value={formatNum(ants.maxSupply)} sub="Hard cap" verified={false} />
          <StatCard label="Current Epoch" value={emissions.currentEpoch !== undefined ? emissions.currentEpoch : '—'} sub="Emissions" verified={emissions.currentEpoch !== undefined} />
          <StatCard label="Epoch Emission" value={formatNum(emissions.currentRate)} sub="ANTS / epoch" verified={emissions.currentRate !== undefined} />
          <StatCard label="Genesis Block" value={formatNum(emissions.genesis)} sub="Emissions start" verified={emissions.genesis !== undefined} />
          <StatCard label="Halving Interval" value={formatNum(emissions.halvingInterval)} sub="Epochs" verified={emissions.halvingInterval !== undefined} />
          <StatCard label="USDC in Deposits" value={formatNum(usdc.depositsBalance)} sub="Contract balance" verified={usdc.depositsBalance !== undefined} />
          <StatCard label="USDC in Channels" value={formatNum(usdc.channelsBalance)} sub="Locked" verified={usdc.channelsBalance !== undefined} />
        </div>

        {/* Contract addresses */}
        <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>Contract Addresses (Base)</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '2rem' }}>
          {cd.contracts && Object.entries(cd.contracts).map(([key, addr]) => (
            <ContractRow key={key} name={key} address={addr} />
          ))}
        </div>

        {/* Emission allocation */}
        <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>Emission Allocation</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '2rem' }}>
          {[
            { pct: '50%', label: 'Provider Pool', desc: 'Seller emissions tracked and locked while stronger validation is introduced.' },
            { pct: '20%', label: 'Buyers', desc: 'For eligible real usage. Subject to caps and anti-abuse checks.' },
            { pct: '15%', label: 'Protocol Reserve', desc: 'Supports long-term network sustainability and alignment.' },
            { pct: '15%', label: 'Team', desc: 'Vested to core contributors. Aligned with long-term health.' },
          ].map(item => (
            <div key={item.label} style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem', background: 'var(--bg-secondary)', padding: '1rem', borderRadius: '10px' }}>
              <div style={{ minWidth: '60px', fontSize: '1.125rem', fontWeight: 700, color: 'var(--accent)' }}>{item.pct}</div>
              <div>
                <div style={{ fontWeight: 600 }}>{item.label}</div>
                <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>{item.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* How to Earn */}
        <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>How to Earn</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
          <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
            <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>As a Seller</div>
            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>Serve real requests and settle on-chain. Emissions are tracked but currently routed into a locked Provider Pool.</div>
          </div>
          <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
            <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>As a Buyer</div>
            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>Deposit USDC, use the network, and pay for AI services. Eligible buyer emissions may be claimable after epoch finalization.</div>
          </div>
          <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
            <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>Protocol Reserve</div>
            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>Network fees (4% of settlements) flow to the reserve — not to a company — to strengthen the ecosystem.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, verified }) {
  return (
    <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px', position: 'relative' }}>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
        {label}
        {verified && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.15rem', color: 'var(--accent)', fontSize: '0.65rem', fontWeight: 600, textTransform: 'none', letterSpacing: 'normal' }}>
            <ShieldCheck size={11} />
            On-chain
          </span>
        )}
      </div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>{sub}</div>
    </div>
  );
}

function ContractRow({ name, address }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', background: 'var(--bg-secondary)', padding: '0.75rem 1rem', borderRadius: '8px' }}>
      <span style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', minWidth: '140px' }}>{name}</span>
      <code style={{ fontSize: '0.8rem', color: 'var(--text-primary)', fontFamily: 'monospace' }}>{address}</code>
    </div>
  );
}

export default ANTSInfo;
