import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { fetchHistoryBuyers } from '../api';
import { useI18n } from '../i18n/index.jsx';

const PAGE_SIZE = 100;

function short(addr) {
  if (!addr) return '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function usd(v) {
  if (v == null) return '—';
  return `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/**
 * Buyers are soft-loaded a page at a time as the user scrolls, rather than
 * pulling all ~1150 rows (and mounting ~1150 table rows) on tab open.
 * Search is sent to the server so it matches across ALL buyers, not just the
 * pages fetched so far.
 */
function BuyersList() {
  const { t } = useI18n();
  const [buyers, setBuyers] = useState([]);
  const [total, setTotal] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');   // debounced value actually sent
  const [loading, setLoading] = useState(true);      // first page / new search
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const sentinelRef = useRef(null);
  // Guards against double-firing while a page request is in flight; state
  // updates are async, so `loadingMore` alone can let two fetches through.
  const inFlight = useRef(false);

  // Debounce typing so we don't issue a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  // Load the first page whenever the (debounced) search term changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchHistoryBuyers({ limit: PAGE_SIZE, offset: 0, q: query })
      .then((page) => {
        if (cancelled) return;
        setBuyers(page.items || []);
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
      const page = await fetchHistoryBuyers({
        limit: PAGE_SIZE,
        offset: buyers.length,
        q: query,
      });
      setBuyers((prev) => {
        // De-dupe defensively: if a sync rewrites rows between pages, the
        // same address could otherwise appear twice and break React keys.
        const seen = new Set(prev.map((b) => b.address));
        return [...prev, ...(page.items || []).filter((b) => !seen.has(b.address))];
      });
      setTotal(page.total ?? null);
      setHasMore(Boolean(page.hasMore));
    } catch (e) {
      setError(e.message);
      setHasMore(false); // stop retrying on every scroll event
    } finally {
      inFlight.current = false;
      setLoadingMore(false);
    }
  }, [buyers.length, hasMore, loading, query]);

  // Infinite scroll via IntersectionObserver on a sentinel row.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadMore(); },
      { rootMargin: '300px' }, // start fetching before it's actually visible
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, hasMore]);

  const shown = buyers.length;

  return (
    <div className="table-container">
      <div className="table-header">
        <h2 className="table-title">
          {t('nav.buyers')}{' '}
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
      <table className="table">
        <thead>
          <tr>
            <th>{t('table.address')}</th>
            <th>{t('table.spentUsdc')}</th>
            <th>{t('table.deposited')}</th>
            <th>{t('table.requests')}</th>
            <th>{t('table.firstSeen')}</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan="5"><div className="empty-state">{t('common.loading')}</div></td></tr>
          ) : error ? (
            <tr><td colSpan="5"><div className="empty-state">{error}</div></td></tr>
          ) : buyers.map((buyer) => (
            <tr key={buyer.address}>
              <td>
                <div className="user-cell">
                  <div className="avatar">{(buyer.address || '??').slice(2, 4).toUpperCase()}</div>
                  <div className="user-info">
                    <span className="user-name mono">{short(buyer.address)}</span>
                  </div>
                </div>
              </td>
              <td className="price">{usd(Number(buyer.spent_usdc) / 1e6)}</td>
              <td className="price">{usd(Number(buyer.deposited_usdc) / 1e6)}</td>
              <td>{Number(buyer.request_count || 0).toLocaleString()}</td>
              <td>{buyer.first_seen_at ? new Date(buyer.first_seen_at * 1000).toISOString().split('T')[0] : '—'}</td>
            </tr>
          ))}
          {!loading && !error && buyers.length === 0 && (
            <tr>
              <td colSpan="5">
                <div className="empty-state">{t('table.noBuyers')}</div>
              </td>
            </tr>
          )}
          {!loading && !error && loadingMore && (
            <tr>
              <td colSpan="5">
                <div className="empty-state loading-row">
                  <Loader2 size={15} className="spin" />
                  {t('table.loadingMore')}
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {/* Scroll sentinel — observed to trigger the next page. */}
      {!loading && !error && hasMore && <div ref={sentinelRef} style={{ height: 1 }} />}
    </div>
  );
}

export default BuyersList;
