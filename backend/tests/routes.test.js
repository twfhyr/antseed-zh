import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerCoreRoutes } from '../routes/core.js';
import { registerAdminRoutes } from '../routes/admin.js';
import { asyncHandler } from '../lib/async.js';
import { cleanupExpiredCacheEntries } from '../lib/cache.js';
import Database from 'better-sqlite3';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE buyers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
      total_spent REAL DEFAULT 0, requests INTEGER DEFAULT 0,
      avg_latency INTEGER DEFAULT 0, joined TEXT NOT NULL
    );
    CREATE TABLE sellers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
      total_earned REAL DEFAULT 0, capacity TEXT NOT NULL,
      uptime REAL DEFAULT 0, models INTEGER DEFAULT 0, joined TEXT NOT NULL
    );
    CREATE TABLE services (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL,
      seller_id TEXT NOT NULL, seller_name TEXT NOT NULL,
      categories TEXT NOT NULL, protocols TEXT NOT NULL,
      pricing_input REAL DEFAULT 0, pricing_cached_input REAL DEFAULT 0,
      pricing_output REAL DEFAULT 0, max_concurrency INTEGER DEFAULT 0,
      current_load INTEGER DEFAULT 0, status TEXT NOT NULL
    );
    CREATE TABLE stats (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      total_buyers INTEGER DEFAULT 0, total_sellers INTEGER DEFAULT 0,
      total_services INTEGER DEFAULT 0, total_volume REAL DEFAULT 0,
      active_transactions INTEGER DEFAULT 0, buyer_growth REAL DEFAULT 0,
      seller_growth REAL DEFAULT 0, service_growth REAL DEFAULT 0,
      volume_growth REAL DEFAULT 0, transaction_growth REAL DEFAULT 0
    );
    CREATE TABLE address_emissions (
      address TEXT PRIMARY KEY, data TEXT NOT NULL, fetched_at INTEGER NOT NULL
    );
    CREATE TABLE address_balances (
      address TEXT PRIMARY KEY, ants REAL, fetched_at INTEGER NOT NULL
    );
    CREATE TABLE buyer_channels (
      address TEXT PRIMARY KEY, data TEXT NOT NULL, fetched_at INTEGER NOT NULL
    );
    CREATE TABLE operator_buyers (
      operator TEXT NOT NULL, buyer TEXT NOT NULL, PRIMARY KEY (operator, buyer)
    );
    INSERT INTO stats (id) VALUES (1);
  `);
  return db;
}

function createApp(db) {
  const app = express();
  app.use(express.json());

  const originalPrepare = db.prepare.bind(db);
  const dbProxy = new Proxy(db, {
    get(target, prop) {
      return target[prop];
    },
  });

  registerCoreRoutes(app);

  app.use('/api', (error, _req, res, _next) => {
    const status = error.status || 500;
    res.status(status).json({ error: error.message || 'Internal Server Error' });
  });

  return app;
}

test('admin routes reject without API key', async () => {
  const app = express();
  app.use(express.json());

  const requireAdminAccess = (_req, res, _next) => {
    return res.status(503).json({ error: 'Admin API key is not configured' });
  };

  registerAdminRoutes(app, {
    requireAdminAccess,
    updateChainMetrics: async () => ({}),
    syncFromOfficialNetwork: async () => {},
  });

  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://localhost:${port}/api/admin/sync`, { method: 'POST' });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.ok(body.error.includes('API key'));
  } finally {
    server.close();
  }
});

test('admin routes accept valid API key', async () => {
  const app = express();
  app.use(express.json());

  const API_KEY = 'test-secret-key';
  const requireAdminAccess = (req, res, next) => {
    if (req.header('x-admin-api-key') !== API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };

  registerAdminRoutes(app, {
    requireAdminAccess,
    updateChainMetrics: async () => ({ epoch: 1 }),
    syncFromOfficialNetwork: async () => {},
  });

  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://localhost:${port}/api/admin/force-chain-sync`, {
      method: 'POST',
      headers: { 'x-admin-api-key': API_KEY },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
  } finally {
    server.close();
  }
});

test('stats endpoint returns seeded data', async () => {
  const db = createTestDb();
  db.prepare('UPDATE stats SET total_buyers = 5, total_sellers = 3 WHERE id = 1').run();

  const row = db.prepare('SELECT * FROM stats WHERE id = 1').get();
  assert.equal(row.total_buyers, 5);
  assert.equal(row.total_sellers, 3);

  db.close();
});

test('computed-stats counts from tables', async () => {
  const db = createTestDb();
  db.prepare('INSERT INTO buyers (id, name, status, total_spent, requests, avg_latency, joined) VALUES (?, ?, ?, ?, ?, ?, ?)').run('b1', 'Test', 'online', 100, 5, 10, '2024-01-01');

  const buyerCount = db.prepare('SELECT COUNT(*) as c FROM buyers').get().c;
  const totalVolume = db.prepare('SELECT SUM(total_spent) as s FROM buyers').get().s ?? 0;
  assert.equal(buyerCount, 1);
  assert.equal(totalVolume, 100);

  db.close();
});

test('cache cleanup removes expired entries', () => {
  const db = createTestDb();
  const now = Date.now();
  db.prepare('INSERT INTO address_emissions (address, data, fetched_at) VALUES (?, ?, ?)').run('addr1', '{}', now - 999999);
  db.prepare('INSERT INTO address_emissions (address, data, fetched_at) VALUES (?, ?, ?)').run('addr2', '{}', now);
  db.prepare('INSERT INTO address_balances (address, ants, fetched_at) VALUES (?, ?, ?)').run('addr1', 0, now - 999999);
  db.prepare('INSERT INTO buyer_channels (address, data, fetched_at) VALUES (?, ?, ?)').run('addr1', '{}', now - 999999);

  const result = cleanupExpiredCacheEntries(db, now);
  assert.equal(result.addressEmissions, 1);
  assert.equal(result.addressBalances, 1);
  assert.equal(result.buyerChannels, 1);

  const remaining = db.prepare('SELECT COUNT(*) as c FROM address_emissions').get().c;
  assert.equal(remaining, 1);

  db.close();
});
