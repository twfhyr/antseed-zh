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
    </div>
  );
}

export default Protocol;
