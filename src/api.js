// import.meta.env.BASE_URL is Vite's configured `base` ('/' or '/zh/'),
// so this tracks the build target automatically without a separate env var.
const API_BASE = `${import.meta.env.BASE_URL}api`.replace(/\/+/g, '/').replace(/^([^/])/, '/$1');

async function get(endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
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

export async function fetchHistorySellers(limit = 200) {
  return get(`/history/sellers?limit=${limit}`);
}
