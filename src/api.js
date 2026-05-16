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

export async function fetchChainStats() {
  return get('/chain-stats');
}

export async function fetchEmissionsEpochInfo() {
  return get('/emissions/epoch-info');
}

export async function fetchEmissionsPending(address, epochs, bustCache = false) {
  const bust = bustCache ? '&bust=1' : '';
  return get(`/emissions/pending?address=${address}&epochs=${epochs.join(',')}${bust}`);
}

export async function fetchEmissionsBalance(address) {
  return get(`/emissions/balance?address=${address}`);
}
