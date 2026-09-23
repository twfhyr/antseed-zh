import React, { useState } from 'react';
import { useI18n } from '../i18n/index.jsx';

// Chat tab — sends a prompt to /api/chat/image, which passes it through to
// the local antseed-buyer-longley-funs (:8390) paying Apex Ant for
// grok-imagine-image-quality. Site owner pays. Endpoint is public and
// OpenAI-images shaped so any agent can call it directly.
export default function Chat() {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [image, setImage] = useState(null);
  const [model, setModel] = useState(null);
  const [elapsedMs, setElapsedMs] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null); setImage(null); setModel(null); setElapsedMs(null);
    const started = performance.now();
    try {
      const r = await fetch('/api/chat/image', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const first = (j.data || [])[0] || j;
      if (first.b64_json) setImage(`data:image/png;base64,${first.b64_json}`);
      else if (first.b64) setImage(`data:image/png;base64,${first.b64}`);
      else if (first.url) setImage(first.url);
      else throw new Error('no image in response');
      setModel(j.model || first.model || null);
      setElapsedMs(Math.round(performance.now() - started));
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat-tab" style={{ display: 'grid', gap: '1rem', maxWidth: 900 }}>
      <div>
        <h2 style={{ margin: 0 }}>{t('chat.title')}</h2>
        <p style={{ color: 'var(--text-secondary)', marginTop: '.25rem' }}>{t('chat.subtitle')}</p>
      </div>

      <form onSubmit={submit} style={{ display: 'grid', gap: '.75rem' }}>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          disabled={busy}
          style={{ width: '100%', padding: '.75rem', borderRadius: 8, border: '1px solid var(--border, #333)', background: 'var(--bg-alt, #111)', color: 'inherit', fontFamily: 'inherit', fontSize: '1rem' }}
        />
        <div style={{ display: 'flex', gap: '.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="submit"
            disabled={busy}
            style={{ padding: '.5rem 1rem', borderRadius: 6, border: 0, background: busy ? 'var(--muted, #333)' : 'var(--accent, #4a90e2)', color: '#fff', cursor: busy ? 'wait' : 'pointer' }}
          >
            {busy ? t('chat.generating') : t('chat.generate')}
          </button>
        </div>
      </form>

      {error && (
        <div style={{ padding: '.75rem', background: 'rgba(200, 60, 60, .15)', border: '1px solid rgba(200, 60, 60, .5)', borderRadius: 6 }}>
          {t('chat.error')}: {error}
        </div>
      )}

      {image && (
        <div style={{ display: 'grid', gap: '.5rem' }}>
          <img src={image} alt={prompt} style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--border, #333)' }} />
          <div style={{ color: 'var(--text-secondary)', fontSize: '.85rem' }}>
            {model && <>model: <code>{model}</code></>}
            {elapsedMs != null && <> · {(elapsedMs / 1000).toFixed(1)}s</>}
          </div>
        </div>
      )}

      <details style={{ color: 'var(--text-secondary)', fontSize: '.9rem' }}>
        <summary style={{ cursor: 'pointer' }}>{t('chat.howItWorks')}</summary>
        <p style={{ marginTop: '.5rem' }}>{t('chat.howItWorksBody')}</p>
        <p style={{ marginTop: '.5rem' }}>{t('chat.apiHint')} <code>POST https://antseed-zh.com/api/chat/image</code></p>
      </details>
    </div>
  );
}
