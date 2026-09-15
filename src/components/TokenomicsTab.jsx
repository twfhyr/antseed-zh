import React, { useEffect, useState } from 'react';
import { AlertTriangle, Info, Loader2 } from 'lucide-react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { fetchTokenomics } from '../api';
import { useI18n } from '../i18n/index.jsx';

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

function TokenomicsTab() {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

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
        setData(d);
        setLoading(false);
        if (d?.stale) setRefreshing(true);
      })
      .catch((e) => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  // While the backend is refreshing, poll until it reports fresh data.
  useEffect(() => {
    if (!refreshing) return;
    let cancelled = false;
    let attempts = 0;
    const id = setInterval(async () => {
      attempts += 1;
      // ~40s per chain read; give up after 2 min rather than polling forever.
      if (attempts > 24) { setRefreshing(false); clearInterval(id); return; }
      try {
        const d = await fetchTokenomics();
        if (cancelled) return;
        setData(d);
        if (!d?.stale) { setRefreshing(false); clearInterval(id); }
      } catch { /* keep the stale data on screen and retry */ }
    }, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [refreshing]);

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
    <div style={{ display: 'grid', gap: '1.5rem', maxWidth: 1100, margin: '0 auto' }}>
      <div>
        <h2 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          {t('tokenomics.title')}
          {refreshing && (
            <span className="refresh-badge" title={t('tokenomics.refreshingHint')}>
              <Loader2 size={13} className="spin" />
              {t('tokenomics.refreshing')}
            </span>
          )}
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9375rem' }}>{t('tokenomics.subtitle')}</p>
      </div>

      <div style={{
        display: 'flex', gap: '0.75rem', alignItems: 'flex-start',
        background: 'var(--clay-dim)', border: '1px solid rgba(215,150,39,0.3)',
        borderRadius: 'var(--radius-sm)', padding: '1rem 1.25rem',
      }}>
        <Info size={18} style={{ color: 'var(--clay)', flexShrink: 0, marginTop: 2 }} />
        <span style={{ fontSize: '0.875rem', lineHeight: 1.6 }}>{t('tokenomics.epochBanner')}</span>
      </div>

      <div className="stats-grid" style={{ marginBottom: 0 }}>
        <div className="stat-card">
          <div className="stat-title">{t('tokenomics.currentEpoch')}</div>
          <div className="stat-value">{data.currentEpoch ?? '—'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-title">{t('tokenomics.totalSupply')}</div>
          <div className="stat-value" title={num(data.supply?.totalSupply, { maximumFractionDigits: 0 })}>
            {compact(data.supply?.totalSupply)}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-title">{t('tokenomics.maxSupply')}</div>
          <div className="stat-value" title={num(data.supply?.maxSupply, { maximumFractionDigits: 0 })}>
            {compact(data.supply?.maxSupply)}
          </div>
        </div>
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
                <div className="stat-title">Usage rewards share (seller)</div>
                <div className="stat-value">{pct(usage.sellerMinSharePct)}–{pct(usage.sellerMaxSharePct)}</div>
                <div className="stat-change">buyer: {pct(usage.buyerMinSharePct)}–{pct(usage.buyerMaxSharePct)}</div>
              </div>
            )}
          </div>
        ) : (
          <div className="empty-state">{t('tokenomics.unavailable')}</div>
        )}
      </div>

      <div style={{ textAlign: 'center', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
        {data.fetchedAt && `Last verified on-chain: ${new Date(data.fetchedAt).toLocaleString()}`}
      </div>
    </div>
  );
}

export default TokenomicsTab;
