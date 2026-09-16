// Mermaid diagram sources for the Protocol tab (src/components/Protocol.jsx).
// Each function takes the active `t()` from useI18n() and returns plain
// Mermaid syntax as a string — the diagram *is* this text, committed like
// any other source, not an image exported from a drawing tool. Editing a
// diagram means editing the label keys in src/i18n/en.js + zh.js (or the
// structure below), not reopening an external app.

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

// One request end-to-end: discovery -> connect -> stream -> meter -> settle
// -> reputation. Shows there is no server in the middle at any step.
export function requestFlowDiagram(t) {
  const buyer = t('protocol.actors.buyer');
  const dht = t('protocol.actors.dht');
  const seller = t('protocol.actors.seller');
  const s = (k) => t(`protocol.diagramRequest.${k}`);
  return [
    'sequenceDiagram',
    `    participant Buyer as ${buyer}`,
    `    participant DHT as ${dht}`,
    `    participant Seller as ${seller}`,
    `    Buyer->>DHT: ${s('step1')}`,
    `    DHT-->>Buyer: ${s('step2')}`,
    `    Buyer->>Seller: ${s('step3')}`,
    `    Buyer->>Seller: ${s('step4')}`,
    `    Seller-->>Buyer: ${s('step5')}`,
    `    Note over Buyer,Seller: ${s('note1')}`,
    `    Buyer->>Seller: ${s('step6')}`,
    `    Seller->>Seller: ${s('step7')}`,
    `    Note over Buyer,Seller: ${s('note2')}`,
  ].join('\n');
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
