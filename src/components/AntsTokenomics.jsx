import React, { useEffect, useState } from 'react';
import { AlertTriangle, Info, Loader2, ShieldCheck } from 'lucide-react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { fetchTokenomics, fetchChainStats } from '../api';
import { useI18n } from '../i18n/index.jsx';

// Merged "ANTS & Tokenomics" tab — replaces the old separate TokenomicsTab.jsx
// and ANTSInfo.jsx, which both independently showed ANTS supply/allocation
// (one as pies, one as a flat list). See docs/PROTOCOL_SECTION_PLAN.md §2.
// Supply & Allocation below is TokenomicsTab's content, unchanged. Rewards &
// How It Works is ANTSInfo's *unique* content only — its own supply/epoch
// stat cards and flat allocation list are dropped as the actual duplication
// fix; that content now lives once, in Supply & Allocation.

function pct(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${n.toFixed(1)}%`;
}

function num(n, opts) {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString(undefined, opts);
}

// Compact form for large ANTS quantities (110,000,000 -> "110M", 1,040,000,000 -> "1.04B").
function compact(n) {
  if (n == null || Number.isNaN(n)) return '—';
  // Pinned to en-US: with an undefined locale this followed the browser, so
  // Chinese users saw myriad-based units ("10.4亿" instead of "1.04B") for
  // token supply. K/M/B are the conventional units for token amounts in both
  // languages, so force them regardless of UI language.
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
}

// Distinct, high-contrast palette — each category should be visually
// unambiguous even for adjacent slices, unlike a monochrome accent ramp.
const ALLOC_COLORS = ['#10B981', '#3B82F6', '#D79627', '#EC4899', '#8B5CF6', '#EF4444', '#06B6D4'];

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

function AllocationPieChart({ items }) {
  const chartData = items.map((item) => ({ name: item.name, value: item.sharePct || 0 }));
  return (
    <div style={{ width: '100%', height: 260 }}>
      <ResponsiveContainer>
        <PieChart>
          <Pie
            data={chartData}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            outerRadius={90}
            label={({ name, value }) => `${name} ${value.toFixed(0)}%`}
            labelLine
          >
            {chartData.map((entry, i) => (
              <Cell key={entry.name} fill={ALLOC_COLORS[i % ALLOC_COLORS.length]} stroke="var(--bg-card)" strokeWidth={2} />
            ))}
          </Pie>
          <Tooltip
            formatter={(value, name) => [`${value.toFixed(1)}%`, name]}
            contentStyle={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: '0.8125rem',
            }}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

function AllocationLegend({ items }) {
  return (
    <div style={{ display: 'grid', gap: '0.5rem', marginTop: '0.5rem' }}>
      {items.map((item, i) => (
        <div key={item.name} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8125rem' }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: ALLOC_COLORS[i % ALLOC_COLORS.length], flexShrink: 0 }} />
          <span style={{ textTransform: 'capitalize', flex: 1 }}>{item.name}</span>
          <strong>{pct(item.sharePct)}</strong>
        </div>
      ))}
    </div>
  );
}

// Emitted-so-far pie: legacy backlog vs current-epoch minting, each split
// into its own sub-categories (claimed/unclaimed, per minter bucket).
function EmittedPieChart({ legacySlices, currentSlices }) {
  const chartData = [...legacySlices, ...currentSlices].filter((d) => d.value > 0);
  const colors = chartData.map((d) => d.color);
  return (
    <div style={{ width: '100%', height: 280 }}>
      <ResponsiveContainer>
        <PieChart>
          <Pie
            data={chartData}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            innerRadius={50}
            outerRadius={95}
            label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
            labelLine
          >
            {chartData.map((entry, i) => (
              <Cell key={entry.name} fill={colors[i]} stroke="var(--bg-card)" strokeWidth={2} />
            ))}
          </Pie>
          <Tooltip
            formatter={(value, name) => [`${compact(value)} $ANTS`, name]}
            contentStyle={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: '0.8125rem',
            }}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

function SupplyAllocationTab({ t, data, error, loading, refreshing }) {
  if (loading) {
    return <div className="table-container"><div className="empty-state">{t('tokenomics.loading')}</div></div>;
  }
  if (error || !data) {
    return (
      <div className="table-container">
        <div className="empty-state" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'center' }}>
          <AlertTriangle size={20} />
          <span>{error || t('tokenomics.unavailable')}</span>
        </div>
      </div>
    );
  }

  const currentAllocation = data.currentAllocation || [];
  const legacyAllocation = data.legacyAllocation || [];
  const stake = data.dynamicShares?.stake;
  const usage = data.dynamicShares?.usage;
  const dist = data.distribution;

  const legacySlices = dist
    ? [
        { name: t('tokenomics.legacyEmittedClaimed'), value: dist.legacy.claimed || 0, color: '#0A6F4D' },
        { name: t('tokenomics.legacyEmittedRemaining'), value: dist.legacy.remainingInEscrow || 0, color: '#3DC799' },
      ]
    : [];
  const currentSlices = dist
    ? (dist.current.byMinter || []).map((m, i) => ({
        name: m.name,
        value: m.mintedAnts || 0,
        color: ['#D79627', '#EC4899', '#8B5CF6', '#EF4444', '#06B6D4'][i % 5],
      }))
    : [];

  return (
    <div style={{ display: 'grid', gap: '1.5rem' }}>
      {refreshing && (
        <span className="refresh-badge" title={t('tokenomics.refreshingHint')}>
          <Loader2 size={13} className="spin" />
          {t('tokenomics.refreshing')}
        </span>
      )}

      <div style={{
        display: 'flex', gap: '0.75rem', alignItems: 'flex-start',
        background: 'var(--clay-dim)', border: '1px solid rgba(215,150,39,0.3)',
        borderRadius: 'var(--radius-sm)', padding: '1rem 1.25rem',
      }}>
        <Info size={18} style={{ color: 'var(--clay)', flexShrink: 0, marginTop: 2 }} />
        <span style={{ fontSize: '0.875rem', lineHeight: 1.6 }}>{t('tokenomics.epochBanner')}</span>
      </div>

      <div className="tokenomics-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
        <div className="table-container" style={{ padding: '1.5rem' }}>
          <h3 style={{ fontSize: '1.0625rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--accent)' }}>
            {t('tokenomics.currentAllocation')}
          </h3>
          {currentAllocation.length > 0 ? (
            <>
              <AllocationPieChart items={currentAllocation} />
              <AllocationLegend items={currentAllocation} />
            </>
          ) : (
            <div className="empty-state">{t('tokenomics.unavailable')}</div>
          )}
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '1rem' }}>
            {t('tokenomics.dynamicNote')}
          </p>
        </div>

        <div className="table-container" style={{ padding: '1.5rem', opacity: 0.85 }}>
          <h3 style={{ fontSize: '1.0625rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>
            {t('tokenomics.legacyAllocation')}
          </h3>
          <AllocationPieChart items={legacyAllocation} />
          <AllocationLegend items={legacyAllocation} />
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '1rem' }}>
            {t('tokenomics.legacyNote')}
          </p>
        </div>
      </div>

      {dist && (
        <div className="table-container" style={{ padding: '1.5rem' }}>
          <h3 style={{ fontSize: '1.0625rem', fontWeight: 600, marginBottom: '0.25rem' }}>
            {t('tokenomics.emittedTitle')}
          </h3>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
            {t('tokenomics.emittedSubtitle')}
          </p>
          <EmittedPieChart legacySlices={legacySlices} currentSlices={currentSlices} />
          <div className="tokenomics-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginTop: '1rem' }}>
            <div>
              <div style={{ fontSize: '0.8125rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>
                {t('tokenomics.legacyEmitted')} — {compact(dist.legacy.scheduledTotal)}
              </div>
              <AllocationLegend items={legacySlices.map((s) => ({
                name: s.name,
                sharePct: dist.legacy.scheduledTotal ? (s.value / dist.legacy.scheduledTotal) * 100 : 0,
              }))} />
            </div>
            <div>
              <div style={{ fontSize: '0.8125rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--accent)' }}>
                {t('tokenomics.currentEmitted')} — {compact(dist.current.total)}
              </div>
              {currentSlices.some((s) => s.value > 0) ? (
                <AllocationLegend items={currentSlices.map((s) => ({
                  name: s.name,
                  sharePct: dist.current.total ? (s.value / dist.current.total) * 100 : 0,
                }))} />
              ) : (
                <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>{t('tokenomics.currentEmittedNote')}</div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="table-container" style={{ padding: '1.5rem' }}>
        <h3 style={{ fontSize: '1.0625rem', fontWeight: 600, marginBottom: '1rem' }}>{t('tokenomics.stakeData')}</h3>
        {stake ? (
          <div className="stats-grid" style={{ marginBottom: 0 }}>
            <div className="stat-card">
              <div className="stat-title">{t('tokenomics.totalActiveStake')}</div>
              <div className="stat-value">{compact(stake.totalActiveStakeAnts)}</div>
              <div className="stat-change" style={{ color: 'var(--clay)' }}>$ANTS</div>
            </div>
            <div className="stat-card">
              <div className="stat-title">{t('tokenomics.stakerShare')}</div>
              <div className="stat-value">{pct(stake.effectiveSharePct)}</div>
              <div className="stat-change">
                {t('tokenomics.stakerShareRange')}: {pct(stake.minSharePct)}–{pct(stake.maxSharePct)}
              </div>
            </div>
            {usage && (
              <div className="stat-card">
                <div className="stat-title">{t('tokenomics.buyerUsageShare')}</div>
                <div className="stat-value">{pct(usage.buyerEffectiveSharePct)}</div>
                <div className="stat-change">
                  {t('tokenomics.stakerShareRange')}: {pct(usage.buyerMinSharePct)}–{pct(usage.buyerMaxSharePct)}
                </div>
              </div>
            )}
            {usage && (
              <div className="stat-card">
                <div className="stat-title">{t('tokenomics.sellerUsageShare')}</div>
                <div className="stat-value">{pct(usage.sellerEffectiveSharePct)}</div>
                <div className="stat-change">
                  {t('tokenomics.stakerShareRange')}: {pct(usage.sellerMinSharePct)}–{pct(usage.sellerMaxSharePct)}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="empty-state">{t('tokenomics.unavailable')}</div>
        )}
        {usage && (usage.buyerEpochBudgetAnts != null || usage.sellerEpochBudgetAnts != null) && (
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '1rem' }}>
            {t('tokenomics.epochBudget', {
              buyer: usage.buyerEpochBudgetAnts != null ? compact(usage.buyerEpochBudgetAnts) : '—',
              seller: usage.sellerEpochBudgetAnts != null ? compact(usage.sellerEpochBudgetAnts) : '—',
            })}
          </p>
        )}
      </div>

      <div style={{ textAlign: 'center', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
        {data.fetchedAt && `Last verified on-chain: ${new Date(data.fetchedAt).toLocaleString()}`}
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

function ContractRow({ name, address }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', background: 'var(--bg-secondary)', padding: '0.75rem 1rem', borderRadius: '8px' }}>
      <span style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', minWidth: '200px' }}>{name}</span>
      <code style={{ fontSize: '0.8rem', color: 'var(--text-primary)', fontFamily: 'monospace' }}>{address}</code>
    </div>
  );
}

function RewardsMechanicsTab({ t, chainData, loading, error }) {
  if (loading) {
    return <div className="table-container"><div className="empty-state">{t('tokenomics.loading')}</div></div>;
  }
  if (error) {
    return (
      <div className="table-container">
        <div className="empty-state" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'center' }}>
          <AlertTriangle size={20} />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  const cd = chainData || {};
  const emissions = cd.emissions || {};
  const eraActive = emissions.effectiveEpoch != null;

  return (
    <div style={{ display: 'grid', gap: '1.5rem' }}>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
        {t('ants.sourceNote', { rpc: cd.rpcUrl || t('ants.publicRpc') })}
      </p>

      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem', color: 'var(--accent)', background: 'rgba(16,185,129,0.1)', padding: '0.5rem 0.75rem', borderRadius: '8px', border: '1px solid rgba(16,185,129,0.2)', width: 'fit-content' }}>
        <ShieldCheck size={14} />
        <span>{t('ants.verifiedBadge')}</span>
      </div>

      {eraActive && (
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '12px', padding: '1rem 1.25rem', fontSize: '0.875rem', lineHeight: 1.6 }}>
          <div style={{ fontWeight: 700, marginBottom: '0.25rem', color: 'var(--accent)' }}>
            {t('ants.eraBannerTitle', { epoch: emissions.effectiveEpoch })}
          </div>
          <div style={{ color: 'var(--text-secondary)' }}>
            {t('ants.eraBannerBody', { boundary: emissions.effectiveEpoch - 1 })}
          </div>
        </div>
      )}

      <div className="table-container" style={{ padding: '1.5rem' }}>
        <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>{t('ants.contractsTitle')}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {cd.contracts && Object.entries(cd.contracts).map(([key, addr]) => (
            addr ? <ContractRow key={key} name={CONTRACT_LABELS[key] || key} address={addr} /> : null
          ))}
        </div>
      </div>

      <div className="table-container" style={{ padding: '1.5rem' }}>
        <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>{t('ants.dynamicSharesTitle')}</h3>
        <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
          <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: '0.75rem' }}>
            {t('ants.dynamicSharesIntro')}
          </div>
          <div style={{ padding: '0.625rem 0.875rem', background: 'var(--bg-primary)', borderRadius: '8px', fontFamily: 'monospace', fontSize: '0.8125rem', marginBottom: '0.75rem' }}>
            {t('ants.shareFormula')}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.375rem 1rem', fontSize: '0.8125rem' }}>
            <span style={{ color: 'var(--accent)', fontWeight: 500 }}>{t('ants.shareStakerLabel')}</span>
            <span>{t('ants.shareStakerDesc')}</span>
            <span style={{ color: 'var(--info)', fontWeight: 500 }}>{t('ants.shareBuyerLabel')}</span>
            <span>{t('ants.shareBuyerDesc')}</span>
            <span style={{ color: 'var(--warning)', fontWeight: 500 }}>{t('ants.shareSellerLabel')}</span>
            <span>{t('ants.shareSellerDesc')}</span>
            <span style={{ fontWeight: 500 }}>{t('ants.shareRemainderLabel')}</span>
            <span>{t('ants.shareRemainderDesc')}</span>
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.75rem', lineHeight: 1.5 }}>
            {t('ants.dynamicSharesFooter')}
          </div>
        </div>
      </div>

      <div className="table-container" style={{ padding: '1.5rem' }}>
        <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>{t('ants.howEarnedTitle')}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <PointsSection
            title={t('ants.seller.title')}
            color="var(--warning)"
            formula={t('ants.seller.formula')}
            steps={[
              { label: t('ants.seller.step1Label'), desc: t('ants.seller.step1Desc') },
              { label: t('ants.seller.step2Label'), desc: t('ants.seller.step2Desc') },
              { label: t('ants.seller.step3Label'), desc: t('ants.seller.step3Desc') },
            ]}
            notes={[t('ants.seller.note1'), t('ants.seller.note2'), t('ants.seller.note3')]}
          />
          <PointsSection
            title={t('ants.buyer.title')}
            color="var(--info)"
            formula={t('ants.buyer.formula')}
            steps={[
              { label: t('ants.buyer.step1Label'), desc: t('ants.buyer.step1Desc') },
              { label: t('ants.buyer.step2Label'), desc: t('ants.buyer.step2Desc') },
              { label: t('ants.buyer.step3Label'), desc: t('ants.buyer.step3Desc') },
            ]}
            notes={[t('ants.buyer.note1'), t('ants.buyer.note2')]}
          />
          <PointsSection
            title={t('ants.staker.title')}
            color="var(--accent)"
            formula={t('ants.staker.formula')}
            steps={[
              { label: t('ants.staker.step1Label'), desc: t('ants.staker.step1Desc') },
              { label: t('ants.staker.step2Label'), desc: t('ants.staker.step2Desc') },
              { label: t('ants.staker.step3Label'), desc: t('ants.staker.step3Desc') },
            ]}
            notes={[t('ants.staker.note1'), t('ants.staker.note2')]}
          />
          <PointsSection
            title={t('ants.legacy.title')}
            color="var(--text-secondary)"
            formula={t('ants.legacy.formula')}
            steps={[
              { label: t('ants.legacy.step1Label'), desc: t('ants.legacy.step1Desc') },
              { label: t('ants.legacy.step2Label'), desc: t('ants.legacy.step2Desc') },
              { label: t('ants.legacy.step3Label'), desc: t('ants.legacy.step3Desc') },
            ]}
            notes={[t('ants.legacy.note1')]}
          />
        </div>
      </div>

      <div className="table-container" style={{ padding: '1.5rem' }}>
        <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>{t('ants.howToEarnTitle')}</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
          <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
            <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>{t('ants.earnSeller.title')}</div>
            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('ants.earnSeller.desc')}</div>
          </div>
          <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
            <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>{t('ants.earnBuyer.title')}</div>
            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('ants.earnBuyer.desc')}</div>
          </div>
          <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
            <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>{t('ants.earnStaker.title')}</div>
            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('ants.earnStaker.desc')}</div>
          </div>
          <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
            <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>{t('ants.earnReserve.title')}</div>
            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('ants.earnReserve.desc')}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AntsTokenomics({ defaultSubTab = 'supply' }) {
  const { t } = useI18n();
  const [subTab, setSubTab] = useState(defaultSubTab);

  const [tkData, setTkData] = useState(null);
  const [tkError, setTkError] = useState(null);
  const [tkRefreshing, setTkRefreshing] = useState(false);
  const [tkLoading, setTkLoading] = useState(true);

  const [chainData, setChainData] = useState(null);
  const [chainLoading, setChainLoading] = useState(true);
  const [chainError, setChainError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    // The server replies immediately from its cache, marking the payload
    // `stale` while it refreshes from chain in the background (a cold chain
    // read takes ~40s). Render those real-but-slightly-old numbers right
    // away, then poll for the refreshed version instead of blocking the
    // whole page on it.
    fetchTokenomics()
      .then((d) => {
        if (cancelled) return;
        setTkData(d);
        setTkLoading(false);
        if (d?.stale) setTkRefreshing(true);
      })
      .catch((e) => { if (!cancelled) { setTkError(e.message); setTkLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!tkRefreshing) return;
    let cancelled = false;
    let attempts = 0;
    const id = setInterval(async () => {
      attempts += 1;
      if (attempts > 24) { setTkRefreshing(false); clearInterval(id); return; }
      try {
        const d = await fetchTokenomics();
        if (cancelled) return;
        setTkData(d);
        if (!d?.stale) { setTkRefreshing(false); clearInterval(id); }
      } catch { /* keep the stale data on screen and retry */ }
    }, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [tkRefreshing]);

  useEffect(() => {
    let cancelled = false;
    fetchChainStats()
      .then((d) => { if (!cancelled) { setChainData(d); setChainError(null); } })
      .catch((e) => { if (!cancelled) setChainError(e.message); })
      .finally(() => { if (!cancelled) setChainLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div style={{ display: 'grid', gap: '1.5rem', maxWidth: 1100, margin: '0 auto' }}>
      <div>
        <h2 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.25rem' }}>
          {t('antsTokenomics.title')}
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9375rem' }}>{t('antsTokenomics.subtitle')}</p>
      </div>

      {/* Shared summary strip — shown once, not duplicated per sub-tab. */}
      {tkData && (
        <div className="stats-grid" style={{ marginBottom: 0 }}>
          <div className="stat-card">
            <div className="stat-title">{t('tokenomics.currentEpoch')}</div>
            <div className="stat-value">{tkData.currentEpoch ?? '—'}</div>
          </div>
          <div className="stat-card">
            <div className="stat-title">{t('tokenomics.totalSupply')}</div>
            <div className="stat-value" title={num(tkData.supply?.totalSupply, { maximumFractionDigits: 0 })}>
              {compact(tkData.supply?.totalSupply)}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-title">{t('tokenomics.maxSupply')}</div>
            <div className="stat-value" title={num(tkData.supply?.maxSupply, { maximumFractionDigits: 0 })}>
              {compact(tkData.supply?.maxSupply)}
            </div>
          </div>
        </div>
      )}

      <div className="tabs" style={{ width: 'fit-content' }}>
        <button type="button" className={`tab ${subTab === 'supply' ? 'active' : ''}`} onClick={() => setSubTab('supply')}>
          {t('antsTokenomics.subtabSupply')}
        </button>
        <button type="button" className={`tab ${subTab === 'rewards' ? 'active' : ''}`} onClick={() => setSubTab('rewards')}>
          {t('antsTokenomics.subtabRewards')}
        </button>
      </div>

      {subTab === 'supply' && (
        <SupplyAllocationTab t={t} data={tkData} error={tkError} loading={tkLoading} refreshing={tkRefreshing} />
      )}
      {subTab === 'rewards' && (
        <RewardsMechanicsTab t={t} chainData={chainData} loading={chainLoading} error={chainError} />
      )}
    </div>
  );
}

export default AntsTokenomics;
