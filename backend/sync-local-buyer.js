// ── Network catalog from the LOCAL buyer node ──
//
// WHY THIS EXISTS (read before changing the data source back):
// The catalog used to come from `https://network.antseed.com/stats`, a hosted
// indexer snapshot. Per the AntSeed founder, that snapshot is outdated and
// clients should read the local buyer node instead. Measured on this server:
// `/stats` was 176 minutes stale while the local node's freshest `lastSeen`
// was 70 minutes old, and the local node advertised 403 services vs 400 in
// the snapshot. Same 53 peers, but the local view is the live DHT view.
//
// The buyer node exposes `GET /_antseed/peers` — its own discovered-peer
// cache, served locally with no seller contacted. That is the authoritative
// live catalog. Prefer it; `/stats` remains only as a fallback (see
// sync-official.js) for when no buyer node is reachable.
//
// SHAPE DIFFERENCE from /stats (the reason this isn't a one-line swap):
//   /stats  : peer.providers = [{ provider, services[], servicePricing{},
//             serviceCategories{}, serviceApiProtocols{}, maxConcurrency }]
//   local   : peer.providers = ["openai"]            (plain strings)
//             peer.providerPricing = { openai: { defaults{}, services{} } }
//             peer.providerServiceCategories = { openai: { services{} } }
//             peer.providerServiceApiProtocols = { openai: { services{} } }
// This module normalizes the local shape into the /stats-like shape the rest
// of the sync already understands, so the DB write path stays unchanged.
//
// TWO FIELD GROUPS THE LOCAL NODE DOES NOT HAVE, and must not be faked:
//   - `onChainStats` (agentId, totalRequests, uniqueBuyers, firstSeenAt) and
//     `verifications`. These are indexer/chain enrichments. When syncing from
//     the local node these are absent, so the seller columns they feed stay
//     null and the UI shows "—" rather than an invented value. They are
//     re-attached from the chain/Antscan sync paths that own them.
//   - `maxConcurrency` / `currentLoad`. Not advertised here; left null.

// 8377 is the protocol's documented buyer-proxy port and stays the first
// candidate. Operators commonly run a second node on 8378 (this server does),
// so probe that too instead of silently failing over to the stale hosted
// snapshot. An explicit BUYER_BASE_URL/PROVIDER_BASE_URL always wins and is
// used alone — no probing behind the operator's back.
const DEFAULT_BUYER_CANDIDATES = ['http://localhost:8377', 'http://localhost:8378'];

const CONFIGURED_BUYER_BASE = process.env.BUYER_BASE_URL
  || (process.env.PROVIDER_BASE_URL
    ? process.env.PROVIDER_BASE_URL.replace(/\/v1\/?$/, '')
    : null);

const DEFAULT_BUYER_BASE = CONFIGURED_BUYER_BASE ?? DEFAULT_BUYER_CANDIDATES[0];

/** Milliseconds before we give up on the local node and let the caller fall back. */
const FETCH_TIMEOUT_MS = 20_000;

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convert one local-buyer peer record into the /stats-style peer shape.
 *
 * Provider names are the UNION of `providers[]` and the keys of
 * `providerPricing` on purpose: 7 of 53 live peers publish an empty
 * `providers[]` while still advertising priced services, so trusting
 * `providers[]` alone silently drops 6 peers' entire catalogs.
 */
function normalizeLocalPeer(peer) {
  const pricingByProvider = peer.providerPricing ?? {};
  const categoriesByProvider = peer.providerServiceCategories ?? {};
  const protocolsByProvider = peer.providerServiceApiProtocols ?? {};
  const capabilitiesByProvider = peer.providerServiceCapabilities ?? {};

  const providerNames = [...new Set([
    ...(Array.isArray(peer.providers) ? peer.providers : []),
    ...Object.keys(pricingByProvider),
  ])].filter(Boolean);

  const providers = providerNames.map((name) => {
    const pricing = pricingByProvider[name] ?? {};
    const servicePricing = pricing.services ?? {};
    const serviceCategories = categoriesByProvider[name]?.services ?? {};
    const serviceProtocols = protocolsByProvider[name]?.services ?? {};
    const serviceCapabilities = capabilitiesByProvider[name]?.services ?? {};

    // A service is anything named by any of the per-service maps. Pricing
    // alone is not enough: a seller can advertise a service that falls back
    // to `defaults` and so never appears under `services`.
    const services = [...new Set([
      ...Object.keys(servicePricing),
      ...Object.keys(serviceCategories),
      ...Object.keys(serviceProtocols),
      ...Object.keys(serviceCapabilities),
    ])];

    return {
      provider: name,
      services,
      defaultPricing: pricing.defaults ?? {},
      servicePricing,
      serviceCategories,
      serviceApiProtocols: serviceProtocols,
      serviceCapabilities,
    };
  });

  return {
    peerId: peer.peerId,
    displayName: peer.displayName,
    publicAddress: peer.publicAddress,
    providers,
    capabilities: peer.capabilities ?? [],
    reputationScore: peer.reputationScore ?? null,
    lastSeen: peer.lastSeen ?? null,
    // Deliberately absent: onChainStats / verifications. See header.
  };
}

/**
 * Fetch the live catalog from the local buyer node, normalized to the
 * /stats-like peer shape. Throws if the node is unreachable so the caller can
 * fall back to the hosted snapshot rather than wiping the catalog.
 */
export async function fetchLocalBuyerCatalog(baseUrl) {
  const candidates = baseUrl
    ? [String(baseUrl)]
    : (CONFIGURED_BUYER_BASE ? [CONFIGURED_BUYER_BASE] : DEFAULT_BUYER_CANDIDATES);

  let lastErr;
  for (const candidate of candidates) {
    try {
      return await fetchFromBuyer(candidate);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('no local buyer candidate reachable');
}

async function fetchFromBuyer(baseUrl) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const payload = await getJson(`${base}/_antseed/peers`);
  const rawPeers = payload?.peers;
  if (!Array.isArray(rawPeers)) {
    throw new Error('local buyer /_antseed/peers returned no peers array');
  }
  if (rawPeers.length === 0) {
    // An empty DHT view is almost always a node that just started and hasn't
    // discovered anyone yet. Treat it as a failure so we don't replace a good
    // catalog with nothing.
    throw new Error('local buyer returned 0 peers (node likely still warming up)');
  }

  const peers = rawPeers.map(normalizeLocalPeer);
  const freshest = peers.reduce(
    (max, p) => (typeof p.lastSeen === 'number' && p.lastSeen > max ? p.lastSeen : max),
    0,
  );

  return {
    source: 'local-buyer',
    baseUrl: base,
    // Freshness of the underlying observations, not of this fetch.
    updatedAt: freshest > 0 ? new Date(freshest).toISOString() : new Date().toISOString(),
    peers,
  };
}

export { DEFAULT_BUYER_BASE };
