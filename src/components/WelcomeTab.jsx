import React, { useState, useEffect } from 'react';
import { ExternalLink, Zap, Users } from 'lucide-react';
import { fetchServices } from '../api';

const MY_PEER_ID = '412282c48584073c5aee6a79945f105a7777e194';
const MY_SELLER_ID = `seller_${MY_PEER_ID}`;

function WelcomeTab() {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadModels() {
      try {
        const allServices = await fetchServices();
        const mine = allServices.filter(s => s.sellerId === MY_SELLER_ID);
        setModels(mine);
      } catch {
        setModels([]);
      } finally {
        setLoading(false);
      }
    }
    loadModels();
  }, []);

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="table-container">
      <div style={{ maxWidth: '900px', margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <h2 style={{ fontSize: '1.75rem', fontWeight: 700, marginBottom: '0.5rem' }}>
            Welcome to AntSeed Network
          </h2>
          <p style={{ color: 'var(--text-secondary)' }}>
            Connect to <strong>antseed-zh</strong> — your gateway to affordable AI inference
          </p>
        </div>

        <div style={{ background: 'var(--bg-secondary)', borderRadius: '12px', padding: '1.5rem', marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
            <Zap size={20} style={{ color: 'var(--accent)' }} />
            <h3 style={{ fontSize: '1.125rem', fontWeight: 600 }}>Connect to antseed-zh</h3>
          </div>

          <div style={{ display: 'grid', gap: '0.75rem', marginBottom: '1.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ color: 'var(--text-secondary)', width: '80px' }}>Peer ID:</span>
              <code style={{ flex: 1, background: 'var(--bg-primary)', padding: '0.5rem', borderRadius: '6px', fontSize: '0.875rem' }}>
                {MY_PEER_ID}
              </code>
              <button
                onClick={() => copyToClipboard(MY_PEER_ID)}
                style={{ background: 'var(--accent)', border: 'none', color: 'white', padding: '0.5rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.75rem' }}
              >
                Copy
              </button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ color: 'var(--text-secondary)', width: '80px' }}>Command:</span>
              <code style={{ flex: 1, background: 'var(--bg-primary)', padding: '0.5rem', borderRadius: '6px', fontSize: '0.875rem', fontFamily: 'monospace' }}>
                antseed buyer connection set --peer {MY_PEER_ID}
              </code>
              <button
                onClick={() => copyToClipboard(`antseed buyer connection set --peer ${MY_PEER_ID}`)}
                style={{ background: 'var(--accent)', border: 'none', color: 'white', padding: '0.5rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.75rem' }}
              >
                Copy
              </button>
            </div>
          </div>

          
        </div>

        <div style={{ background: 'var(--bg-secondary)', borderRadius: '12px', padding: '1.5rem', marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
            <Users size={20} style={{ color: 'var(--accent)' }} />
            <h3 style={{ fontSize: '1.125rem', fontWeight: 600 }}>Available Models</h3>
          </div>

          <table className="table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Input ($/1M)</th>
                <th>Output ($/1M)</th>
                <th>Status</th>
                <th>Load</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>Loading...</td></tr>
              ) : models.length === 0 ? (
                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>No services found</td></tr>
              ) : models.map(svc => (
                <tr key={svc.id}>
                  <td><code style={{ fontSize: '0.875rem' }}>{svc.name}</code></td>
                  <td className="price">${svc.pricing?.inputUsdPerMillion ?? 0}</td>
                  <td className="price">${svc.pricing?.outputUsdPerMillion ?? 0}</td>
                  <td style={{ color: svc.status === 'online' ? 'var(--success)' : 'var(--text-secondary)', fontSize: '0.875rem' }}>{svc.status}</td>
                  <td style={{ fontSize: '0.875rem' }}>{svc.currentLoad}/{svc.maxConcurrency}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ background: 'var(--bg-secondary)', borderRadius: '12px', padding: '1.5rem' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>How to Get Started</h3>
          <ol style={{ paddingLeft: '1.25rem', color: 'var(--text-secondary)', fontSize: '0.875rem', display: 'grid', gap: '0.5rem' }}>
            <li>Install antseed buyer CLI: <code style={{ background: 'var(--bg-primary)', padding: '0.125rem 0.375rem', borderRadius: '4px' }}>npm install -g @antseed/buyer</code></li>
            <li>Configure your wallet with USDC on Base</li>
            <li>Connect to antseed-zh: <code style={{ background: 'var(--bg-primary)', padding: '0.125rem 0.375rem', borderRadius: '4px' }}>antseed buyer connection set --peer {MY_PEER_ID}</code></li>
            <li>Start making inference requests!</li>
          </ol>
          <div style={{ marginTop: '1rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
            Questions? Ping <strong>antseed-zh</strong> anytime.
          </div>
        </div>
      </div>
    </div>
  );
}

export default WelcomeTab;
