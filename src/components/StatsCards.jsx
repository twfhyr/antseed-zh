import React from 'react';
import { Users, Server, DollarSign, Zap, Info } from 'lucide-react';
import { useI18n } from '../i18n/index.jsx';

const icons = {
  buyers: Users,
  sellers: Server,
  services: Zap,
  volume: DollarSign,
};

const colors = {
  buyers: { bg: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6' },
  sellers: { bg: 'rgba(16, 185, 129, 0.15)', color: '#10b981' },
  services: { bg: 'rgba(6, 182, 212, 0.15)', color: '#06b6d4' },
  volume: { bg: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b' },
};

/** Any stat can legitimately be null — the backend returns null rather than
 *  fabricating a number when a real value isn't available yet. Render an
 *  em dash instead of crashing or inventing a zero. */
function fmtCount(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return Number(v).toLocaleString();
}

function fmtUsd(v) {
  // This was `$${stats.totalVolume.toLocaleString()}` with no guard, which
  // threw "Cannot read properties of null (reading 'toLocaleString')" and
  // blanked the entire Overview tab whenever volume hadn't been synced yet
  // (there is no error boundary above this component).
  if (v == null || Number.isNaN(Number(v))) return '—';
  return `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function StatsCards({ stats }) {
  const { t } = useI18n();
  if (!stats) return null;

  const cards = [
    { key: 'buyers', title: t('stats.totalBuyers'), value: fmtCount(stats.totalBuyers), tip: t('stats.totalBuyersTip') },
    { key: 'sellers', title: t('stats.totalSellers'), value: fmtCount(stats.totalSellers), tip: t('stats.totalSellersTip') },
    { key: 'services', title: t('stats.totalServices'), value: fmtCount(stats.totalServices), tip: t('stats.totalServicesTip') },
    { key: 'volume', title: t('stats.totalVolume'), value: fmtUsd(stats.totalVolume), tip: t('stats.totalVolumeTip') },
  ];

  return (
    <div className="stats-grid">
      {cards.map((card) => {
        const Icon = icons[card.key];
        const color = colors[card.key];
        return (
          <div key={card.key} className="stat-card">
            <div className="stat-header">
              <span className="stat-title">
                {card.title}
                {/* Custom CSS tooltip instead of the native `title`
                    attribute: native tooltips are slow (~1s hover delay),
                    tiny/easy to miss on a 13px icon, don't work on touch
                    devices at all, and (on top of that) lucide-react was
                    spreading `title` onto the inner <svg>, which Firefox
                    ignores outright. This renders instantly on hover/tap
                    and looks the same everywhere — see .stat-info-tooltip
                    in index.css. */}
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
  );
}

export default StatsCards;
