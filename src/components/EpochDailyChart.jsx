import React from 'react';
import { ChartState } from './HistoryCharts';
import { useI18n } from '../i18n/index.jsx';

const num = (v) => (v == null ? null : Number(v));
const usdc = (v) => (v == null ? null : Number(v) / 1e6);

/** Overview's Epoch sub-tab chart: day-by-day breakdown of *just* the
 *  current epoch's ~7-day window — not an all-epochs aggregate (that's
 *  HistoryCharts.jsx's "By Epoch" view, which lives under the Total
 *  sub-tab instead). Filters the same `daily` series Overview already
 *  fetches down to [startTs, endTs) from the epoch's real on-chain
 *  genesis/duration (see backend/server.js `currentEpochOverview`) rather
 *  than a separate fetch. */
function EpochDailyChart({ daily, dailyError, startTs, endTs }) {
  const { t } = useI18n();

  const inRange = (dayStart) => startTs != null && endTs != null && dayStart >= startTs && dayStart < endTs;

  const data = daily == null
    ? null
    : startTs == null || endTs == null
      ? [] // epoch range not resolved yet — show "no data" rather than the whole history
      : daily.filter((d) => inRange(Number(d.day_start))).map((d) => ({
          label: d.day?.slice(5) ?? d.day,
          buyers: num(d.active_buyers),
          sellers: num(d.active_sellers),
          volume: usdc(d.volume_usdc),
        }));

  return (
    <div className="table-container" style={{ padding: '1.25rem 1.5rem', marginBottom: '1.5rem' }}>
      <ChartState data={data} error={dailyError} xKey="label" t={t} />
      <div style={{ marginTop: '0.75rem', fontSize: '0.78rem', color: 'var(--text-secondary, #888)' }}>
        {t('overview.epochDailyNote')}
      </div>
    </div>
  );
}

export default EpochDailyChart;
