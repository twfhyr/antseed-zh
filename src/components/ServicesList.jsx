import React, { useState } from 'react';
import { Search, Tag, Zap, ArrowRight, HelpCircle } from 'lucide-react';

function ServicesList({ services }) {
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('all');
  const [showLoadTip, setShowLoadTip] = useState(false);

  const categories = ['all', ...Array.from(new Set(services.flatMap(s => s.categories)))].filter(c => c && c !== 'all');

  const filtered = services.filter(s => {
    const matchesSearch =
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.provider.toLowerCase().includes(search.toLowerCase()) ||
      s.sellerName.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = filterCategory === 'all' || s.categories.includes(filterCategory);
    return matchesSearch && matchesCategory;
  });

  const categoryColors = {
    privacy:    { bg: 'rgba(139,92,246,0.15)', color: '#8b5cf6' },
    legal:      { bg: 'rgba(59,130,246,0.15)',  color: '#3b82f6' },
    uncensored: { bg: 'rgba(239,68,68,0.15)',   color: '#ef4444' },
    coding:     { bg: 'rgba(16,185,129,0.15)',  color: '#10b981' },
    finance:    { bg: 'rgba(245,158,11,0.15)',  color: '#f59e0b' },
    tee:        { bg: 'rgba(236,72,153,0.15)',  color: '#ec4899' },
    general:    { bg: 'rgba(107,114,128,0.15)', color: '#9ca3af' },
    anon:       { bg: 'rgba(139,92,246,0.15)',  color: '#8b5cf6' },
    chat:       { bg: 'rgba(59,130,246,0.15)',  color: '#3b82f6' },
    fast:       { bg: 'rgba(245,158,11,0.15)',  color: '#f59e0b' },
    reasoning:  { bg: 'rgba(6,182,212,0.15)',   color: '#06b6d4' },
    vision:     { bg: 'rgba(236,72,153,0.15)',  color: '#ec4899' },
    multimodal: { bg: 'rgba(139,92,246,0.15)',  color: '#8b5cf6' },
    cheap:      { bg: 'rgba(16,185,129,0.15)',  color: '#10b981' },
    premium:    { bg: 'rgba(250,204,21,0.15)',  color: '#facc15' },
    code:       { bg: 'rgba(16,185,129,0.15)',  color: '#10b981' },
    math:       { bg: 'rgba(59,130,246,0.15)',  color: '#3b82f6' },
    writing:    { bg: 'rgba(245,158,11,0.15)',  color: '#f59e0b' },
    tasks:      { bg: 'rgba(107,114,128,0.15)', color: '#9ca3af' },
    agents:     { bg: 'rgba(139,92,246,0.15)',  color: '#8b5cf6' },
    tools:      { bg: 'rgba(107,114,128,0.15)', color: '#9ca3af' },
    audio:      { bg: 'rgba(236,72,153,0.15)',  color: '#ec4899' },
    video:      { bg: 'rgba(236,72,153,0.15)',  color: '#ec4899' },
    research:   { bg: 'rgba(6,182,212,0.15)',   color: '#06b6d4' },
    translate:  { bg: 'rgba(107,114,128,0.15)', color: '#9ca3af' },
    creative:   { bg: 'rgba(245,158,11,0.15)',  color: '#f59e0b' },
    free:       { bg: 'rgba(16,185,129,0.15)',  color: '#10b981' },
    roleplay:   { bg: 'rgba(139,92,246,0.15)',  color: '#8b5cf6' },
    mcp:        { bg: 'rgba(107,114,128,0.15)', color: '#9ca3af' },
    analytics:  { bg: 'rgba(107,114,128,0.15)', color: '#9ca3af' },
    crypto:     { bg: 'rgba(245,158,11,0.15)',  color: '#f59e0b' },
    audit:      { bg: 'rgba(239,68,68,0.15)',   color: '#ef4444' },
    'web-search':{ bg: 'rgba(59,130,246,0.15)', color: '#3b82f6' },
    'x-search':  { bg: 'rgba(0,0,0,0.2)',         color: '#9ca3af' },
  };

  const formatPrice = (val) => {
    if (val === undefined || val === null) return '$0';
    if (val < 0.01) return '<$0.01';
    return '$' + val;
  };

  const loadBarColor = (load, max) => {
    const ratio = max > 0 ? load / max : 0;
    if (ratio > 0.8) return 'var(--danger)';
    if (ratio > 0.5) return 'var(--warning)';
    return 'var(--accent)';
  };

  return (
    <div className="table-container">
      <div className="table-header">
        <h2 className="table-title">Available Services</h2>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <div className="search-box">
            <Search size={16} className="search-icon" />
            <input
              type="text"
              placeholder="Search services..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div style={{ padding: '0.75rem 1.5rem', borderBottom: '1px solid var(--border)', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Filter by category:
        </span>
        {categories.map(cat => (
          <button
            key={cat}
            onClick={() => setFilterCategory(cat)}
            style={{
              padding: '0.25rem 0.75rem',
              borderRadius: '9999px',
              fontSize: '0.75rem',
              fontWeight: 500,
              border: 'none',
              cursor: 'pointer',
              background: filterCategory === cat ? 'var(--accent)' : 'var(--bg-secondary)',
              color: filterCategory === cat ? 'white' : 'var(--text-secondary)',
              transition: 'all 0.2s',
            }}
          >
            {cat === 'all' ? 'All' : cat}
          </button>
        ))}
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Service</th>
            <th>Seller</th>
            <th>Status</th>
            <th>Price (per 1M tokens)</th>
            <th>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', cursor: 'help' }}
                onMouseEnter={() => setShowLoadTip(true)}
                onMouseLeave={() => setShowLoadTip(false)}
              >
                Load
                <HelpCircle size={13} color="var(--text-secondary)" />
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(svc => {
            const loadRatio = svc.maxConcurrency > 0 ? svc.currentLoad / svc.maxConcurrency : 0;
            return (
              <tr key={svc.id}>
                <td>
                  <div className="user-cell">
                    <div className="avatar" style={{ background: 'var(--info)' }}>
                      <Zap size={16} />
                    </div>
                    <div className="user-info">
                      <span className="user-name">{svc.name}</span>
                      <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', marginTop: '0.35rem' }}>
                        {svc.categories.slice(0, 4).map(cat => {
                          const color = categoryColors[cat] || categoryColors['general'];
                          return (
                            <span
                              key={cat}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.2rem',
                                padding: '0.1rem 0.4rem',
                                borderRadius: '9999px',
                                fontSize: '0.65rem',
                                fontWeight: 500,
                                background: color.bg,
                                color: color.color,
                                lineHeight: 1.2,
                              }}
                            >
                              <Tag size={8} />
                              {cat}
                            </span>
                          );
                        })}
                        {svc.categories.length > 4 && (
                          <span
                            style={{
                              fontSize: '0.65rem',
                              color: 'var(--text-secondary)',
                              padding: '0.1rem 0.4rem',
                            }}
                          >
                            +{svc.categories.length - 4}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </td>
                <td>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>{svc.sellerName}</span>
                </td>
                <td>
                  <span className={`status-badge ${svc.status}`}>
                    <span className="status-dot" style={{ animation: 'none', background: 'currentColor' }}></span>
                    {svc.status}
                  </span>
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      padding: '0.35rem 0.7rem',
                      borderRadius: '8px',
                      background: 'rgba(16,185,129,0.12)',
                      border: '1px solid rgba(16,185,129,0.25)',
                      fontSize: '0.825rem',
                      fontWeight: 600,
                      color: '#34d399',
                      whiteSpace: 'nowrap',
                    }}>
                      In: {formatPrice(svc.pricing.inputUsdPerMillion)}
                    </div>
                    <ArrowRight size={14} color="var(--text-secondary)" />
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      padding: '0.35rem 0.7rem',
                      borderRadius: '8px',
                      background: 'rgba(245,158,11,0.12)',
                      border: '1px solid rgba(245,158,11,0.25)',
                      fontSize: '0.825rem',
                      fontWeight: 600,
                      color: '#fbbf24',
                      whiteSpace: 'nowrap',
                    }}>
                      Out: {formatPrice(svc.pricing.outputUsdPerMillion)}
                    </div>
                  </div>
                  {svc.pricing.cachedInputUsdPerMillion !== undefined && svc.pricing.cachedInputUsdPerMillion !== 0 && svc.pricing.cachedInputUsdPerMillion !== svc.pricing.inputUsdPerMillion && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.35rem' }}>
                      Cached in: <span style={{ color: '#34d399', fontWeight: 500 }}>{formatPrice(svc.pricing.cachedInputUsdPerMillion)}</span>
                    </div>
                  )}
                </td>
                <td style={{ position: 'relative' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div className="volume-bar" style={{ width: 80 }}>
                      <div
                        className="volume-fill"
                        style={{
                          width: `${loadRatio * 100}%`,
                          background: loadBarColor(svc.currentLoad, svc.maxConcurrency),
                        }}
                      ></div>
                    </div>
                    <span style={{ fontSize: '0.8rem', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                      {svc.currentLoad}/{svc.maxConcurrency}
                    </span>
                  </div>
                </td>
              </tr>
            );
          })}
          {filtered.length === 0 && (
            <tr>
              <td colSpan="5">
                <div className="empty-state">No services found matching your search.</div>
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Tooltip for Load header */}
      {showLoadTip && (
        <div
          style={{
            position: 'fixed',
            bottom: '2rem',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: '12px',
            padding: '1rem 1.5rem',
            boxShadow: '0 10px 40px rgba(0,0,0,0.4)',
            zIndex: 1000,
            maxWidth: '480px',
            textAlign: 'center',
          }}
          onMouseEnter={() => setShowLoadTip(true)}
          onMouseLeave={() => setShowLoadTip(false)}
        >
          <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>What is Load?</div>
          <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            Load shows how busy a provider node is right now.<br />
            <span style={{ color: 'var(--accent)' }}>Green</span> = plenty of capacity &middot;
            <span style={{ color: 'var(--warning)' }}> Orange</span> = getting busy &middot;
            <span style={{ color: 'var(--danger)' }}> Red</span> = near capacity (may be slower).<br />
            The AntSeed proxy routes requests to the least-loaded provider for faster responses.
          </div>
        </div>
      )}
    </div>
  );
}

export default ServicesList;
