import React from 'react';
import { Users, Server, DollarSign, Info } from 'lucide-react';
import { useI18n } from '../i18n/index.jsx';

const icons = { buyers: Users, sellers: Server, volume: DollarSign };
const colors = {
  buyers: { bg: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6' },
  sellers: { bg: 'rgba(16, 185, 129, 0.15)', color: '#10b981' },
  volume: { bg: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b' },
};

function fmtCount(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return Number(v).toLocaleString();
}

function fmtUsd(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/** Current-epoch counterpart to StatsCards — buyers/sellers/volume for the
 *  still-open current epoch, not all-time. No services card: services have
 *  no per-epoch data source (they're a live catalog snapshot, not a
 *  settlement ledger) — see notes/epoch-features-plan.md. Rendered under
 *  Overview's own "Epoch #N" tab, which already labels it — no internal
 *  heading here to avoid saying "Epoch #N" twice on screen. */
function EpochStatsCards({ epoch }) {
  const { t } = useI18n();
  if (!epoch) return null;

  const cards = [
    { key: 'buyers', title: t('overview.epochBuyers'), value: fmtCount(epoch.buyers), tip: t('overview.epochBuyersTip') },
    { key: 'sellers', title: t('overview.epochSellers'), value: fmtCount(epoch.sellers), tip: t('overview.epochSellersTip') },
    { key: 'volume', title: t('overview.epochVolume'), value: fmtUsd(epoch.volumeUsdc), tip: t('overview.epochVolumeTip') },
  ];

  return (
    <div style={{ marginBottom: '0.5rem' }}>
      <div className="stats-grid">
        {cards.map((card) => {
          const Icon = icons[card.key];
          const color = colors[card.key];
          return (
            <div key={card.key} className="stat-card">
              <div className="stat-header">
                <span className="stat-title">
                  {card.title}
                  <span className="stat-info-icon" tabIndex={0}>
                    <Info size={13} />
                    <span className="stat-info-tooltip" role="tooltip">{card.tip}</span>
                  </span>
                </span>
                <div className="stat-icon" style={{ background: color.bg }}>
                  <Icon size={20} color={color.color} />
                </div>
              </div>
              <div className="stat-value">{card.value}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default EpochStatsCards;
