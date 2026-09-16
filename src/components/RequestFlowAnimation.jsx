import React, { useEffect, useState } from 'react';
import { Search, Link2, MessageSquare, Coins, Star, Play, Pause } from 'lucide-react';

// Hand-built animated SVG for the Protocol tab's "one request, end to end"
// section — replaces what used to be a static Mermaid sequence diagram (see
// src/data/protocolDiagrams.js's header comment). Still plain code (a JSX
// component + CSS), never an exported image: editing a step means editing
// the STEP_PATH/i18n copy below, not reopening a drawing tool.
//
// Five steps, one per protocol layer (see protocol.layer.* / the "layers"
// section above this one on the page) applied to a single concrete request:
// discovery, connect, request+response, payment, reputation.

const STEPS = ['discovery', 'connect', 'request', 'payment', 'reputation'];
const STEP_ICONS = { discovery: Search, connect: Link2, request: MessageSquare, payment: Coins, reputation: Star };
const STEP_DURATION_MS = { discovery: 2800, connect: 1900, request: 2800, payment: 1900, reputation: 2400 };

// Node centers in the 0 0 700 260 viewBox.
const BUYER = { x: 80, y: 180, r: 32 };
const DHT = { x: 350, y: 55, r: 22 };
const SELLER = { x: 620, y: 180, r: 32 };

// A slightly different curve each direction so the two arcs read as
// separate paths rather than one retraced line.
const PATH_DISCOVERY = `M${BUYER.x},${BUYER.y} Q215,70 ${DHT.x},${DHT.y} Q215,150 ${BUYER.x},${BUYER.y}`;
const PATH_TO_SELLER = `M${BUYER.x},${BUYER.y} Q350,225 ${SELLER.x},${SELLER.y}`;
const PATH_ROUNDTRIP = `M${BUYER.x},${BUYER.y} Q350,225 ${SELLER.x},${SELLER.y} Q350,235 ${BUYER.x},${BUYER.y}`;

const STEP_PATH = {
  discovery: PATH_DISCOVERY,
  connect: PATH_TO_SELLER,
  request: PATH_ROUNDTRIP,
  payment: PATH_TO_SELLER,
  reputation: null,
};

function Node({ x, y, r, label, active }) {
  return (
    <g>
      <circle cx={x} cy={y} r={r} className={`protocol-flow-anim__node ${active ? 'active' : ''}`} />
      <text x={x} y={y + 5} textAnchor="middle" className="protocol-flow-anim__node-label">{label}</text>
    </g>
  );
}

function RequestFlowAnimation({ t }) {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const current = STEPS[step];

  useEffect(() => {
    if (!playing) return;
    const id = setTimeout(() => setStep((s) => (s + 1) % STEPS.length), STEP_DURATION_MS[STEPS[step]]);
    return () => clearTimeout(id);
  }, [step, playing]);

  const dhtActive = current === 'discovery';
  const sellerActive = current !== 'discovery';
  const lineToDhtActive = current === 'discovery';
  const lineToSellerActive = current === 'connect' || current === 'request' || current === 'payment';
  const path = STEP_PATH[current];
  const dotColor = current === 'payment' ? 'var(--clay)' : 'var(--accent)';

  return (
    <div className="protocol-flow-anim">
      <svg viewBox="0 0 700 260" className="protocol-flow-anim__svg" role="img" aria-label={t(`protocol.anim.${current}.title`)}>
        <path d={PATH_DISCOVERY} className={`protocol-flow-anim__line ${lineToDhtActive ? 'active' : ''}`} />
        <path d={PATH_TO_SELLER} className={`protocol-flow-anim__line ${lineToSellerActive ? 'active' : ''}`} />

        <Node x={BUYER.x} y={BUYER.y} r={BUYER.r} label={t('protocol.actors.buyer')} active />
        <Node x={DHT.x} y={DHT.y} r={DHT.r} label={t('protocol.actors.dht')} active={dhtActive} />
        <Node x={SELLER.x} y={SELLER.y} r={SELLER.r} label={t('protocol.actors.seller')} active={sellerActive} />

        {path && (
          // Keyed by step so React remounts this <circle>, restarting its
          // SMIL animateMotion cleanly instead of trying to retarget a live one.
          <g key={step}>
            <circle r="7" fill={dotColor} className="protocol-flow-anim__dot">
              <animateMotion path={path} dur={`${Math.max(STEP_DURATION_MS[current] - 300, 400) / 1000}s`} fill="freeze" />
            </circle>
          </g>
        )}

        {current === 'reputation' && (
          <g key={step} transform={`translate(${SELLER.x + 30}, ${SELLER.y - 30})`} className="protocol-flow-anim__badge">
            <circle r="13" className="protocol-flow-anim__badge-circle" />
            <text y="5" textAnchor="middle" className="protocol-flow-anim__badge-star">★</text>
          </g>
        )}
      </svg>

      <div className="protocol-flow-anim__caption">
        <strong>{t(`protocol.anim.${current}.title`)}</strong>
        <span>{t(`protocol.anim.${current}.body`)}</span>
      </div>

      <div className="protocol-flow-anim__controls">
        <button
          type="button"
          className="protocol-flow-anim__playbtn"
          onClick={() => setPlaying((p) => !p)}
          aria-label={t(playing ? 'protocol.anim.pause' : 'protocol.anim.play')}
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <div className="protocol-flow-anim__steps">
          {STEPS.map((s, i) => {
            const Icon = STEP_ICONS[s];
            return (
              <button
                key={s}
                type="button"
                className={`protocol-flow-anim__step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}
                onClick={() => { setPlaying(false); setStep(i); }}
                aria-label={t(`protocol.anim.${s}.title`)}
              >
                <Icon size={14} />
                <span>{i + 1}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default RequestFlowAnimation;
