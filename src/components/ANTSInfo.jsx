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
 { pct: '50%', label: 'Sellers', desc: 'Routed to a locked Provider Pool by default. Unlockable via seller unlock policy.' },
 { pct: '20%', label: 'Buyers', desc: 'Proportional to spend. Capped at maxBuyerSharePct (5%) per buyer per epoch — excess goes to reserve.' },
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

 {/* How Points Are Calculated */}
 <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>How Points Are Calculated</h3>
 <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '2rem' }}>
 <div style={{ background: 'var(--bg-secondary)', padding: '1rem 1.25rem', borderRadius: '12px', borderLeft: '3px solid var(--accent)' }}>
 <div style={{ fontSize: '0.875rem', lineHeight: 1.6 }}>
 <span style={{ fontWeight: 600 }}>Source:</span>{' '}
 <span style={{ color: 'var(--text-secondary)' }}>
 When <code style={{ background: 'var(--bg-primary)', padding: '0.125rem 0.375rem', borderRadius: '3px', fontSize: '0.8125rem' }}>AntseedChannels.settle()</code> or{' '}
 <code style={{ background: 'var(--bg-primary)', padding: '0.125rem 0.375rem', borderRadius: '3px', fontSize: '0.8125rem' }}>close()</code>{' '}
 is called, the <em>settlement delta</em> (the new USDC amount being charged in that settlement, before the 4% platform fee) is passed to the Emissions contract:
 </span>
 </div>
 <div style={{ marginTop: '0.75rem', padding: '0.625rem 0.875rem', background: 'var(--bg-primary)', borderRadius: '8px', fontFamily: 'monospace', fontSize: '0.8125rem', lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>
 <span style={{ color: 'var(--text-secondary)' }}>// Inside AntseedChannels._settleSpend()</span>{'\n'}
 <span style={{ color: '#c084fc' }}>uint128</span> delta = cumulativeAmount - channel.settled;{'\n'}
 <span style={{ color: '#c084fc' }}>uint256</span> platformFee = (delta × <span style={{ color: '#f59e0b' }}>400</span>) / 10000;  <span style={{ color: 'var(--text-secondary)' }}>// 4%</span>{'\n'}
 <span style={{ color: 'var(--text-secondary)' }}>// Points use the FULL delta, before fee deduction</span>{'\n'}
 emissions.<span style={{ color: 'var(--warning)' }}>accrueSellerPoints</span>(seller, delta);{'\n'}
 emissions.<span style={{ color: 'var(--info)' }}>accrueBuyerPoints</span>(buyer, delta);{'\n'}
 <span style={{ color: 'var(--text-secondary)' }}>// Fee is only applied when USDC actually moves:</span>{'\n'}
 deposits.chargeAndCreditPayouts(buyer, seller, delta, platformFee);
 </div>
 <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
 The delta is in USDC raw units (6 decimals). A $10 settlement = 10,000,000 points for both buyer and seller. Points are based on the full delta before the 4% platform fee is deducted from the actual USDC transfer.
 </div>
 </div>

 <PointsSection
 title="Buyer Points"
 color="var(--info)"
 formula="buyerPoints += delta  (each settlement)"
 steps={[
 { label: 'Channel is settled', desc: 'When a seller calls settle() or close(), the settlement delta is credited as buyer points to the buyer address for the current epoch.' },
 { label: 'Points accumulate per epoch', desc: 'All deltas from every settlement where the buyer paid USDC are summed into userBuyerPoints[buyer][epoch] and epochTotalBuyerPoints[epoch].' },
 { label: 'Claiming buyer emissions', desc: 'After epoch ends: reward = (userPoints / totalPoints) × budget. Budget = epochEmission × 20%. Capped at budget × maxBuyerSharePct (5%). Excess above cap goes to reserve.' },
 ]}
 notes={[
 'Points are tracked under the buyer address (the wallet that deposited USDC), not the operator/signer address.',
 'Only settled USDC generates points — deposited but unspent USDC does not earn points.',
 'A 4% platform fee is deducted from the USDC transfer, but points are based on the pre-fee delta.',
 'Buyer rewards are capped per-epoch (maxBuyerSharePct = 5% of buyer budget). Any excess above the cap is redirected to the protocol reserve.',
 ]}
 />
 <PointsSection
 title="Seller Points"
 color="var(--warning)"
 formula="sellerPoints += delta  (each settlement)"
 steps={[
 { label: 'Channel is settled', desc: 'The same settlement delta is credited as seller points to the seller address for the current epoch. Buyer and seller receive equal points.' },
 { label: 'Points accumulate per epoch', desc: 'All deltas from every settlement where the seller served requests are summed into userSellerPoints[seller][epoch] and epochTotalSellerPoints[epoch].' },
 { label: 'Claiming seller emissions', desc: 'After epoch ends: reward = (userPoints / totalPoints) × budget. Budget = epochEmission × 50%. By default, rewards are minted to the locked Provider Pool, not to the seller directly.' },
 ]}
 notes={[
 'Buyer and seller receive the same points delta per settlement — points are symmetric.',
 'Seller rewards go to a locked Provider Pool unless a seller unlock policy allows direct claims.',
 'If a pointsPolicy contract is set (via accruePoints), it can return weighted points instead of raw delta — but the deployed Channels currently uses the legacy accrue functions.',
 'Seller rewards are also capped per-epoch (maxSellerSharePct = 50% of seller budget). Excess goes to reserve.',
 ]}
 />
 <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
 <div style={{ fontWeight: 600, marginBottom: '0.75rem' }}>Emission Formula</div>
 <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
 <div style={{ marginBottom: '0.5rem' }}>
 <code style={{ background: 'var(--bg-primary)', padding: '0.125rem 0.5rem', borderRadius: '4px', fontSize: '0.8125rem' }}>
 budget = epochEmission × sharePct / 100
 </code>
 </div>
 <div style={{ marginBottom: '0.5rem' }}>
 <code style={{ background: 'var(--bg-primary)', padding: '0.125rem 0.5rem', borderRadius: '4px', fontSize: '0.8125rem' }}>
 reward = (userPoints / epochTotalPoints) × budget
 </code>
 </div>
 <div style={{ marginBottom: '0.75rem' }}>
 <code style={{ background: 'var(--bg-primary)', padding: '0.125rem 0.5rem', borderRadius: '4px', fontSize: '0.8125rem' }}>
 if reward &gt; budget × maxSharePct / 100 → excess goes to reserve
 </code>
 </div>
 <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.375rem 1rem', fontSize: '0.8125rem' }}>
 <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>epochEmission</span>
 <span>INITIAL_EMISSION halving every halvingInterval epochs</span>
 <span style={{ color: 'var(--info)', fontWeight: 500 }}>Buyer budget</span>
 <span>20% of epochEmission, capped at 5% per buyer</span>
 <span style={{ color: 'var(--warning)', fontWeight: 500 }}>Seller budget</span>
 <span>50% of epochEmission, capped at 50% per seller</span>
 <span style={{ fontWeight: 500 }}>Reserve</span>
 <span>15% of epochEmission + excess from buyer/seller caps</span>
 <span style={{ fontWeight: 500 }}>Team</span>
 <span>15% of epochEmission</span>
 </div>
 </div>
 </div>
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

function PointsSection({ title, color, formula, steps, notes }) {
 return (
 <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
 <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
 <div style={{ width: '4px', height: '20px', borderRadius: '2px', background: color }} />
 <span style={{ fontWeight: 600 }}>{title}</span>
 </div>
 <div style={{ marginBottom: '0.75rem', padding: '0.5rem 0.75rem', background: 'var(--bg-primary)', borderRadius: '8px', fontFamily: 'monospace', fontSize: '0.8125rem', color: color }}>
 {formula}
 </div>
 <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.75rem' }}>
 {steps.map((step, i) => (
 <div key={i} style={{ display: 'flex', gap: '0.625rem', fontSize: '0.8125rem', lineHeight: 1.5 }}>
 <span style={{ flexShrink: 0, width: '20px', height: '20px', borderRadius: '50%', background: 'var(--bg-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6875rem', fontWeight: 600, color: color }}>{i + 1}</span>
 <div>
 <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{step.label}</span>
 <span style={{ color: 'var(--text-secondary)' }}> — {step.desc}</span>
 </div>
 </div>
 ))}
 </div>
 {notes.length > 0 && (
 <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.625rem', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
 {notes.map((note, i) => (
 <div key={i} style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.5, paddingLeft: '0.5rem', borderLeft: '2px solid var(--border)' }}>
 {note}
 </div>
 ))}
 </div>
 )}
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
