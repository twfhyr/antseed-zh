import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Loader2, Info, X } from 'lucide-react';
import { fetchHistoryBuyers, fetchEpochBuyers, fetchBuyerActivity } from '../api';
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

function fmtAnts(wei) {
  if (wei == null) return '—';
  return (Number(wei) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Sums two wei-string amounts (nullable) without precision loss. */
function sumWei(a, b) {
  if (a == null && b == null) return null;
  return ((a != null ? BigInt(a) : 0n) + (b != null ? BigInt(b) : 0n)).toString();
}

function num(v) {
  if (v == null) return '—';
  return Number(v).toLocaleString();
}

function fmtDate(unixSeconds) {
  if (!unixSeconds) return '—';
  return new Date(Number(unixSeconds) * 1000).toISOString().split('T')[0];
}

/** Used only in table column headers here, which sit at the top of
 *  `.table-container` (clips overflow for its rounded corners) — an
 *  upward-popping tooltip has nowhere to go there and gets cut off, so this
 *  always pops downward into the table body instead (see
 *  .stat-info-tooltip--below in index.css). */
function InfoTip({ text }) {
  return (
    <span className="stat-info-icon" tabIndex={0} style={{ marginLeft: '0.3rem' }}>
      <Info size={12} />
      <span className="stat-info-tooltip stat-info-tooltip--below" role="tooltip">{text}</span>
    </span>
  );
}

function ActivityRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}

/**
 * Every field here is real, already-synced Antscan data from the
 * `buyers_onchain` table (see backend/sync-history.js) -- the same table
 * the Total tab's row already came from, just the full row instead of the
 * curated handful of columns the table shows. Never fabricated: a field
 * Antscan hasn't populated shows as "—", and an address with no indexed
 * activity at all shows the notFound message rather than a table of zeros.
 */
function BuyerActivityModal({ address, onClose, t }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchBuyerActivity(address)
      .then((row) => { if (!cancelled) setData(row); })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [address]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('buyerActivity.title')} — {short(address)}</h2>
          <button type="button" className="modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          {loading ? (
            <div className="empty-state">{t('buyerActivity.loading')}</div>
          ) : error ? (
            <div className="empty-state">{t('buyerActivity.notFound')}</div>
          ) : (
            <>
              <ActivityRow label={t('table.spentUsdc')} value={usd(data.spent_usdc != null ? Number(data.spent_usdc) / 1e6 : null)} />
              <ActivityRow label={t('table.deposited')} value={usd(data.deposited_usdc != null ? Number(data.deposited_usdc) / 1e6 : null)} />
              <ActivityRow label={t('buyerActivity.withdrawnUsdc')} value={usd(data.withdrawn_usdc != null ? Number(data.withdrawn_usdc) / 1e6 : null)} />
              <ActivityRow label={t('table.requests')} value={num(data.request_count)} />
              <ActivityRow label={t('buyerActivity.inputTokens')} value={num(data.input_tokens)} />
              <ActivityRow label={t('buyerActivity.outputTokens')} value={num(data.output_tokens)} />
              <ActivityRow label={t('buyerActivity.channels')} value={num(data.channel_count)} />
              <ActivityRow label={t('buyerActivity.uniqueSellers')} value={num(data.unique_sellers)} />
              <ActivityRow label={t('table.firstSeen')} value={fmtDate(data.first_seen_at)} />
              <ActivityRow label={t('table.lastSeen')} value={fmtDate(data.last_seen_at)} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Buyers are soft-loaded a page at a time as the user scrolls, rather than
 * pulling all rows (and mounting that many table rows) on tab open. Search
 * is sent to the server so it matches across ALL buyers, not just the pages
 * fetched so far. Two sub-tabs share this pagination/scroll machinery:
 * "Epoch #N" (default — what most visitors care about, see
 * notes/epoch-features-plan.md) and "Total" (all-time).
 */
function BuyersList() {
  const { t } = useI18n();
  const [mode, setMode] = useState('epoch'); // 'epoch' | 'total'
  const [epochNumber, setEpochNumber] = useState(null);
  const [buyers, setBuyers] = useState([]);
  const [total, setTotal] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');   // debounced value actually sent
  const [loading, setLoading] = useState(true);      // first page / new search / mode switch
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const sentinelRef = useRef(null);
  // Guards against double-firing while a page request is in flight; state
  // updates are async, so `loadingMore` alone can let two fetches through.
  const inFlight = useRef(false);
  const [activeAddress, setActiveAddress] = useState(null); // row clicked -> activity modal

  const fetchPage = mode === 'epoch' ? fetchEpochBuyers : fetchHistoryBuyers;

  // Debounce typing so we don't issue a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  // Load the first page whenever the (debounced) search term or sub-tab changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPage({ limit: PAGE_SIZE, offset: 0, q: query })
      .then((page) => {
        if (cancelled) return;
        setBuyers(page.items || []);
        setTotal(page.total ?? null);
        setHasMore(Boolean(page.hasMore));
        if (page.epoch != null) setEpochNumber(page.epoch);
      })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query, mode]);

  const loadMore = useCallback(async () => {
    if (inFlight.current || loading || !hasMore) return;
    inFlight.current = true;
    setLoadingMore(true);
    try {
      const page = await fetchPage({
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
  }, [buyers.length, hasMore, loading, query, fetchPage]);

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
  const colSpan = mode === 'epoch' ? 6 : 5;
  const epochLabel = t('tabs.epoch', { n: epochNumber ?? '…' });

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
      <div style={{ display: 'flex', gap: '0.5rem', padding: '0 0 1rem' }}>
        <button type="button" className={`tab ${mode === 'epoch' ? 'active' : ''}`} onClick={() => setMode('epoch')}>
          {epochLabel}
        </button>
        <button type="button" className={`tab ${mode === 'total' ? 'active' : ''}`} onClick={() => setMode('total')}>
          {t('tabs.total')}
        </button>
      </div>
      <table className="table">
        <thead>
          {mode === 'epoch' ? (
            <tr>
              <th>{t('table.address')}</th>
              <th>{t('table.points')}<InfoTip text={t('table.pointsTip')} /></th>
              <th>{t('table.requests')}</th>
              <th>{t('table.stakingReward')}<InfoTip text={t('table.stakingRewardTip')} /></th>
              <th>{t('table.usageReward')}<InfoTip text={t('table.usageRewardTip')} /></th>
              <th>{t('table.potentialAnts')}<InfoTip text={t('table.potentialAntsTip')} /></th>
            </tr>
          ) : (
            <tr>
              <th>{t('table.address')}</th>
              <th>{t('table.spentUsdc')}</th>
              <th>{t('table.deposited')}</th>
              <th>{t('table.requests')}</th>
              <th>{t('table.firstSeen')}</th>
            </tr>
          )}
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={colSpan}><div className="empty-state">{t('common.loading')}</div></td></tr>
          ) : error ? (
            <tr><td colSpan={colSpan}><div className="empty-state">{error}</div></td></tr>
          ) : buyers.map((buyer) => (
            <tr key={buyer.address} onClick={() => setActiveAddress(buyer.address)} style={{ cursor: 'pointer' }} title={t('buyerActivity.hint')}>
              <td>
                <div className="user-cell">
                  <div className="avatar">{(buyer.address || '??').slice(2, 4).toUpperCase()}</div>
                  <div className="user-info">
                    <span className="user-name mono">{short(buyer.address)}</span>
                  </div>
                </div>
              </td>
              {mode === 'epoch' ? (
                <>
                  <td className="price">{usd(buyer.points != null ? Number(buyer.points) / 1e6 : null)}</td>
                  <td>{Number(buyer.requests || 0).toLocaleString()}</td>
                  <td>{fmtAnts(buyer.pool_reward_wei)}</td>
                  <td>{fmtAnts(buyer.usage_reward_wei)}</td>
                  <td className="price">{fmtAnts(sumWei(buyer.usage_reward_wei, buyer.pool_reward_wei))}</td>
                </>
              ) : (
                <>
                  <td className="price">{usd(Number(buyer.spent_usdc) / 1e6)}</td>
                  <td className="price">{usd(Number(buyer.deposited_usdc) / 1e6)}</td>
                  <td>{Number(buyer.request_count || 0).toLocaleString()}</td>
                  <td>{buyer.first_seen_at ? new Date(buyer.first_seen_at * 1000).toISOString().split('T')[0] : '—'}</td>
                </>
              )}
            </tr>
          ))}
          {!loading && !error && buyers.length === 0 && (
            <tr>
              <td colSpan={colSpan}>
                <div className="empty-state">{mode === 'epoch' ? t('table.noEpochData') : t('table.noBuyers')}</div>
              </td>
            </tr>
          )}
          {!loading && !error && loadingMore && (
            <tr>
              <td colSpan={colSpan}>
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
      {activeAddress && (
        <BuyerActivityModal address={activeAddress} onClose={() => setActiveAddress(null)} t={t} />
      )}
    </div>
  );
}

export default BuyersList;
