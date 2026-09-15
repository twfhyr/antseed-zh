import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Github } from 'lucide-react';
import { fetchProviderModels } from '../api';
import { useI18n } from '../i18n/index.jsx';

const MY_PEER_ID = '412282c48584073c5aee6a79945f105a7777e194';

// Section ids double as the vertical nav's anchor targets — order here
// defines both nav order and page order. Kept flat/simple on purpose (no
// "Part 1 / Part 2" grouping): visitors just pick whatever they're curious
// about and jump straight there.
const SECTIONS = ['whatIs', 'layers', 'provide', 'payments', 'community', 'node', 'models', 'start'];

function About() {
  const { t } = useI18n();
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copiedKey, setCopiedKey] = useState(null);
  const [activeSection, setActiveSection] = useState(SECTIONS[0]);
  const sectionRefs = useRef({});

  useEffect(() => {
    async function loadModels() {
      try {
        const data = await fetchProviderModels();
        setModels(data);
      } catch {
        setModels([]);
      } finally {
        setLoading(false);
      }
    }
    loadModels();
  }, []);

  // Highlight the nav item for whichever section is currently in view,
  // instead of only updating on click — feels right when the visitor
  // scrolls freely instead of using the nav.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;
        // Prefer the entry closest to the top of the viewport.
        visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        setActiveSection(visible[0].target.dataset.section);
      },
      { rootMargin: '-10% 0px -70% 0px', threshold: 0 }
    );
    SECTIONS.forEach((id) => {
      const el = sectionRefs.current[id];
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  const scrollToSection = useCallback((id) => {
    const el = sectionRefs.current[id];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveSection(id);
  }, []);

  const copyToClipboard = async (text, key) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const setRef = (id) => (el) => { sectionRefs.current[id] = el; };

  return (
    <div className="about-layout">
      {/* Copy below is sourced from the official AntSeed documentation
          (apps/website/docs/lightpaper.md and getting-started/*) — see
          CLAUDE.md: never state an AntSeed fact from general knowledge. */}
      <nav className="about-nav">
        {SECTIONS.map((id) => (
          <button
            key={id}
            className={`about-nav__item ${activeSection === id ? 'active' : ''}`}
            onClick={() => scrollToSection(id)}
          >
            {t(`about.nav.${id}`)}
          </button>
        ))}
      </nav>

      <div className="about-content">
        <div className="table-container about-section" data-section="whatIs" ref={setRef('whatIs')}>
          <h3>{t('about.whatIsTitle')}</h3>
          <p>{t('about.whatIsP1')}</p>
          <p>{t('about.whatIsP2')}</p>
        </div>

        <div className="table-container about-section" data-section="layers" ref={setRef('layers')}>
          <h3>{t('about.layersTitle')}</h3>
          <p><strong>{t('about.layer1Title')}</strong> {t('about.layer1Body')}</p>
          <p><strong>{t('about.layer2Title')}</strong> {t('about.layer2Body')}</p>
        </div>

        <div className="table-container about-section" data-section="provide" ref={setRef('provide')}>
          <h3>{t('about.provideTitle')}</h3>
          <p><strong>{t('about.provide1Title')}</strong> {t('about.provide1Body')}</p>
          <p><strong>{t('about.provide2Title')}</strong> {t('about.provide2Body')}</p>
          <p><strong>{t('about.provide3Title')}</strong> {t('about.provide3Body')}</p>
        </div>

        <div className="table-container about-section" data-section="payments" ref={setRef('payments')}>
          <h3>{t('about.paymentsTitle')}</h3>
          <p>{t('about.paymentsP1')}</p>
          <p>{t('about.paymentsP2')}</p>
        </div>

        <div className="table-container about-section about-section--community" data-section="community" ref={setRef('community')}>
          <h3>{t('about.communityTitle')}</h3>
          <p>{t('about.communityBody')}</p>
          <a
            href="https://github.com/twfhyr/antseed-zh"
            target="_blank"
            rel="noopener noreferrer"
            className="about-connect__copy about-github-cta"
          >
            <Github size={15} />
            {t('about.contributeCta')}
          </a>
        </div>

        <div className="table-container about-section" data-section="node" ref={setRef('node')}>
          <h3>{t('about.nodeTitle')}</h3>
          <p>{t('about.nodeBody')}</p>

          <div className="about-connect">
            <div className="about-connect__row">
              <span className="about-connect__label">{t('about.peerId')}</span>
              <code className="about-connect__value">{MY_PEER_ID}</code>
              <button className="about-connect__copy" onClick={() => copyToClipboard(MY_PEER_ID, 'peer')}>
                {copiedKey === 'peer' ? t('about.copied') : t('about.copy')}
              </button>
            </div>
            <div className="about-connect__row">
              <span className="about-connect__label">{t('about.command')}</span>
              <code className="about-connect__value">antseed buyer connection set --peer {MY_PEER_ID}</code>
              <button
                className="about-connect__copy"
                onClick={() => copyToClipboard(`antseed buyer connection set --peer ${MY_PEER_ID}`, 'cmd')}
              >
                {copiedKey === 'cmd' ? t('about.copied') : t('about.copy')}
              </button>
            </div>
          </div>
        </div>

        <div className="table-container about-section" data-section="models" ref={setRef('models')}>
          <h3>{t('about.modelsTitle')}</h3>
          <table className="table">
            <thead>
              <tr>
                <th>{t('about.modelId')}</th>
                <th>{t('about.owner')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={2} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>{t('common.loading')}</td></tr>
              ) : models.length === 0 ? (
                <tr><td colSpan={2} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>{t('about.noModels')}</td></tr>
              ) : models.map(m => (
                <tr key={m.id}>
                  <td><code style={{ fontSize: '0.875rem' }}>{m.id}</code></td>
                  <td style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>{m.owned_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="table-container about-section" data-section="start" ref={setRef('start')}>
          <h3>{t('about.startTitle')}</h3>
          <ol className="about-steps">
            {/* `@antseed/buyer` does not exist on npm (404) — the published CLI
                package is `@antseed/cli`, which provides the `antseed` binary
                used by the connect command below. */}
            <li>{t('about.step1')} <code>npm install -g @antseed/cli</code></li>
            <li>{t('about.step2')} <code>antseed buyer start</code></li>
            <li>{t('about.step3')}</li>
            <li>{t('about.step4')} <code>antseed buyer connection set --peer {MY_PEER_ID}</code></li>
          </ol>
        </div>
      </div>
    </div>
  );
}

export default About;
