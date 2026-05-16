import React, { useState } from 'react';
import { Search } from 'lucide-react';

function SellersList({ sellers }) {
  const [search, setSearch] = useState('');

  const filtered = sellers.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.id.toLowerCase().includes(search.toLowerCase())
  );

  const sorted = [...filtered].sort((a, b) => {
    if (a.id === 'seller_412282c48584073c5aee6a79945f105a7777e194') return -1;
    if (b.id === 'seller_412282c48584073c5aee6a79945f105a7777e194') return 1;
    return 0;
  });

  const getInitials = (name) => name.split(' ').map(n => n[0]).join('').substring(0, 2);

  const maxEarned = Math.max(...sellers.map(s => s.totalEarned));

  return (
    <div className="table-container">
      <div className="table-header">
        <h2 className="table-title">Sellers</h2>
        <div className="search-box">
          <Search size={16} className="search-icon" />
          <input
            type="text"
            placeholder="Search sellers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Node</th>
            <th>Status</th>
            <th>Total Earned</th>
            <th>Capacity</th>
            <th>Uptime</th>
            <th>Models</th>
            <th>Joined</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(seller => (
            <tr key={seller.id} style={seller.id === 'seller_412282c48584073c5aee6a79945f105a7777e194' ? { background: 'rgba(59, 130, 246, 0.1)' } : {}}>
              <td>
                <div className="user-cell">
                  <div className="avatar">{getInitials(seller.name)}</div>
                  <div className="user-info">
                    <span className="user-name">{seller.name}</span>
                    <span className="user-id">{seller.id}</span>
                  </div>
                </div>
              </td>
              <td>
                <span className={`status-badge ${seller.status}`}>
                  <span className="status-dot" style={{ animation: 'none', background: 'currentColor' }}></span>
                  {seller.status}
                </span>
              </td>
              <td className="price">${seller.totalEarned.toLocaleString()}</td>
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <span>{seller.capacity}</span>
                  <div className="volume-bar" style={{ width: 80 }}>
                    <div className="volume-fill" style={{ width: `${(seller.totalEarned / maxEarned) * 100}%` }}></div>
                  </div>
                </div>
              </td>
              <td>{seller.uptime}%</td>
              <td>{seller.models}</td>
              <td>{seller.joined}</td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan="7">
                <div className="empty-state">No sellers found matching your search.</div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default SellersList;