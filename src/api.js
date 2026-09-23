// import.meta.env.BASE_URL is Vite's configured `base` ('/' or '/zh/'),
// so this tracks the build target automatically without a separate env var.
const API_BASE = `${import.meta.env.BASE_URL}api`.replace(/\/+/g, '/').replace(/^([^/])/, '/$1');

async function get(endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

async function post(endpoint, body) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

export async function fetchStats() {
  return get('/stats');
}

export async function fetchBuyers() {
  return get('/buyers');
}

export async function fetchSellers() {
  return get('/sellers');
}

/** Stakers, one row per (address, lock length) -- positions with the same
 *  lock duration from the same address are combined server-side.
 *  Resolves to `{ items, total, offset, limit, hasMore }`. */
export async function fetchStakers({ limit = 100, offset = 0, q = '' } = {}) {
  const query = `limit=${limit}&offset=${offset}` + (q ? `&q=${encodeURIComponent(q)}` : '');
  return get(`/stakers?${query}`);
}

export async function fetchServices() {
  return get('/services');
}

export async function fetchProviderModels() {
  return get('/provider/models');
}

export async function fetchChainStats() {
  return get('/chain-stats');
}

export async function fetchEmissionsEpochInfo() {
  return get('/emissions/epoch-info');
}

export async function fetchEmissionsPending(address, epochs, bustCache = false, buyerAddresses = []) {
 const bust = bustCache ? '&bust=1' : '';
 const buyerParam = buyerAddresses.length ? `&buyer_addresses=${buyerAddresses.join(',')}` : '';
 return get(`/emissions/pending?address=${address}&epochs=${epochs.join(',')}${bust}${buyerParam}`);
}

export async function fetchEmissionsBalance(address) {
return get(`/emissions/balance?address=${address}`);
}

export async function fetchRewards(address, bustCache = false) {
const bust = bustCache ? '&bust=1' : '';
return get(`/rewards?address=${address}${bust}`);
}

/**
 * lANTS NFT market, paginated/filtered/sorted server-side. `params` may
 * include: page, pageSize, sort ('id'|'amount'|'lockDays'|'daysRemaining'|
 * 'price'), dir ('asc'|'desc'), owner, agentId, minAmount, maxAmount,
 * minLockDays, maxLockDays, listed ('1' for listed-only), wait ('1' to
 * force a synchronous refresh instead of stale-while-revalidate).
 */
export async function fetchLantsMarket(params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') qs.set(k, v);
  }
  const q = qs.toString();
  return get(`/lants-market${q ? `?${q}` : ''}`);
}

export async function postLantsListing(body) {
  return post('/lants/list', body);
}

/** The stored signed Seaport order for a listed lANTS token, for direct on-chain fulfillment. */
export async function fetchLantsOrder(tokenId) {
  return get(`/lants/order/${tokenId}`);
}

export async function cancelLantsListing({ tokenId, message, signature }) {
  return post('/lants/cancel', { tokenId, message, signature });
}

export async function postLantsOffer(body) {
  return post('/lants/offer', body);
}

/** All active (not cancelled/accepted) offers on one token. */
export async function fetchLantsOffers(tokenId) {
  return get(`/lants/offers/${tokenId}`);
}

/** One offer's stored signed order, for the owner to fulfill directly. */
export async function fetchLantsOffer(offerId) {
  return get(`/lants/offer/${offerId}`);
}

export async function cancelLantsOffer({ offerId, message, signature }) {
  return post('/lants/offer/cancel', { offerId, message, signature });
}

/** Records that an offer was accepted -- call this after the on-chain
 *  fulfillOrder() tx confirms, not before. `seller` is the accepting
 *  (current owner's) wallet, recorded into the trade history. `txHash`
 *  is optional but should be the accept tx's hash when available, so the
 *  History tab's record of this trade carries a real on-chain reference. */
export async function acceptLantsOffer(offerId, seller, txHash) {
  return post('/lants/offer/accept', { offerId, seller, txHash });
}

/** Records a completed listing purchase for the History tab -- call after
 *  the buyer's fulfillOrder() tx confirms. */
export async function postLantsTrade(body) {
  return post('/lants/trade', body);
}

/** Paginated trade history (listing buys + accepted offers), newest first. */
export async function fetchLantsTrades(params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') qs.set(k, v);
  }
  const q = qs.toString();
  return get(`/lants/trades${q ? `?${q}` : ''}`);
}

export async function fetchDepositsConfig() {
return get('/deposits/config');
}
export async function fetchDepositsBalance(buyerAddress) {
return get(`/deposits/balance?address=${buyerAddress}`);
}

export async function fetchDepositsOperator(address) {
return get(`/deposits/operator?address=${address}`);
}

export async function fetchChannels() {
return get('/channels');
}

export async function fetchBuyerUsage() {
return get('/buyer-usage');
}

/** Returns the tokenomics payload. The server answers immediately from its
 *  cache (flagging `stale: true` while a background chain refresh runs), so
 *  this resolves fast even on a cold backend.
 *  Pass `{ wait: true }` to block until fresh on-chain data is available. */
export async function fetchTokenomics({ wait = false } = {}) {
  return get(`/tokenomics${wait ? '?wait=1' : ''}`);
}

export async function fetchHistoryDaily(days = 90) {
  return get(`/history/daily?days=${days}`);
}

export async function fetchHistoryEpochs(limit = 30) {
  return get(`/history/epochs?limit=${limit}`);
}

/** One page of buyers, newest-spend first.
 *  Resolves to `{ items, total, offset, limit, hasMore }`. */
export async function fetchHistoryBuyers({ limit = 100, offset = 0, q = '' } = {}) {
  const query = `limit=${limit}&offset=${offset}` + (q ? `&q=${encodeURIComponent(q)}` : '');
  return get(`/history/buyers?${query}`);
}

/** One buyer's full activity (spend, deposits/withdrawals, requests,
 *  input/output tokens, channel count, unique sellers, first/last seen) --
 *  the detail shown when a row is clicked on the Buyers tab. */
export async function fetchBuyerActivity(address) {
  return get(`/history/buyer/${encodeURIComponent(address)}`);
}

export async function fetchHistorySellers(limit = 200) {
  return get(`/history/sellers?limit=${limit}`);
}

/** One seller's full activity (earned, stake, requests, input/output
 *  tokens, unique buyers, channel count, first/last seen) -- the
 *  seller-side mirror of fetchBuyerActivity. */
export async function fetchSellerActivity(address) {
  return get(`/history/seller/${encodeURIComponent(address)}`);
}

/** Current-epoch buyer points + potential-reward estimates, paginated.
 *  Resolves to `{ epoch, items, total, offset, limit, hasMore }`. */
export async function fetchEpochBuyers({ limit = 100, offset = 0, q = '' } = {}) {
  const query = `limit=${limit}&offset=${offset}` + (q ? `&q=${encodeURIComponent(q)}` : '');
  return get(`/epoch/buyers?${query}`);
}

/** Current-epoch seller points/stake/potential-reward estimates, paginated. */
export async function fetchEpochSellers({ limit = 100, offset = 0, q = '' } = {}) {
  const query = `limit=${limit}&offset=${offset}` + (q ? `&q=${encodeURIComponent(q)}` : '');
  return get(`/epoch/sellers?${query}`);
}
