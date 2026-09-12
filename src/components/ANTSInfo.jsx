import React, { useState, useEffect } from 'react';
import { fetchChainStats } from '../api';
import { ShieldCheck } from 'lucide-react';

const CONTRACT_LABELS = {
  usdc: 'USDC',
  registry: 'AntseedRegistry',
  deposits: 'AntseedDeposits',
  channels: 'AntseedChannels',
  stats: 'AntseedStats',
  antsToken: 'ANTSToken',
  identityRegistry: 'IdentityRegistry (ERC-8004)',
  freeUsage: 'AntseedFreeUsage',
  depositRelay: 'AntseedDepositRelay',
  legacyStaking: 'Legacy USDC Staking',
  legacyEmissionsV2: 'Legacy Emissions (V2)',
  legacyEmissionsV1: 'Legacy Emissions (V1)',
  emissionsGate: 'AntseedEmissionsGate',
  sellerPools: 'AntseedSellerPools',
  sellerRegistry: 'AntseedSellerRegistry',
  positionInit: 'AntseedPositionInit',
  usageAccounting: 'AntseedUsageAccounting',
  usageRewards: 'AntseedUsageRewards',
  sellerPoolsRewards: 'AntseedSellerPoolsRewards',
  washTradingRegistry: 'AntseedWashTradingRegistry',
  pointsPolicyRegistry: 'AntseedPointsPolicyRegistry',
  legacyEmissionsEscrow: 'AntseedLegacyEmissionsEscrow',
};

const FALLBACK_ALLOCATION = [
  { name: 'seller-pools', sharePct: 40, desc: 'Staker rewards on locked ANTS (lANTS) positions in seller pools. The effective share is dynamic — it rises with active stake toward the 40% ceiling.' },
  { name: 'usage', sharePct: 20, desc: 'Buyer and seller/operator usage rewards from recognized service volume. Dynamic shares rise with recognized USDC volume per epoch.' },
  { name: 'team', sharePct: 15, desc: 'Core contributors, vested and aligned with long-term network health.' },
  { name: 'reserve', sharePct: 15, desc: 'Emissions reserve — receives regular allocation plus excess from remainder settlement.' },
  { name: 'verification', sharePct: 10, desc: 'Verification allocation (initially an editable controller wallet).' },
];

const ALLOCATION_DESCRIPTIONS = {
  'seller-pools': FALLBACK_ALLOCATION[0].desc,
  'usage': FALLBACK_ALLOCATION[1].desc,
  'team': FALLBACK_ALLOCATION[2].desc,
  'reserve': FALLBACK_ALLOCATION[3].desc,
  'verification': FALLBACK_ALLOCATION[4].desc,
};

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
  const usdc = cd.usdc || {};
  const allocation = (cd.allocation && cd.allocation.length > 0)
    ? cd.allocation.map((a) => ({
        name: a.name,
        pct: a.sharePct != null ? `${a.sharePct.toFixed(a.sharePct % 1 ? 1 : 0)}%` : '—',
        desc: ALLOCATION_DESCRIPTIONS[a.name] || '',
      }))
    : FALLBACK_ALLOCATION.map((a) => ({ name: a.name, pct: `${a.sharePct}%`, desc: a.desc }));
  const eraActive = emissions.effectiveEpoch != null && emissions.effectiveEpoch !== undefined;

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

        {/* Recognized usage era banner */}
        {eraActive && (
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '12px', padding: '1rem 1.25rem', marginBottom: '1.5rem', fontSize: '0.875rem', lineHeight: 1.6 }}>
            <div style={{ fontWeight: 700, marginBottom: '0.25rem', color: 'var(--accent)' }}>
              Recognized usage era — active since epoch {emissions.effectiveEpoch}
            </div>
            <div style={{ color: 'var(--text-secondary)' }}>
              ANTS rewards connect to paid service delivery and seller-pool stake: usage points are earned
              through settled USDC volume, and stakers earn pool rewards on locked ANTS (lANTS) positions.
              Epochs 0–{emissions.effectiveEpoch - 1} remain claimable as legacy emissions.
            </div>
          </div>
        )}

        {/* Key metrics */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
          <StatCard label="Current Supply" value={formatNum(ants.totalSupply)} sub="ANTS" verified={ants.totalSupply !== undefined} />
          <StatCard label="Max Supply" value={formatNum(ants.maxSupply)} sub="Hard cap" verified={ants.maxSupply !== undefined} />
          <StatCard label="Current Epoch" value={emissions.currentEpoch !== undefined ? emissions.currentEpoch : '—'} sub="Weekly epochs" verified={emissions.currentEpoch !== undefined} />
          <StatCard label="Epoch Emission" value={formatNum(emissions.currentRate)} sub="ANTS / epoch" verified={emissions.currentRate !== undefined} />
          <StatCard label="Recognized Since" value={emissions.effectiveEpoch !== undefined ? `Epoch ${emissions.effectiveEpoch}` : '—'} sub="Usage era" verified={emissions.effectiveEpoch !== undefined} />
          <StatCard label="Halving Interval" value={formatNum(emissions.halvingInterval)} sub="Epochs" verified={emissions.halvingInterval !== undefined} />
          <StatCard label="USDC in Deposits" value={formatNum(usdc.depositsBalance)} sub="Contract balance" verified={usdc.depositsBalance !== undefined} />
          <StatCard label="USDC in Channels" value={formatNum(usdc.channelsBalance)} sub="Zero by design" verified={usdc.channelsBalance !== undefined} />
        </div>

        {/* Contract addresses */}
        <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>Contract Addresses (Base)</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '2rem' }}>
          {cd.contracts && Object.entries(cd.contracts).map(([key, addr]) => (
            addr ? <ContractRow key={key} name={CONTRACT_LABELS[key] || key} address={addr} /> : null
          ))}
        </div>

        {/* Emission allocation (recognized-usage era ceilings, read live from the gate) */}
        <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>
          Emission Allocation {eraActive ? `(epoch ${emissions.effectiveEpoch}+)` : ''}
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '2rem' }}>
          {allocation.map((item) => (
            <div key={item.name} style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem', background: 'var(--bg-secondary)', padding: '1rem', borderRadius: '10px' }}>
              <div style={{ minWidth: '60px', fontSize: '1.125rem', fontWeight: 700, color: 'var(--accent)' }}>{item.pct}</div>
              <div>
                <div style={{ fontWeight: 600 }}>{item.name}</div>
                <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>{item.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Dynamic shares */}
        <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>Dynamic Reward Shares</h3>
        <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px', marginBottom: '2rem' }}>
          <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: '0.75rem' }}>
            The seller-pool and usage ceilings are not fixed payouts — their effective shares scale smoothly
            with network participation. Each share follows:
          </div>
          <div style={{ padding: '0.625rem 0.875rem', background: 'var(--bg-primary)', borderRadius: '8px', fontFamily: 'monospace', fontSize: '0.8125rem', marginBottom: '0.75rem' }}>
            share = minimum + (maximum − minimum) × input / (input + target)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.375rem 1rem', fontSize: '0.8125rem' }}>
            <span style={{ color: 'var(--accent)', fontWeight: 500 }}>Staker share</span>
            <span>2% baseline → 40% ceiling. Input: active staked ANTS, target 400M (scales with scheduled emissions). At target the share is 21%.</span>
            <span style={{ color: 'var(--info)', fontWeight: 500 }}>Buyer share</span>
            <span>5% baseline → 10% ceiling. Input: recognized USDC volume per epoch, network-wide target 1M USDC. At target the share is 7.5%.</span>
            <span style={{ color: 'var(--warning)', fontWeight: 500 }}>Seller/operator share</span>
            <span>5% baseline → 10% ceiling. Same recognized-volume input as the buyer share.</span>
            <span style={{ fontWeight: 500 }}>Unallocated remainder</span>
            <span>Burned first (up to 30% of the epoch's scheduled emissions), the rest goes to the emissions reserve.</span>
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.75rem', lineHeight: 1.5 }}>
            A zero input gives a zero share. These are allocation shares, not guaranteed payments — reward
            eligibility, pool power, and utilization determine the actual distribution.
          </div>
        </div>

        {/* How rewards are earned */}
        <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>How Rewards Are Earned</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '2rem' }}>
          <PointsSection
            title="Seller Usage Rewards"
            color="var(--warning)"
            formula="seller points (recognized USDC volume) × pool power → agent share of the seller/operator budget"
            steps={[
              { label: 'Eligible seller pool', desc: 'Recognized usage requires a registered seller with an eligible pool and sufficient epoch power. Staking power activates the epoch after the stake.' },
              { label: 'Points accrue on settlement', desc: 'When channels settle, AntseedUsageAccounting applies the registered points policies and records seller points per epoch (scaled by 1e6).' },
              { label: 'Claim via UsageAccounting', desc: 'After the epoch ends, pending seller emissions are claimed with claimSellerEmissions(epochs). The Claim ANTS tab tracks each epoch.' },
            ]}
            notes={[
              'A missing or filtered pool still settles USDC but earns no new usage points for that record.',
              'The historical wash-trading policy zeros both buyer and seller points when a seller’s proven wash volume reaches 25% of its authenticated historical total.',
              'Legacy USDC staking remains an eligibility fallback until explicitly disabled.',
            ]}
          />
          <PointsSection
            title="Buyer Usage Rewards"
            color="var(--info)"
            formula="buyer points (recognized USDC volume) → buyer share of the usage budget"
            steps={[
              { label: 'Points accrue on settlement', desc: 'Each settlement credits buyer points for the recognized USDC volume paid, after points policies, into UsageAccounting.' },
              { label: 'Rewards accrue per epoch', desc: 'After finalization, UsageRewards tracks pendingBuyerReward(buyer, epoch) — one record per epoch.' },
              { label: 'Claimed by the deposits operator', desc: 'Buyer usage rewards are paid to the wallet operating the buyer’s Deposits account: claimBuyerReward(buyer, epoch).' },
            ]}
            notes={[
              'Only settled USDC generates points — deposited but unspent USDC does not earn rewards.',
              'If the deposits operator differs from the buyer wallet, claim from the operator wallet (the dashboard shows the recipient).',
            ]}
          />
          <PointsSection
            title="Staker (Seller Pool) Rewards"
            color="var(--accent)"
            formula="position power / pool power → share of the pool’s seller-pool reward budget"
            steps={[
              { label: 'Lock ANTS into a pool', desc: 'AntseedSellerPools holds locked ANTS positions represented by lANTS NFTs. Staking power activates in the following epoch.' },
              { label: 'Pool rewards accrue', desc: 'SellerPoolsRewards indexes each pool’s emissions per epoch; rewards accrue on open (and recently closed) positions.' },
              { label: 'Claim or restake', desc: 'Pending rewards are previewed per position and claimed with claimStakerRewardsBatch(positionIds, recipient) — the Claim ANTS tab runs the full index-then-claim flow.' },
            ]}
            notes={[
              'Moving stake preserves the principal, lock, and accrued rewards; early withdrawal slashes 5–50% of principal (linear in remaining lock), burned to 0x…dEaD.',
              'Rewards on positions closed by split/merge/move remain claimable under the old position ID.',
            ]}
          />
          <PointsSection
            title="Legacy Emissions (epochs 0–21)"
            color="var(--text-secondary)"
            formula="reward = (userPoints / epochTotalPoints) × epoch budget"
            steps={[
              { label: 'Historical points', desc: 'Before the recognized-usage era, channels accrued raw settlement-delta points for buyers and sellers on the legacy Emissions contracts (V1 for epochs < 4, V2 for later epochs).' },
              { label: 'Unchanged and claimable', desc: 'Legacy-era points and claims remain available on the legacy contracts; nothing about the migration erased them.' },
              { label: 'Claim on the Claim ANTS tab', desc: 'The Legacy Epoch Breakdown table shows per-epoch points, rewards, and claim buttons — V1 for epochs < 4, V2 for later epochs.' },
            ]}
            notes={[
              'The locked legacy seller rewards pool (M002) additionally releases 10% of cumulative locked legacy ANTS per claim.',
            ]}
          />
        </div>

        {/* How to Earn */}
        <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>How to Earn</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
          <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
            <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>As a Seller</div>
            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>Register your seller agent, keep an eligible pool with epoch power, and serve settled requests to earn seller usage rewards.</div>
          </div>
          <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
            <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>As a Buyer</div>
            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>Deposit USDC and pay for AI services through the network. Settled volume earns buyer points — rewards are claimed by your deposits operator.</div>
          </div>
          <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
            <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>As a Staker</div>
            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>Lock ANTS into a seller pool to earn staker rewards on your lANTS position. Power activates the next epoch.</div>
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
      <span style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', minWidth: '200px' }}>{name}</span>
      <code style={{ fontSize: '0.8rem', color: 'var(--text-primary)', fontFamily: 'monospace' }}>{address}</code>
    </div>
  );
}

export default ANTSInfo;
