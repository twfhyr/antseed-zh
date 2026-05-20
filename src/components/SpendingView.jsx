import React, { useState } from 'react';
import { Loader2, RefreshCw, TrendingUp, Calendar, Store } from 'lucide-react';
import { useSpendingData } from '../hooks/useSpendingData';

const STATUS_MAP = { 0: 'Closed', 1: 'Active', 2: 'Settled', 3: 'Timed Out' };

function truncateAddr(addr) {
  return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '';
}

function SpendingView({ buyerAddress }) {
const [days, setDays] = useState(7);
const { data, isLoading: loading, error, refetch } = useSpendingData(buyerAddress, days);

if (!buyerAddress) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
        Connect wallet to view spending.
      </div>
    );
  }

  if (loading && !data) {    return (
      <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
        <Loader2 size={32} className="spin" />
        <p style={{ marginTop: '1rem' }}>Loading spending data...</p>
      </div>
    );
  }

if (error) {
return (
  <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--danger)' }}>
    Error: {error.message}
  </div>
);
}

  if (!data) return null;

  const maxDailySpend = Math.max(...data.dailyBreakdown.map(d => d.spent), 0.01);

  return (
    <div style={{ padding: '2rem' }}>
      <div style={{ maxWidth: '900px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>Spending</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              On-chain spending from your payment channels (last {data.days} days).
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <select value={days} onChange={e => setDays(Number(e.target.value))} style={{
              padding: '0.5rem', borderRadius: '8px', border: '1px solid var(--border)',
              background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '0.875rem',
            }}>
              <option value={1}>1 day</option>
              <option value={3}>3 days</option>
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
            </select>
            <button onClick={refetch} disabled={loading} style={{
              display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1rem',
              borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.875rem',
            }}>
              <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
              Refresh
            </button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
          <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Total Spent</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>${data.totalSpent.toFixed(2)}</div>
          </div>
          <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Channels</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{data.activeChannels} / {data.totalChannels}</div>
          </div>
          <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Reserved</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>${data.totalReserved.toFixed(2)}</div>
          </div>
        </div>

        {data.dailyBreakdown.length > 0 && (
          <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px', marginBottom: '1.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
              <Calendar size={16} style={{ color: 'var(--text-secondary)' }} />
              <span style={{ fontSize: '0.875rem', fontWeight: 600 }}>Daily Breakdown</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {data.dailyBreakdown.map(d => (
                <div key={d.date} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', width: '5.5rem', flexShrink: 0 }}>{d.date}</span>
                  <div style={{ flex: 1, height: '1.25rem', background: 'var(--bg-primary)', borderRadius: '6px', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%',
                      width: `${Math.max((d.spent / maxDailySpend) * 100, d.spent > 0 ? 2 : 0)}%`,
                      background: 'linear-gradient(90deg, var(--accent), #8b5cf6)',
                      borderRadius: '6px',
                      transition: 'width 0.3s ease',
                    }} />
                  </div>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, width: '5rem', textAlign: 'right' }}>${d.spent.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {data.sellerBreakdown.length > 0 && (
          <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px', marginBottom: '1.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
              <Store size={16} style={{ color: 'var(--text-secondary)' }} />
              <span style={{ fontSize: '0.875rem', fontWeight: 600 }}>By Seller</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
              {data.sellerBreakdown.map(s => (
                <div key={s.seller} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.25rem 0' }}>
                  <span style={{ fontFamily: 'monospace', fontSize: '0.8rem' }} title={s.seller}>{truncateAddr(s.seller)}</span>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>${s.spent.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {data.channels.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ minWidth: '600px' }}>
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Seller</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Reserved</th>
                  <th style={{ textAlign: 'right' }}>Spent</th>
                  <th>Opened</th>
                </tr>
              </thead>
              <tbody>
                {data.channels.map(ch => (
                  <tr key={ch.channelId}>
                    <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{ch.channelId.slice(0, 10)}...</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }} title={ch.seller}>{truncateAddr(ch.seller)}</td>
                    <td>
                      <span style={{
                        padding: '0.25rem 0.5rem', borderRadius: '6px', fontSize: '0.75rem', fontWeight: 600,
                        background: ch.status === 1 ? 'rgba(16,185,129,0.15)' : 'rgba(156,163,175,0.15)',
                        color: ch.status === 1 ? '#10b981' : '#9ca3af',
                      }}>
                        {STATUS_MAP[ch.status] || `Status ${ch.status}`}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>${ch.deposit.toFixed(2)}</td>
                    <td style={{ textAlign: 'right' }}>${ch.settled.toFixed(2)}</td>
                    <td>{new Date(ch.reservedAt * 1000).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default SpendingView;
