import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Loader2, Info } from 'lucide-react';
import { fetchEpochSellers } from '../api';
import { useI18n } from '../i18n/index.jsx';

const PAGE_SIZE = 100;

/** The indexer exposes a status string; treat only an explicit "online" as
 *  online so an unknown/missing value degrades to offline rather than
 *  claiming a node is up. */
function isOnline(seller) {
  return String(seller?.status || '').toLowerCase() === 'online';
}

const PINNED_SELLER_ID = 'seller_412282c48584073c5aee6a79945f105a7777e194';
const PINNED_ADDRESS = '0x412282c48584073c5aee6a79945f105a7777e194';

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

function sumWei(a, b) {
  if (a == null && b == null) return null;
  return ((a != null ? BigInt(a) : 0n) + (b != null ? BigInt(b) : 0n)).toString();
}

/** Used only in table column headers here — see the matching comment in
 *  BuyersList.jsx for why this pops downward instead of upward. */
function InfoTip({ text }) {
  return (
    <span className="stat-info-icon" tabIndex={0} style={{ marginLeft: '0.3rem' }}>
      <Info size={12} />
      <span className="stat-info-tooltip stat-info-tooltip--below" role="tooltip">{text}</span>
    </span>
  );
}

function getInitials(name) {
  return (name || '??').split(' ').map((n) => n[0]).join('').substring(0, 2);
}

/** Total sub-tab: the live DHT catalog + all-time on-chain earnings, passed
 *  down from App.jsx (unpaginated — the seller count is small). */
function TotalSellersTable({ sellers, search }) {
  const { t } = useI18n();
  const q = search.toLowerCase();
  // `name`/`id` were dereferenced without guards, so a single row missing
  // either field (the backend deliberately emits nulls rather than
  // fabricating values) threw and took down the whole tab.
  const filtered = sellers.filter((s) =>
    (s?.name || '').toLowerCase().includes(q) ||
    (s?.id || '').toLowerCase().includes(q)
  );

  // The old comparator returned 0 for every pair not involving the pinned
  // node, so the rest of the table kept whatever arbitrary order the API
  // happened to return (`SELECT * FROM sellers` has no ORDER BY) and
  // visibly reshuffled on every sync. Pin first, then sort by real earnings.
  const sorted = [...filtered].sort((a, b) =>
    (b.id === PINNED_SELLER_ID) - (a.id === PINNED_SELLER_ID)
    || (Number(b.totalEarned) || 0) - (Number(a.totalEarned) || 0)
  );

  const maxEarned = Math.max(1, ...sellers.map((s) => Number(s?.totalEarned) || 0));

  return (
    <table className="table">
      <thead>
        <tr>
          <th>{t('table.node')}</th>
          <th>{t('table.totalEarned')}</th>
          <th>{t('table.requests')}</th>
          <th>{t('table.capacity')}</th>
          <th>{t('table.models')}</th>
          <th>{t('table.joined')}</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((seller) => (
          <tr key={seller.id} style={seller.id === PINNED_SELLER_ID ? { background: 'rgba(59, 130, 246, 0.1)' } : {}}>
            <td>
              <div className="user-cell">
                <div className="avatar">{getInitials(seller.name)}</div>
                <div className="user-info">
                  <span className="user-name">
                    {seller.name}
                    <span className={`node-status ${isOnline(seller) ? 'online' : 'offline'}`}>
                      <span className="node-status-dot" />
                      {isOnline(seller) ? t('table.online') : t('table.offline')}
                    </span>
                  </span>
                  <span className="user-id">{seller.id}</span>
                </div>
              </div>
            </td>
            <td className="price">{seller.totalEarned != null ? `$${Number(seller.totalEarned).toLocaleString()}` : '—'}</td>
            <td>{seller.totalRequests != null ? Number(seller.totalRequests).toLocaleString() : '—'}</td>
            <td>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span>{seller.capacity}</span>
                <div className="volume-bar" style={{ width: 80 }}>
                  <div className="volume-fill" style={{ width: `${((Number(seller.totalEarned) || 0) / maxEarned) * 100}%` }}></div>
                </div>
              </div>
            </td>
            <td>{seller.models}</td>
            <td>{seller.joined || '—'}</td>
          </tr>
        ))}
        {sorted.length === 0 && (
          <tr>
            <td colSpan="6">
              <div className="empty-state">{t('table.noSellers')}</div>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** Epoch sub-tab: self-fetched, paginated, real per-epoch points/stake/
 *  reward data (see notes/epoch-features-plan.md) — a different data source
 *  than the Total tab's DHT+all-time prop, so it manages its own
 *  loading/pagination state rather than filtering the `sellers` prop. */
function EpochSellersTable({ query, onEpochNumber, onCount }) {
  const { t } = useI18n();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const sentinelRef = useRef(null);
  const inFlight = useRef(false);

  // Lifted to the parent so the "Sellers" header can show a count next to
  // the title, the same way BuyersList already does — this table (unlike
  // the Total tab's `sellers` prop) fetches its own paginated data, so the
  // parent has no other way to know the count.
  useEffect(() => { onCount(rows.length, total); }, [rows.length, total, onCount]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchEpochSellers({ limit: PAGE_SIZE, offset: 0, q: query })
      .then((page) => {
        if (cancelled) return;
        setRows(page.items || []);
        setTotal(page.total ?? null);
        setHasMore(Boolean(page.hasMore));
        if (page.epoch != null) onEpochNumber(page.epoch);
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
      const page = await fetchEpochSellers({ limit: PAGE_SIZE, offset: rows.length, q: query });
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.address));
        return [...prev, ...(page.items || []).filter((r) => !seen.has(r.address))];
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
  }, [rows.length, hasMore, loading, query]);

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

  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>{t('table.node')}</th>
            <th>{t('table.points')}<InfoTip text={t('table.pointsTip')} /></th>
            <th>{t('table.requests')}</th>
            <th>{t('table.stakedAnts')}<InfoTip text={t('table.stakedAntsTip')} /></th>
            <th>{t('table.stakingReward')}<InfoTip text={t('table.stakingRewardTip')} /></th>
            <th>{t('table.usageReward')}<InfoTip text={t('table.usageRewardTip')} /></th>
            <th>{t('table.potentialAnts')}<InfoTip text={t('table.potentialAntsTip')} /></th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={7}><div className="empty-state">{t('common.loading')}</div></td></tr>
          ) : error ? (
            <tr><td colSpan={7}><div className="empty-state">{error}</div></td></tr>
          ) : rows.map((row) => {
            const pinned = (row.address || '').toLowerCase() === PINNED_ADDRESS;
            return (
              <tr key={row.address} style={pinned ? { background: 'rgba(59, 130, 246, 0.1)' } : {}}>
                <td>
                  <div className="user-cell">
                    <div className="avatar">{getInitials(row.seller_name || row.address)}</div>
                    <div className="user-info">
                      <span className="user-name">{row.seller_name || short(row.address)}</span>
                      <span className="user-id mono">{short(row.address)}</span>
                    </div>
                  </div>
                </td>
                <td className="price">{usd(row.points != null ? Number(row.points) / 1e6 : null)}</td>
                <td>{row.requests != null ? Number(row.requests).toLocaleString() : '—'}</td>
                <td>{fmtAnts(row.staked_ants_wei)}</td>
                <td>{fmtAnts(row.pool_reward_wei)}</td>
                <td>{fmtAnts(row.usage_reward_wei)}</td>
                <td className="price">{fmtAnts(sumWei(row.usage_reward_wei, row.pool_reward_wei))}</td>
              </tr>
            );
          })}
          {!loading && !error && rows.length === 0 && (
            <tr><td colSpan={7}><div className="empty-state">{t('table.noEpochData')}</div></td></tr>
          )}
          {!loading && !error && loadingMore && (
            <tr>
              <td colSpan={7}>
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
    </>
  );
}

function SellersList({ sellers = [] }) {
  const { t } = useI18n();
  const [mode, setMode] = useState('epoch'); // 'epoch' | 'total'
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [epochNumber, setEpochNumber] = useState(null);
  // { shown, total } for the epoch sub-tab, reported up from
  // EpochSellersTable since it fetches its own paginated data — mirrors
  // BuyersList's count badge next to the tab title.
  const [epochCount, setEpochCount] = useState({ shown: 0, total: null });
  const onEpochCount = useCallback((shown, total) => setEpochCount({ shown, total }), []);

  useEffect(() => {
    const id = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  const epochLabel = t('tabs.epoch', { n: epochNumber ?? '…' });
  const count = mode === 'epoch' ? epochCount.total : sellers.length;
  const shown = mode === 'epoch' ? epochCount.shown : sellers.length;

  return (
    <div className="table-container">
      <div className="table-header">
        <h2 className="table-title">
          {t('nav.sellers')}{' '}
          {count != null && (
            <span className="table-count">
              {shown < count ? t('table.showingOf', { shown, total: count }) : count.toLocaleString()}
            </span>
          )}
        </h2>
        <div className="search-box">
          <Search size={16} className="search-icon" />
          <input
            type="text"
            placeholder={t('table.searchSellers')}
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
      {mode === 'epoch'
        ? <EpochSellersTable query={query} onEpochNumber={setEpochNumber} onCount={onEpochCount} />
        : <TotalSellersTable sellers={sellers} search={search} />}
    </div>
  );
}

export default SellersList;
