import React, { useState } from 'react';
import { Search } from 'lucide-react';
import { useI18n } from '../i18n/index.jsx';

/** The indexer exposes a status string; treat only an explicit "online" as
 *  online so an unknown/missing value degrades to offline rather than
 *  claiming a node is up. */
function isOnline(seller) {
  return String(seller?.status || '').toLowerCase() === 'online';
}

const PINNED_SELLER_ID = 'seller_412282c48584073c5aee6a79945f105a7777e194';

function SellersList({ sellers = [] }) {
  const { t } = useI18n();
  const [search, setSearch] = useState('');

  // `name`/`id` were dereferenced without guards, so a single row missing
  // either field (the backend deliberately emits nulls rather than
  // fabricating values) threw and took down the whole tab.
  const q = search.toLowerCase();
  const filtered = sellers.filter(s =>
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

  const getInitials = (name) => (name || '??').split(' ').map(n => n[0]).join('').substring(0, 2);

  const maxEarned = Math.max(1, ...sellers.map(s => Number(s?.totalEarned) || 0));

  return (
    <div className="table-container">
      <div className="table-header">
        <h2 className="table-title">{t('nav.sellers')}</h2>
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
      <table className="table">
        <thead>
          <tr>
            <th>{t('table.node')}</th>
            <th>{t('table.totalEarned')}</th>
            <th>{t('table.capacity')}</th>
            <th>{t('table.models')}</th>
            <th>{t('table.joined')}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(seller => (
            <tr key={seller.id} style={seller.id === 'seller_412282c48584073c5aee6a79945f105a7777e194' ? { background: 'rgba(59, 130, 246, 0.1)' } : {}}>
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
              <td colSpan="5">
                <div className="empty-state">{t('table.noSellers')}</div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default SellersList;