import React, { useEffect, useState } from 'react';
import StatsCards from './StatsCards';
import EpochStatsCards from './EpochStatsCards';
import HistoryCharts from './HistoryCharts';
import EpochDailyChart from './EpochDailyChart';
import { fetchStats, fetchHistoryDaily, fetchHistoryEpochs } from '../api';
import { useI18n } from '../i18n/index.jsx';

function Overview() {
  const { t } = useI18n();
  const [mode, setMode] = useState('epoch'); // 'epoch' | 'total' — epoch first, matches Buyers/Sellers
  const [stats, setStats] = useState(null);
  const [daily, setDaily] = useState(null);
  const [epochs, setEpochs] = useState(null);
  const [error, setError] = useState(null);
  // The history fetches used to swallow failures with `.catch(() => {})`,
  // leaving state at null — which the chart rendered as "loading" forever
  // with nothing in the console. Track the failure and surface it instead.
  const [dailyError, setDailyError] = useState(null);
  const [epochsError, setEpochsError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchStats()
      .then((s) => { if (!cancelled) setStats(s); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    fetchHistoryDaily(60)
      .then((d) => { if (!cancelled) setDaily(d ?? []); })
      .catch((e) => { if (!cancelled) { console.error('history/daily failed', e); setDailyError(e.message || String(e)); } });
    fetchHistoryEpochs(30)
      .then((e) => { if (!cancelled) setEpochs(e ?? []); })
      .catch((e) => { if (!cancelled) { console.error('history/epochs failed', e); setEpochsError(e.message || String(e)); } });
    return () => { cancelled = true; };
  }, []);

  const epochLabel = t('tabs.epoch', { n: stats?.currentEpoch?.epoch ?? '…' });

  return (
    <div>
      {error && <div className="table-container" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}><div className="empty-state">{error}</div></div>}
      {/* Epoch vs. Total used to render stacked on top of each other, which
          made it unclear which numbers were which. Two tabs now, matching
          the same Epoch/Total pattern as the Buyers and Sellers tabs. */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        <button type="button" className={`tab ${mode === 'epoch' ? 'active' : ''}`} onClick={() => setMode('epoch')}>
          {epochLabel}
        </button>
        <button type="button" className={`tab ${mode === 'total' ? 'active' : ''}`} onClick={() => setMode('total')}>
          {t('tabs.total')}
        </button>
      </div>
      {mode === 'epoch' ? (
        <>
          {stats?.currentEpoch && <EpochStatsCards epoch={stats.currentEpoch} />}
          <EpochDailyChart
            daily={daily}
            dailyError={dailyError}
            startTs={stats?.currentEpoch?.startTs}
            endTs={stats?.currentEpoch?.endTs}
          />
        </>
      ) : (
        <>
          {stats && <StatsCards stats={stats} />}
          <HistoryCharts daily={daily} epochs={epochs} dailyError={dailyError} epochsError={epochsError} />
        </>
      )}
    </div>
  );
}

export default Overview;
