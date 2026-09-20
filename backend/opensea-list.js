// Post a wallet-signed Seaport listing to OpenSea's orderbook.
// The browser signs with @opensea/seaport-js; this file never sees a private key.
// OpenSea's API key stays here (env or a cached instant key), never in the frontend.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEAPORT_V16 = '0x0000000000000068F116a894984e2DB1123eB395';

// Instant keys are free but rate-limited to 2/day per IP (per OpenSea's
// docs) and are valid 7 days. Caching only in memory meant every dev-server
// restart threw the key away and requested a fresh one -- easy to burn the
// whole day's quota just from normal restarts during testing. Persisted to
// disk (private/, already gitignored) so a restart reuses the same key.
const KEY_FILE = join(dirname(fileURLToPath(import.meta.url)), 'private', 'opensea-key.json');

let cachedKey = null;
let cachedKeyExpires = 0;

function loadPersistedKey() {
  if (!existsSync(KEY_FILE)) return;
  try {
    const { api_key, expires_at } = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
    if (api_key && expires_at && Date.now() < expires_at) {
      cachedKey = api_key;
      cachedKeyExpires = expires_at;
    }
  } catch {
    // Corrupt or unreadable -- fall through and request a fresh key.
  }
}

function persistKey(apiKey, expiresAt) {
  try {
    mkdirSync(dirname(KEY_FILE), { recursive: true });
    writeFileSync(KEY_FILE, JSON.stringify({ api_key: apiKey, expires_at: expiresAt }, null, 2));
  } catch {
    // Non-fatal -- the in-memory cache still works for this process's lifetime.
  }
}

loadPersistedKey();

export async function resolveOpenSeaApiKey() {
  if (process.env.OPENSEA_API_KEY) return process.env.OPENSEA_API_KEY;
  if (cachedKey && Date.now() < cachedKeyExpires) return cachedKey;
  try {
    const res = await fetch('https://api.opensea.io/api/v2/auth/keys', { method: 'POST' });
    const json = await res.json();
    if (json?.api_key) {
      cachedKey = json.api_key;
      // Docs say instant keys are valid 7 days; keep a margin before the
      // real expiry so a near-expiry key doesn't get used for a mid-flight
      // listing. Fall back to a conservative 24h only if expires_at is
      // missing/unparseable.
      const exp = json.expires_at ? Date.parse(json.expires_at) : NaN;
      cachedKeyExpires = Number.isFinite(exp) ? exp - 60 * 60 * 1000 : Date.now() + 24 * 60 * 60 * 1000;
      persistKey(cachedKey, cachedKeyExpires);
      return cachedKey;
    }
  } catch {
    // Listing stays disabled until a key exists. Do not invent one.
  }
  return null;
}

function stringify(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(stringify);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = stringify(v);
    return out;
  }
  return value;
}

export async function postSeaportListing({ order, protocolAddress, chain = 'base' }) {
  const apiKey = await resolveOpenSeaApiKey();
  if (!apiKey) {
    const err = new Error('OpenSea listing is not configured (no API key).');
    err.status = 503;
    throw err;
  }
  const body = {
    protocol_address: protocolAddress || SEAPORT_V16,
    parameters: stringify(order.parameters),
    signature: order.signature,
  };
  const urls = [
    `https://api.opensea.io/api/v2/orders/${chain}/seaport/listings`,
    `https://api.opensea.io/api/v2/orders/chain/${chain}/protocol/seaport/listings`,
  ];
  let last = null;
  for (const url of urls) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (res.ok) return json;
    last = { status: res.status, body: json };
    if (res.status !== 404) break;
  }
  const err = new Error(last?.body?.errors?.[0] || last?.body?.error?.message || `OpenSea listing HTTP ${last?.status}`);
  err.status = last?.status || 502;
  err.detail = last?.body;
  throw err;
}

export { SEAPORT_V16 };
