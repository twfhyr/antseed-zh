import React, { useEffect, useState } from 'react';
import { Users, Server, DollarSign, Info, Clock } from 'lucide-react';
import { useI18n } from '../i18n/index.jsx';

const icons = { buyers: Users, sellers: Server, volume: DollarSign, remaining: Clock };
const colors = {
  buyers: { bg: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6' },
  sellers: { bg: 'rgba(16, 185, 129, 0.15)', color: '#10b981' },
  volume: { bg: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b' },
  remaining: { bg: 'rgba(139, 92, 246, 0.15)', color: '#8b5cf6' },
};

/**
 * Break a duration in seconds into d/h/m/s parts.
 * Returns null for a non-finite or already-elapsed duration so the caller
 * can render "ending" / `—` instead of a negative clock.
 */
function splitDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return null;
  const s = Math.floor(totalSeconds);
  return {
    days: Math.floor(s / 86400),
    hours: Math.floor((s % 86400) / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60,
  };
}

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
  // Re-render once a second so the countdown actually counts down. Driven by
  // wall-clock time against the epoch's real on-chain endTs — never a locally
  // decremented counter, which would drift and would keep "ticking" from a
  // stale value if the tab slept.
  const [now, setNow] = useState(() => Date.now());
  const endTs = Number(epoch?.endTs);
  const hasEnd = Number.isFinite(endTs) && endTs > 0;

  useEffect(() => {
    if (!hasEnd) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasEnd]);

  if (!epoch) return null;

  const remaining = hasEnd ? splitDuration(endTs - now / 1000) : null;
  // `endTs` is a real value from /api/stats (epoch start + on-chain epoch
  // duration), so this is a genuine countdown. Missing/elapsed renders a
  // label, never a fabricated placeholder time.
  const remainingText = !hasEnd
    ? '—'
    : remaining === null
      ? t('overview.epochEnding')
      : remaining.days > 0
        ? `${remaining.days}d ${remaining.hours}h ${remaining.minutes}m`
        : `${remaining.hours}h ${remaining.minutes}m ${remaining.seconds}s`;

  const cards = [
    { key: 'buyers', title: t('overview.epochBuyers'), value: fmtCount(epoch.buyers), tip: t('overview.epochBuyersTip') },
    { key: 'sellers', title: t('overview.epochSellers'), value: fmtCount(epoch.sellers), tip: t('overview.epochSellersTip') },
    { key: 'volume', title: t('overview.epochVolume'), value: fmtUsd(epoch.volumeUsdc), tip: t('overview.epochVolumeTip') },
    {
      key: 'remaining',
      title: t('overview.epochRemaining'),
      value: remainingText,
      tip: t('overview.epochRemainingTip'),
      // Monospace + fixed tabular digits stop the card jittering as the
      // seconds digit changes width.
      mono: hasEnd && remaining !== null,
      sub: hasEnd ? new Date(endTs * 1000).toLocaleString() : null,
    },
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
              <div
                className="stat-value"
                style={card.mono ? { fontVariantNumeric: 'tabular-nums' } : undefined}
              >
                {card.value}
              </div>
              {card.sub && (
                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                  {t('overview.epochEndsAt', { time: card.sub })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default EpochStatsCards;
