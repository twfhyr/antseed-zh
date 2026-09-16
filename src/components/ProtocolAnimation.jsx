import React, { useEffect, useState } from 'react';
import { Play, Pause } from 'lucide-react';

// The Protocol tab's single animated diagram — the whole AntSeed request
// workflow as an ant colony: two ants (Buyer, Seller) and a shared mound
// (the public DHT). Plain SVG + CSS/SMIL, hand-built, not an exported
// image — editing a step means editing the STEP_* tables below or the
// protocol.anim.* copy in src/i18n/en.js + zh.js.
//
// Request and response travel on two separate lanes (upper = buyer→seller,
// lower = seller→buyer), each with its own color and arrowhead, so the two
// directions never read as the same line retraced. USDC payment reuses the
// upper (buyer→seller) lane but travels as a seed — AntSeed's own "food an
// ant carries home" metaphor for a settled payment — instead of a plain dot.

const STEPS = ['discovery', 'request', 'response', 'payment', 'reputation'];
const STEP_DURATION_MS = { discovery: 2600, request: 1700, response: 1700, payment: 1900, reputation: 2400 };

const BUYER = { x: 110, y: 215 };
const DHT = { x: 390, y: 62 };
const SELLER = { x: 670, y: 215 };

const REQUEST_COLOR = 'var(--accent)';
const RESPONSE_COLOR = '#3B82F6';
const PAYMENT_COLOR = 'var(--clay)';

// Two distinct lanes between buyer and seller — never the same path reused
// in both directions.
const PATH_REQUEST = `M${BUYER.x + 24},${BUYER.y - 18} Q${(BUYER.x + SELLER.x) / 2},${(BUYER.y + SELLER.y) / 2 - 58} ${SELLER.x - 24},${SELLER.y - 18}`;
const PATH_RESPONSE = `M${SELLER.x - 24},${SELLER.y + 18} Q${(BUYER.x + SELLER.x) / 2},${(BUYER.y + SELLER.y) / 2 + 58} ${BUYER.x + 24},${BUYER.y + 18}`;
// Discovery: one lane, there and back (ask the mound, then return).
const PATH_DISCOVERY = `M${BUYER.x},${BUYER.y - 34} Q${(BUYER.x + DHT.x) / 2 - 15},${DHT.y + 6} ${DHT.x},${DHT.y + 32} Q${(BUYER.x + DHT.x) / 2 + 45},${(BUYER.y + DHT.y) / 2 + 45} ${BUYER.x},${BUYER.y - 34}`;

const STEP_PATH = {
  discovery: PATH_DISCOVERY,
  request: PATH_REQUEST,
  response: PATH_RESPONSE,
  payment: PATH_REQUEST,
  reputation: null,
};
const STEP_DOT_COLOR = {
  discovery: REQUEST_COLOR,
  request: REQUEST_COLOR,
  response: RESPONSE_COLOR,
  payment: PAYMENT_COLOR,
};

function AntIcon({ x, y, label, color, flip }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <g transform={flip ? 'scale(-1,1)' : undefined}>
        <g className="protocol-ant__legs">
          <line x1="-2" y1="-3" x2="-13" y2="-11" />
          <line x1="-2" y1="0" x2="-16" y2="0" />
          <line x1="-2" y1="3" x2="-13" y2="11" />
          <line x1="9" y1="-3" x2="19" y2="-10" />
          <line x1="9" y1="0" x2="21" y2="0" />
          <line x1="9" y1="3" x2="19" y2="10" />
          <line x1="-9" y1="-6" x2="-14" y2="-17" />
          <line x1="-6" y1="-7" x2="-9" y2="-18" />
        </g>
        <ellipse cx="10" cy="0" rx="11" ry="8" fill={color} />
        <ellipse cx="-1" cy="0" rx="5.5" ry="5" fill={color} />
        <circle cx="-9" cy="-4" r="4.5" fill={color} />
      </g>
      <text y="38" textAnchor="middle" className="protocol-flow-anim__node-label">{label}</text>
    </g>
  );
}

function MoundIcon({ x, y, label, active }) {
  return (
    <g transform={`translate(${x},${y})`} className={`protocol-mound ${active ? 'active' : ''}`}>
      <path d="M -22,14 Q -22,-16 0,-16 Q 22,-16 22,14 Z" className="protocol-mound__hill" />
      <circle cy="7" r="4" className="protocol-mound__hole" />
      <text y="34" textAnchor="middle" className="protocol-flow-anim__node-label">{label}</text>
    </g>
  );
}

function ProtocolAnimation({ t }) {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const current = STEPS[step];

  useEffect(() => {
    if (!playing) return;
    const id = setTimeout(() => setStep((s) => (s + 1) % STEPS.length), STEP_DURATION_MS[STEPS[step]]);
    return () => clearTimeout(id);
  }, [step, playing]);

  const path = STEP_PATH[current];
  const dotColor = STEP_DOT_COLOR[current];
  const isSeed = current === 'payment';

  return (
    <div className="protocol-flow-anim">
      <svg viewBox="0 0 780 300" className="protocol-flow-anim__svg" role="img" aria-label={t(`protocol.anim.${current}.title`)}>
        <defs>
          <marker id="pf-arrow-req" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={REQUEST_COLOR} />
          </marker>
          <marker id="pf-arrow-res" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={RESPONSE_COLOR} />
          </marker>
        </defs>

        <path
          d={PATH_DISCOVERY}
          markerEnd="url(#pf-arrow-req)"
          className={`protocol-flow-anim__line ${current === 'discovery' ? 'active' : ''}`}
          style={{ stroke: REQUEST_COLOR }}
        />
        <path
          d={PATH_REQUEST}
          markerEnd="url(#pf-arrow-req)"
          className={`protocol-flow-anim__line ${current === 'request' || current === 'payment' ? 'active' : ''}`}
          style={{ stroke: REQUEST_COLOR }}
        />
        <path
          d={PATH_RESPONSE}
          markerEnd="url(#pf-arrow-res)"
          className={`protocol-flow-anim__line ${current === 'response' ? 'active' : ''}`}
          style={{ stroke: RESPONSE_COLOR }}
        />

        <MoundIcon x={DHT.x} y={DHT.y} label={t('protocol.actors.dht')} active={current === 'discovery'} />
        <AntIcon x={BUYER.x} y={BUYER.y} label={t('protocol.actors.buyer')} color={REQUEST_COLOR} flip />
        <AntIcon x={SELLER.x} y={SELLER.y} label={t('protocol.actors.seller')} color={RESPONSE_COLOR} />

        {path && (
          // Keyed by step so React remounts this node, restarting the SMIL
          // animateMotion cleanly instead of retargeting a live animation.
          <g key={step}>
            {isSeed ? (
              <ellipse rx="6.5" ry="4" fill={dotColor} className="protocol-flow-anim__dot">
                <animateMotion path={path} dur={`${Math.max(STEP_DURATION_MS[current] - 300, 400) / 1000}s`} rotate="auto" fill="freeze" />
              </ellipse>
            ) : (
              <circle r="6" fill={dotColor} className="protocol-flow-anim__dot">
                <animateMotion path={path} dur={`${Math.max(STEP_DURATION_MS[current] - 300, 400) / 1000}s`} fill="freeze" />
              </circle>
            )}
          </g>
        )}

        {current === 'reputation' && (
          <g key={step} transform={`translate(${SELLER.x + 32}, ${SELLER.y - 32})`} className="protocol-flow-anim__badge">
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
          {STEPS.map((s, i) => (
            <button
              key={s}
              type="button"
              className={`protocol-flow-anim__step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}
              onClick={() => { setPlaying(false); setStep(i); }}
              aria-label={t(`protocol.anim.${s}.title`)}
            >
              {i + 1}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default ProtocolAnimation;
