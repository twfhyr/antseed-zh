import React, { useState } from 'react';
import { Search } from 'lucide-react';

function BuyersList({ buyers }) {
  const [search, setSearch] = useState('');

  const filtered = buyers.filter(b =>
    b.name.toLowerCase().includes(search.toLowerCase()) ||
    b.id.toLowerCase().includes(search.toLowerCase())
  );

  const getInitials = (name) => name.split(' ').map(n => n[0]).join('').substring(0, 2);

  const maxRequests = Math.max(...buyers.map(b => b.requests));

  return (
    <div className="table-container">
      <div className="table-header">
        <h2 className="table-title">Buyers</h2>
        <div className="search-box">
          <Search size={16} className="search-icon" />
          <input
            type="text"
            placeholder="Search buyers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>User</th>
            <th>Status</th>
            <th>Total Spent</th>
            <th>Requests</th>
            <th>Avg Latency</th>
            <th>Joined</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(buyer => (
            <tr key={buyer.id}>
              <td>
                <div className="user-cell">
                  <div className="avatar">{getInitials(buyer.name)}</div>
                  <div className="user-info">
                    <span className="user-name">{buyer.name}</span>
                    <span className="user-id">{buyer.id}</span>
                  </div>
                </div>
              </td>
              <td>
                <span className={`status-badge ${buyer.status}`}>
                  <span className="status-dot" style={{ animation: 'none', background: 'currentColor' }}></span>
                  {buyer.status}
                </span>
              </td>
              <td className="price">${buyer.totalSpent.toLocaleString()}</td>
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <span>{buyer.requests.toLocaleString()}</span>
                  <div className="volume-bar" style={{ width: 80 }}>
                    <div className="volume-fill" style={{ width: `${(buyer.requests / maxRequests) * 100}%` }}></div>
                  </div>
                </div>
              </td>
              <td>{buyer.avgLatency}ms</td>
              <td>{buyer.joined}</td>
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr>
              <td colSpan="6">
                <div className="empty-state">No buyers found matching your search.</div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default BuyersList;