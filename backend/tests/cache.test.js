import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupExpiredCacheEntries } from '../lib/cache.js';

function createDbMock(initialChanges = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        run(value) {
          calls.push({ sql, value });
          if (sql.includes('address_emissions')) return { changes: initialChanges.addressEmissions ?? 0 };
          if (sql.includes('address_balances')) return { changes: initialChanges.addressBalances ?? 0 };
          return { changes: initialChanges.buyerChannels ?? 0 };
        },
      };
    },
  };
}

test('cleanupExpiredCacheEntries prunes all cache tables', () => {
  const db = createDbMock({ addressEmissions: 1, addressBalances: 2, buyerChannels: 3 });
  const result = cleanupExpiredCacheEntries(db, 1_000_000);

  assert.deepEqual(result, {
    addressEmissions: 1,
    addressBalances: 2,
    buyerChannels: 3,
  });
  assert.equal(db.calls.length, 3);
});
