import React, { useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend,
} from 'recharts';
import { useI18n } from '../i18n/index.jsx';

const COLORS = {
  buyers: '#3b82f6',
  sellers: '#10b981',
  volume: '#f59e0b',
};

function compactNumber(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

function CustomTooltip({ active, payload, label, volumeLabel, buyersLabel, sellersLabel }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: 'var(--card-bg, #1a1d23)', border: '1px solid var(--border, #2a2d35)',
      borderRadius: 8, padding: '0.6rem 0.8rem', fontSize: '0.8rem',
    }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ color: p.color }}>
          {p.dataKey === 'volume' ? `${volumeLabel}: $${compactNumber(p.value)}` : null}
          {p.dataKey === 'buyers' ? `${buyersLabel}: ${p.value?.toLocaleString?.() ?? p.value}` : null}
          {p.dataKey === 'sellers' ? `${sellersLabel}: ${p.value?.toLocaleString?.() ?? p.value}` : null}
        </div>
      ))}
    </div>
  );
}

/** Dune-style combo chart: buyers/sellers as bars (left axis), volume as a
 *  line (right axis), sharing one x-axis (day or epoch). Exported so
 *  EpochDailyChart.jsx (the Overview epoch sub-tab's day-within-this-epoch
 *  view) can reuse the exact same chart look instead of duplicating it. */
export function BreakdownChart({ data, xKey }) {
  const { t } = useI18n();
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border, #2a2d35)" vertical={false} />
        <XAxis
          dataKey={xKey}
          tick={{ fontSize: 11, fill: 'var(--text-secondary, #888)' }}
          axisLine={{ stroke: 'var(--border, #2a2d35)' }}
          tickLine={false}
        />
        <YAxis
          yAxisId="left"
          tick={{ fontSize: 11, fill: 'var(--text-secondary, #888)' }}
          axisLine={false}
          tickLine={false}
          width={36}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          tick={{ fontSize: 11, fill: 'var(--text-secondary, #888)' }}
          axisLine={false}
          tickLine={false}
          tickFormatter={compactNumber}
          width={44}
        />
        <Tooltip
          content={(
            <CustomTooltip
              volumeLabel={t('overview.volume')}
              buyersLabel={t('overview.buyers')}
              sellersLabel={t('overview.sellers')}
            />
          )}
          cursor={{ fill: 'rgba(255,255,255,0.04)' }}
        />
        <Legend wrapperStyle={{ fontSize: '0.8rem' }} />
        <Bar yAxisId="left" dataKey="buyers" name={t('overview.buyers')} fill={COLORS.buyers} radius={[3, 3, 0, 0]} maxBarSize={22} />
        <Bar yAxisId="left" dataKey="sellers" name={t('overview.sellers')} fill={COLORS.sellers} radius={[3, 3, 0, 0]} maxBarSize={22} />
        <Line yAxisId="right" type="monotone" dataKey="volume" name={t('overview.volume')} stroke={COLORS.volume} strokeWidth={2} dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Renders the three distinct states a series can be in. Previously every
 *  non-populated state fell through to "loading", so a failed request showed
 *  a spinner message forever. Exported for the same reason as BreakdownChart
 *  above. */
export function ChartState({ data, error, xKey, t }) {
  if (error) return <div className="empty-state">{t('overview.error')}</div>;
  if (data == null) return <div className="empty-state">{t('overview.loading')}</div>;
  if (data.length === 0) return <div className="empty-state">{t('overview.empty')}</div>;
  return <BreakdownChart data={data} xKey={xKey} />;
}

/** Total sub-tab's chart (Overview.jsx): all-time daily series, or an
 *  all-epochs aggregate (one bar per epoch, epoch 0 through the current
 *  one) — NOT the current epoch's own day-by-day breakdown, which is a
 *  different view (EpochDailyChart.jsx, under Overview's Epoch sub-tab). */
function HistoryCharts({ daily, epochs, dailyError, epochsError }) {
  const { t } = useI18n();
  const [tab, setTab] = useState('day');

  // Use null (not 0) when a value is genuinely unknown: recharts renders a
  // gap for null, whereas `?? 0` drew a real-looking zero bar. That mattered
  // for the per-epoch view, where the backend stores null for participant
  // counts it couldn't resolve — plotting those as 0 next to a non-zero
  // volume line implied volume had been transacted by nobody.
  const num = (v) => (v == null ? null : Number(v));
  const usdc = (v) => (v == null ? null : Number(v) / 1e6);

  const dailyData = daily == null ? null : daily.map((d) => ({
    label: d.day?.slice(5) ?? d.day,
    buyers: num(d.active_buyers),
    sellers: num(d.active_sellers),
    volume: usdc(d.volume_usdc),
  }));

  const epochData = epochs == null ? null : epochs.map((e) => ({
    label: `#${e.epoch}`,
    buyers: num(e.active_buyers),
    sellers: num(e.active_sellers),
    volume: usdc(e.volume_usdc),
  }));

  return (
    <div className="table-container" style={{ padding: '1.25rem 1.5rem', marginBottom: '1.5rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        <button
          type="button"
          className={`tab ${tab === 'day' ? 'active' : ''}`}
          onClick={() => setTab('day')}
        >
          {t('overview.byDay')}
        </button>
        <button
          type="button"
          className={`tab ${tab === 'epoch' ? 'active' : ''}`}
          onClick={() => setTab('epoch')}
        >
          {t('overview.byEpoch')}
        </button>
      </div>
      {tab === 'day' && <ChartState data={dailyData} error={dailyError} xKey="label" t={t} />}
      {tab === 'epoch' && <ChartState data={epochData} error={epochsError} xKey="label" t={t} />}
      <div style={{ marginTop: '0.75rem', fontSize: '0.78rem', color: 'var(--text-secondary, #888)' }}>
        {tab === 'day' ? t('overview.dayNote') : t('overview.epochNote')}
      </div>
    </div>
  );
}

export default HistoryCharts;
