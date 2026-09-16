// Mermaid diagram sources for the Protocol tab (src/components/Protocol.jsx).
// Each function takes the active `t()` from useI18n() and returns plain
// Mermaid syntax as a string — the diagram *is* this text, committed like
// any other source, not an image exported from a drawing tool. Editing a
// diagram means editing the label keys in src/i18n/en.js + zh.js (or the
// structure below), not reopening an external app.
//
// The third diagram this file used to hold — one request end-to-end — was
// replaced by a hand-built animated SVG (src/components/
// RequestFlowAnimation.jsx) for the same reason Mermaid was chosen over
// draw.io/Visio in the first place: it's still plain code, not an exported
// image, but a moving dot along a path reads far more clearly than a static
// sequence diagram for "here's what happens to one request."

// The five-layer protocol stack (see apps/website/docs/protocol/overview.md).
export function stackDiagram(t) {
  const layers = [
    { id: 'D', key: 'discovery' },
    { id: 'T', key: 'transport' },
    { id: 'M', key: 'metering' },
    { id: 'P', key: 'payments' },
    { id: 'R', key: 'reputation' },
  ];
  const nodes = layers.map((l) => `    ${l.id}["${t(`protocol.diagramStack.${l.key}`)}"]`).join('\n');
  const chain = layers.map((l) => l.id).join(' --> ');
  return `flowchart TD\n${nodes}\n    ${chain}`;
}

// The payment channel lifecycle — same mechanic as About.jsx's "How Payments
// Work" prose (about.paymentsP1/P2), plus the requestClose()/grace-period
// escape hatch that prose omits. See CLAUDE.md's "Payment Flow" section.
export function paymentChannelDiagram(t) {
  const buyer = t('protocol.actors.buyer');
  const seller = t('protocol.actors.seller');
  const s = (k) => t(`protocol.diagramPayment.${k}`);
  return [
    'sequenceDiagram',
    `    participant Buyer as ${buyer}`,
    '    participant Deposits as AntseedDeposits',
    '    participant Channels as AntseedChannels',
    `    participant Seller as ${seller}`,
    `    Buyer->>Deposits: ${s('step1')}`,
    `    Buyer->>Seller: ${s('step2')}`,
    `    Seller->>Channels: ${s('step3')}`,
    `    Channels->>Deposits: ${s('step4')}`,
    `    loop ${s('loopLabel')}`,
    `        Buyer->>Seller: ${s('step5')}`,
    '    end',
    `    Seller->>Channels: ${s('step6')}`,
    `    Channels->>Deposits: ${s('step7')}`,
    `    alt ${s('altLabel')}`,
    `        Buyer->>Channels: ${s('step8')}`,
    `        Note over Buyer,Channels: ${s('note1')}`,
    `        Buyer->>Channels: ${s('step9')}`,
    '    end',
  ].join('\n');
}
