import db from '../database.js';
import { camelize, parseService } from '../lib/formatters.js';

export function registerCoreRoutes(app) {
  app.get('/api/stats', (_req, res) => {
    const row = db.prepare('SELECT * FROM stats WHERE id = 1').get();
    if (!row) return res.status(404).json({ error: 'Stats not found' });
    res.json({
      totalBuyers: row.total_buyers,
      totalSellers: row.total_sellers,
      totalServices: row.total_services,
      totalVolume: row.total_volume,
      activeTransactions: row.active_transactions,
      buyerGrowth: row.buyer_growth,
      sellerGrowth: row.seller_growth,
      serviceGrowth: row.service_growth,
      volumeGrowth: row.volume_growth,
      transactionGrowth: row.transaction_growth,
    });
  });

  app.put('/api/stats', (req, res) => {
    const {
      totalBuyers, totalSellers, totalServices, totalVolume,
      activeTransactions, buyerGrowth, sellerGrowth, serviceGrowth,
      volumeGrowth, transactionGrowth,
    } = req.body;

    const result = db.prepare(`
      UPDATE stats SET
        total_buyers = COALESCE(?, total_buyers),
        total_sellers = COALESCE(?, total_sellers),
        total_services = COALESCE(?, total_services),
        total_volume = COALESCE(?, total_volume),
        active_transactions = COALESCE(?, active_transactions),
        buyer_growth = COALESCE(?, buyer_growth),
        seller_growth = COALESCE(?, seller_growth),
        service_growth = COALESCE(?, service_growth),
        volume_growth = COALESCE(?, volume_growth),
        transaction_growth = COALESCE(?, transaction_growth)
      WHERE id = 1
    `).run(
      totalBuyers, totalSellers, totalServices, totalVolume,
      activeTransactions, buyerGrowth, sellerGrowth, serviceGrowth,
      volumeGrowth, transactionGrowth
    );

    res.json({ updated: result.changes });
  });

  app.get('/api/buyers', (_req, res) => {
    const rows = db.prepare('SELECT * FROM buyers').all();
    res.json(rows.map(camelize));
  });

  app.get('/api/buyers/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM buyers WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Buyer not found' });
    res.json(camelize(row));
  });

  app.post('/api/buyers', (req, res) => {
    const { id, name, status, totalSpent, requests, avgLatency, joined } = req.body;
    const result = db.prepare(`
      INSERT INTO buyers (id, name, status, total_spent, requests, avg_latency, joined)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, status, totalSpent ?? 0, requests ?? 0, avgLatency ?? 0, joined);
    res.status(201).json({ id: result.lastInsertRowid });
  });

  app.put('/api/buyers/:id', (req, res) => {
    const { name, status, totalSpent, requests, avgLatency, joined } = req.body;
    const result = db.prepare(`
      UPDATE buyers SET
        name = COALESCE(?, name),
        status = COALESCE(?, status),
        total_spent = COALESCE(?, total_spent),
        requests = COALESCE(?, requests),
        avg_latency = COALESCE(?, avg_latency),
        joined = COALESCE(?, joined)
      WHERE id = ?
    `).run(name, status, totalSpent, requests, avgLatency, joined, req.params.id);
    res.json({ updated: result.changes });
  });

  app.delete('/api/buyers/:id', (req, res) => {
    const result = db.prepare('DELETE FROM buyers WHERE id = ?').run(req.params.id);
    res.json({ deleted: result.changes });
  });

  app.get('/api/sellers', (_req, res) => {
    const rows = db.prepare('SELECT * FROM sellers').all();
    res.json(rows.map(camelize));
  });

  app.get('/api/sellers/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM sellers WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Seller not found' });
    res.json(camelize(row));
  });

  app.post('/api/sellers', (req, res) => {
    const { id, name, status, totalEarned, capacity, uptime, models, joined } = req.body;
    const result = db.prepare(`
      INSERT INTO sellers (id, name, status, total_earned, capacity, uptime, models, joined)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, status, totalEarned ?? 0, capacity, uptime ?? 0, models ?? 0, joined);
    res.status(201).json({ id: result.lastInsertRowid });
  });

  app.put('/api/sellers/:id', (req, res) => {
    const { name, status, totalEarned, capacity, uptime, models, joined } = req.body;
    const result = db.prepare(`
      UPDATE sellers SET
        name = COALESCE(?, name),
        status = COALESCE(?, status),
        total_earned = COALESCE(?, total_earned),
        capacity = COALESCE(?, capacity),
        uptime = COALESCE(?, uptime),
        models = COALESCE(?, models),
        joined = COALESCE(?, joined)
      WHERE id = ?
    `).run(name, status, totalEarned, capacity, uptime, models, joined, req.params.id);
    res.json({ updated: result.changes });
  });

  app.delete('/api/sellers/:id', (req, res) => {
    const result = db.prepare('DELETE FROM sellers WHERE id = ?').run(req.params.id);
    res.json({ deleted: result.changes });
  });

  app.get('/api/services', (_req, res) => {
    const rows = db.prepare('SELECT * FROM services').all();
    res.json(rows.map(parseService));
  });

  app.get('/api/services/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Service not found' });
    res.json(parseService(row));
  });

  app.post('/api/services', (req, res) => {
    const {
      id, name, provider, sellerId, sellerName,
      categories, protocols,
      pricing, maxConcurrency, currentLoad, status,
    } = req.body;
    const result = db.prepare(`
      INSERT INTO services (id, name, provider, seller_id, seller_name, categories, protocols, pricing_input, pricing_cached_input, pricing_output, max_concurrency, current_load, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name, provider, sellerId, sellerName,
      JSON.stringify(categories), JSON.stringify(protocols),
      pricing?.inputUsdPerMillion ?? 0,
      pricing?.cachedInputUsdPerMillion ?? 0,
      pricing?.outputUsdPerMillion ?? 0,
      maxConcurrency ?? 0, currentLoad ?? 0, status
    );
    res.status(201).json({ id: result.lastInsertRowid });
  });

  app.put('/api/services/:id', (req, res) => {
    const {
      name, provider, sellerId, sellerName,
      categories, protocols,
      pricing, maxConcurrency, currentLoad, status,
    } = req.body;
    const result = db.prepare(`
      UPDATE services SET
        name = COALESCE(?, name),
        provider = COALESCE(?, provider),
        seller_id = COALESCE(?, seller_id),
        seller_name = COALESCE(?, seller_name),
        categories = COALESCE(?, categories),
        protocols = COALESCE(?, protocols),
        pricing_input = COALESCE(?, pricing_input),
        pricing_cached_input = COALESCE(?, pricing_cached_input),
        pricing_output = COALESCE(?, pricing_output),
        max_concurrency = COALESCE(?, max_concurrency),
        current_load = COALESCE(?, current_load),
        status = COALESCE(?, status)
      WHERE id = ?
    `).run(
      name, provider, sellerId, sellerName,
      categories ? JSON.stringify(categories) : null,
      protocols ? JSON.stringify(protocols) : null,
      pricing?.inputUsdPerMillion ?? null,
      pricing?.cachedInputUsdPerMillion ?? null,
      pricing?.outputUsdPerMillion ?? null,
      maxConcurrency, currentLoad, status,
      req.params.id
    );
    res.json({ updated: result.changes });
  });

  app.delete('/api/services/:id', (req, res) => {
    const result = db.prepare('DELETE FROM services WHERE id = ?').run(req.params.id);
    res.json({ deleted: result.changes });
  });

  app.get('/api/computed-stats', (_req, res) => {
    const buyerCount = db.prepare('SELECT COUNT(*) as c FROM buyers').get().c;
    const sellerCount = db.prepare('SELECT COUNT(*) as c FROM sellers').get().c;
    const serviceCount = db.prepare('SELECT COUNT(*) as c FROM services').get().c;
    const totalVolume = db.prepare('SELECT SUM(total_spent) as s FROM buyers').get().s ?? 0;
    res.json({
      totalBuyers: buyerCount,
      totalSellers: sellerCount,
      totalServices: serviceCount,
      totalVolume,
    });
  });
}
