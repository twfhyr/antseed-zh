import React from 'react';
import { useI18n } from '../i18n/index.jsx';
import ProtocolAnimation from './ProtocolAnimation';

// The Protocol tab is intentionally a single, focused surface: a short
// framing sentence and one animated diagram of the whole request workflow
// (src/components/ProtocolAnimation.jsx) — not a multi-section reference
// page. ANTS/tokenomics mechanics live on their own tab (see the closing
// line below); this page's only job is "how does a request actually work."
function Protocol() {
  const { t } = useI18n();

  return (
    <div style={{ display: 'grid', gap: '1.25rem', maxWidth: 900, margin: '0 auto' }}>
      <div className="table-container" style={{ padding: '1.5rem' }}>
        <h2 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>{t('protocol.introTitle')}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9375rem', lineHeight: 1.6 }}>{t('protocol.introP1')}</p>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9375rem', lineHeight: 1.6 }}>{t('protocol.introP2')}</p>
        <ProtocolAnimation t={t} />
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem', marginTop: '1rem' }}>{t('protocol.closing')}</p>
      </div>

      <div className="table-container" style={{ padding: '1.5rem' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '0.5rem' }}>{t('protocol.compareTitle')}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', lineHeight: 1.6, marginBottom: '1rem' }}>
          {t('protocol.compareIntro')}
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('protocol.compare.col.dimension')}</th>
                <th>{t('protocol.compare.col.antseed')}</th>
                <th>{t('protocol.compare.col.venice')}</th>
                <th>{t('protocol.compare.col.orbio')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{t('protocol.compare.row.model')}</td>
                <td>{t('protocol.compare.antseed.model')}</td>
                <td>{t('protocol.compare.venice.model')}</td>
                <td>{t('protocol.compare.orbio.model')}</td>
              </tr>
              <tr>
                <td>{t('protocol.compare.row.settlement')}</td>
                <td>{t('protocol.compare.antseed.settlement')}</td>
                <td>{t('protocol.compare.venice.settlement')}</td>
                <td>{t('protocol.compare.orbio.settlement')}</td>
              </tr>
              <tr>
                <td>{t('protocol.compare.row.routing')}</td>
                <td>{t('protocol.compare.antseed.routing')}</td>
                <td>{t('protocol.compare.venice.routing')}</td>
                <td>{t('protocol.compare.orbio.routing')}</td>
              </tr>
              <tr>
                <td>{t('protocol.compare.row.identity')}</td>
                <td>{t('protocol.compare.antseed.identity')}</td>
                <td>{t('protocol.compare.venice.identity')}</td>
                <td>{t('protocol.compare.orbio.identity')}</td>
              </tr>
              <tr>
                <td>{t('protocol.compare.row.tokenRole')}</td>
                <td>{t('protocol.compare.antseed.tokenRole')}</td>
                <td>{t('protocol.compare.venice.tokenRole')}</td>
                <td>{t('protocol.compare.orbio.tokenRole')}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginTop: '1rem' }}>
          {t('protocol.compareFootnote')}
        </p>
      </div>
    </div>
  );
}

export default Protocol;
