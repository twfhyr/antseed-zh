import db from '../database.js';
import { readIntEnv } from './env.js';

export const CACHE_TTLS = {
  addressEmissions: readIntEnv('ADDRESS_EMISSIONS_TTL_MS', 5 * 60 * 1000),
  addressBalances: readIntEnv('ADDRESS_BALANCES_TTL_MS', 10 * 60 * 1000),
  buyerChannels: readIntEnv('BUYER_CHANNELS_TTL_MS', 5 * 60 * 1000),
};

export function cleanupExpiredCacheEntries(database = db, now = Date.now()) {
  const results = {
    addressEmissions: 0,
    addressBalances: 0,
    buyerChannels: 0,
  };

  results.addressEmissions = database.prepare('DELETE FROM address_emissions WHERE fetched_at < ?').run(now - CACHE_TTLS.addressEmissions).changes;
  results.addressBalances = database.prepare('DELETE FROM address_balances WHERE fetched_at < ?').run(now - CACHE_TTLS.addressBalances).changes;
  results.buyerChannels = database.prepare('DELETE FROM buyer_channels WHERE fetched_at < ?').run(now - CACHE_TTLS.buyerChannels).changes;

  return results;
}

export function startCacheCleanup(database = db, intervalMs = readIntEnv('CACHE_CLEANUP_INTERVAL_MS', 15 * 60 * 1000)) {
  cleanupExpiredCacheEntries(database);
  return setInterval(() => {
    try {
      cleanupExpiredCacheEntries(database);
    } catch (error) {
      console.error('[cache-cleanup] Failed to prune cache tables:', error.message || error);
    }
  }, intervalMs);
}
