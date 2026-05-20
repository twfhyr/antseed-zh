const API_BASE = '/api';

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

export async function fetchComputedStats() {
  return get('/computed-stats');
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

export async function fetchNetworkStats() {
return get('/network-stats');
}

export async function fetchSpending(address, days = 7) {
return get(`/deposits/spending?address=${address}&days=${days}`);
}
