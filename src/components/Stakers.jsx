import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { fetchStakers } from '../api';
import { useI18n } from '../i18n/index.jsx';

const PAGE_SIZE = 100;

function short(addr) {
  if (!addr) return '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatAnts(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatLockDays(days) {
  if (days == null) return '—';
  return days === 1 ? '1 day' : `${days.toLocaleString()} days`;
}

/**
 * Stakers, one row per (address, lock length) -- the same lANTS positions
 * the lANTS marketplace tab lists NFT-by-NFT (each position IS a lANTS
 * NFT), just shown staker-first instead of NFT-first: two positions from
 * the same address locked for the same duration (even in different
 * sellers' pools) are combined into one row server-side, since from that
 * address's point of view they're the same kind of commitment. See
 * backend/server.js's computeStakers().
 */
function Stakers() {
  const { t } = useI18n();
  const [stakers, setStakers] = useState([]);
  const [total, setTotal] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const sentinelRef = useRef(null);
  const inFlight = useRef(false);

  useEffect(() => {
    const id = setTimeout(() => setQuery(search.trim().toLowerCase()), 300);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchStakers({ limit: PAGE_SIZE, offset: 0, q: query })
      .then((page) => {
        if (cancelled) return;
        setStakers(page.items || []);
        setTotal(page.total ?? null);
        setHasMore(Boolean(page.hasMore));
      })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query]);

  const loadMore = useCallback(async () => {
    if (inFlight.current || loading || !hasMore) return;
    inFlight.current = true;
    setLoadingMore(true);
    try {
      const page = await fetchStakers({ limit: PAGE_SIZE, offset: stakers.length, q: query });
      setStakers((prev) => {
        const seen = new Set(prev.map((s) => `${s.address}|${s.lockDays}`));
        return [...prev, ...(page.items || []).filter((s) => !seen.has(`${s.address}|${s.lockDays}`))];
      });
      setTotal(page.total ?? null);
      setHasMore(Boolean(page.hasMore));
    } catch (e) {
      setError(e.message);
      setHasMore(false);
    } finally {
      inFlight.current = false;
      setLoadingMore(false);
    }
  }, [stakers.length, hasMore, loading, query]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadMore(); },
      { rootMargin: '300px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, hasMore]);

  const shown = stakers.length;

  return (
    <div className="table-container">
      <div className="table-header">
        <h2 className="table-title">
          {t('nav.stakers')}{' '}
          {total != null && (
            <span className="table-count">
              {shown < total ? t('table.showingOf', { shown, total }) : total.toLocaleString()}
            </span>
          )}
        </h2>
        <div className="search-box">
          <Search size={16} className="search-icon" />
          <input
            type="text"
            placeholder={t('table.searchAddress')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem', padding: '0 0 1rem' }}>
        {t('stakers.blurb')}
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>{t('table.address')}</th>
            <th>{t('stakers.amountStaked')}</th>
            <th>{t('stakers.lockedFor')}</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={3}><div className="empty-state">{t('common.loading')}</div></td></tr>
          ) : error ? (
            <tr><td colSpan={3}><div className="empty-state">{error}</div></td></tr>
          ) : stakers.map((s) => (
            <tr key={`${s.address}|${s.lockDays}`}>
              <td>
                <div className="user-cell">
                  <div className="avatar">{(s.address || '??').slice(2, 4).toUpperCase()}</div>
                  <div className="user-info">
                    <span className="user-name mono">{short(s.address)}</span>
                  </div>
                </div>
              </td>
              <td className="price">{formatAnts(s.amount)} ANTS</td>
              <td>{formatLockDays(s.lockDays)}</td>
            </tr>
          ))}
          {!loading && !error && stakers.length === 0 && (
            <tr><td colSpan={3}><div className="empty-state">{t('stakers.noStakers')}</div></td></tr>
          )}
          {!loading && !error && loadingMore && (
            <tr>
              <td colSpan={3}>
                <div className="empty-state loading-row">
                  <Loader2 size={15} className="spin" />
                  {t('table.loadingMore')}
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {!loading && !error && hasMore && <div ref={sentinelRef} style={{ height: 1 }} />}
    </div>
  );
}

export default Stakers;
