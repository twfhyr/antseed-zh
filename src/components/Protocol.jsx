import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { stackDiagram, paymentChannelDiagram } from '../data/protocolDiagrams';
import RequestFlowAnimation from './RequestFlowAnimation';

const SECTIONS = ['intro', 'layers', 'flow', 'payments', 'rewards'];
const LAYER_KEYS = ['discovery', 'transport', 'metering', 'payments', 'reputation'];

let mermaidPromise = null;
let mermaidInitialized = false;

// Loaded via dynamic import only when this tab actually mounts, so the
// ~500KB mermaid library never enters the main bundle shipped to every
// other tab (see notes/dev-plan.md's bundle-size note).
function loadMermaid() {
  if (!mermaidPromise) mermaidPromise = import('mermaid').then((m) => m.default);
  return mermaidPromise;
}

// Diagram label text (src/data/protocolDiagrams.js) is 100% static, authored
// in src/i18n/en.js + zh.js — never user- or network-supplied — so 'loose'
// security (needed for the <br/> line breaks in stack-diagram labels) does
// not open any injection surface.
function MermaidDiagram({ id, source, summary }) {
  const [svg, setSvg] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = await loadMermaid();
        if (!mermaidInitialized) {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'loose',
            theme: 'base',
            themeVariables: {
              background: '#0A3324',
              primaryColor: '#0A3324',
              primaryTextColor: '#FFFFFF',
              primaryBorderColor: '#10B981',
              lineColor: '#10B981',
              secondaryColor: '#06281B',
              tertiaryColor: '#001408',
              textColor: '#FFFFFF',
              actorBkg: '#0A3324',
              actorBorder: '#10B981',
              actorTextColor: '#FFFFFF',
              signalColor: '#10B981',
              signalTextColor: '#FFFFFF',
              noteBkgColor: '#06281B',
              noteTextColor: 'rgba(255,255,255,0.85)',
              noteBorderColor: '#10B981',
              labelBoxBkgColor: '#0A3324',
              labelTextColor: '#FFFFFF',
              loopTextColor: '#FFFFFF',
            },
          });
          mermaidInitialized = true;
        }
        const { svg: rendered } = await mermaid.render(id, source);
        if (!cancelled) setSvg(rendered);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [id, source]);

  return (
    <div className="protocol-diagram">
      {svg ? (
        <div className="protocol-diagram__svg" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : failed ? (
        <pre className="protocol-diagram__fallback">{source}</pre>
      ) : (
        <div className="protocol-diagram__loading" />
      )}
      <p className="protocol-diagram__summary">{summary}</p>
    </div>
  );
}

function Protocol() {
  const { t } = useI18n();
  const [activeSection, setActiveSection] = useState(SECTIONS[0]);
  const sectionRefs = useRef({});

  // Same pattern as About.jsx: highlight whichever section is in view,
  // not only on click, so free scrolling still updates the vertical nav.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;
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

  const setRef = (id) => (el) => { sectionRefs.current[id] = el; };

  return (
    <div className="about-layout">
      <nav className="about-nav">
        {SECTIONS.map((id) => (
          <button
            key={id}
            className={`about-nav__item ${activeSection === id ? 'active' : ''}`}
            onClick={() => scrollToSection(id)}
          >
            {t(`protocol.nav.${id}`)}
          </button>
        ))}
      </nav>

      <div className="about-content">
        <div className="table-container about-section" data-section="intro" ref={setRef('intro')}>
          <h3>{t('protocol.introTitle')}</h3>
          <p>{t('protocol.introP1')}</p>
          <p>{t('protocol.introP2')}</p>
          <MermaidDiagram id="protocol-stack" source={stackDiagram(t)} summary={t('protocol.diagramStackSummary')} />
        </div>

        <div className="table-container about-section" data-section="layers" ref={setRef('layers')}>
          <h3>{t('protocol.layersTitle')}</h3>
          <div className="protocol-layers">
            {LAYER_KEYS.map((key, i) => (
              <div className="protocol-layer" key={key}>
                <div className="protocol-layer__num">{i + 1}</div>
                <div>
                  <div className="protocol-layer__plain">{t(`protocol.layer.${key}.plain`)}</div>
                  <div className="protocol-layer__tech">{t(`protocol.layer.${key}.tech`)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="table-container about-section" data-section="flow" ref={setRef('flow')}>
          <h3>{t('protocol.flowTitle')}</h3>
          <p>{t('protocol.flowP1')}</p>
          <RequestFlowAnimation t={t} />
        </div>

        <div className="table-container about-section" data-section="payments" ref={setRef('payments')}>
          <h3>{t('protocol.paymentsTitle')}</h3>
          <p>{t('protocol.paymentsP1')}</p>
          <MermaidDiagram id="protocol-payment-channel" source={paymentChannelDiagram(t)} summary={t('protocol.diagramPaymentSummary')} />
        </div>

        <div className="table-container about-section" data-section="rewards" ref={setRef('rewards')}>
          <h3>{t('protocol.rewardsTitle')}</h3>
          <p>{t('protocol.rewardsP1')}</p>
        </div>
      </div>
    </div>
  );
}

export default Protocol;
