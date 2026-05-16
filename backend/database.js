import Database from 'better-sqlite3';

const db = new Database('./backend/database.sqlite');

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS buyers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    total_spent REAL DEFAULT 0,
    requests INTEGER DEFAULT 0,
    avg_latency INTEGER DEFAULT 0,
    joined TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sellers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    total_earned REAL DEFAULT 0,
    capacity TEXT NOT NULL,
    uptime REAL DEFAULT 0,
    models INTEGER DEFAULT 0,
    joined TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    seller_id TEXT NOT NULL,
    seller_name TEXT NOT NULL,
    categories TEXT NOT NULL, -- JSON array
    protocols TEXT NOT NULL, -- JSON array
    pricing_input REAL DEFAULT 0,
    pricing_cached_input REAL DEFAULT 0,
    pricing_output REAL DEFAULT 0,
    max_concurrency INTEGER DEFAULT 0,
    current_load INTEGER DEFAULT 0,
    status TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS stats (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    total_buyers INTEGER DEFAULT 0,
    total_sellers INTEGER DEFAULT 0,
    total_services INTEGER DEFAULT 0,
    total_volume REAL DEFAULT 0,
    active_transactions INTEGER DEFAULT 0,
    buyer_growth REAL DEFAULT 0,
    seller_growth REAL DEFAULT 0,
    service_growth REAL DEFAULT 0,
    volume_growth REAL DEFAULT 0,
    transaction_growth REAL DEFAULT 0
  );
`);

function seedIfEmpty() {
  const buyerCount = db.prepare('SELECT COUNT(*) as count FROM buyers').get().count;
  if (buyerCount === 0) {
    const insertBuyer = db.prepare(`
      INSERT INTO buyers (id, name, status, total_spent, requests, avg_latency, joined)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const buyers = [
      ['buyer_001', 'TechCorp AI', 'online', 12450.00, 8921, 45, '2024-03-15'],
      ['buyer_002', 'DevStudio Pro', 'online', 8320.50, 5643, 52, '2024-04-02'],
      ['buyer_003', 'DataFlow Inc', 'busy', 15680.75, 12340, 38, '2024-02-20'],
      ['buyer_004', 'CloudMind Labs', 'offline', 4560.25, 3210, 61, '2024-05-10'],
      ['buyer_005', 'NeuralSystems', 'online', 22100.00, 18760, 41, '2024-01-08'],
      ['buyer_006', 'ByteBridge', 'online', 6780.00, 4890, 49, '2024-04-18'],
      ['buyer_007', 'Synapse AI', 'busy', 18900.50, 14560, 35, '2024-02-28'],
      ['buyer_008', 'QuantumSoft', 'online', 9450.25, 7230, 47, '2024-03-22'],
    ];
    const buyersTx = db.transaction(() => {
      for (const b of buyers) insertBuyer.run(...b);
    });
    buyersTx();
  }

  const sellerCount = db.prepare('SELECT COUNT(*) as count FROM sellers').get().count;
  if (sellerCount === 0) {
    const insertSeller = db.prepare(`
      INSERT INTO sellers (id, name, status, total_earned, capacity, uptime, models, joined)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const sellers = [
      ['seller_001', 'NodeRunner Alpha', 'online', 18500.00, '32 GB / 8 GPU', 99.8, 4, '2024-01-15'],
      ['seller_002', 'GPU Farm East', 'online', 24300.75, '128 GB / 32 GPU', 99.5, 8, '2023-12-01'],
      ['seller_003', 'DeepCompute Hub', 'busy', 31200.00, '64 GB / 16 GPU', 98.9, 6, '2024-02-10'],
      ['seller_004', 'EdgeNode West', 'online', 12800.50, '16 GB / 4 GPU', 99.2, 2, '2024-04-05'],
      ['seller_005', 'CryptoMine AI', 'offline', 8900.25, '48 GB / 12 GPU', 95.4, 3, '2024-03-01'],
      ['seller_006', 'RenderFarm Pro', 'online', 27600.00, '256 GB / 64 GPU', 99.9, 12, '2023-11-20'],
      ['seller_007', 'LocalHost Max', 'busy', 15400.75, '24 GB / 6 GPU', 97.8, 3, '2024-05-01'],
      ['seller_008', 'CloudNode One', 'online', 19800.00, '96 GB / 24 GPU', 99.6, 7, '2024-01-25'],
    ];
    const sellersTx = db.transaction(() => {
      for (const s of sellers) insertSeller.run(...s);
    });
    sellersTx();
  }

  const serviceCount = db.prepare('SELECT COUNT(*) as count FROM services').get().count;
  if (serviceCount === 0) {
    const insertService = db.prepare(`
      INSERT INTO services (id, name, provider, seller_id, seller_name, categories, protocols, pricing_input, pricing_cached_input, pricing_output, max_concurrency, current_load, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const services = [
      ['svc_001', 'claude-sonnet-4-6', 'anthropic', 'seller_001', 'NodeRunner Alpha', JSON.stringify(['coding','privacy']), JSON.stringify(['anthropic-messages']), 3, 0.3, 15, 5, 2, 'online'],
      ['svc_002', 'claude-haiku-4-5', 'anthropic', 'seller_001', 'NodeRunner Alpha', JSON.stringify(['privacy']), JSON.stringify(['anthropic-messages']), 1, 0.1, 5, 10, 3, 'online'],
      ['svc_003', 'kimi-k2.5', 'antseed', 'seller_002', 'GPU Farm East', JSON.stringify(['coding','finance']), JSON.stringify(['openai-compatible']), 2, 0.2, 8, 20, 12, 'online'],
      ['svc_004', 'kimi-k2.6', 'antseed', 'seller_002', 'GPU Farm East', JSON.stringify(['coding','legal']), JSON.stringify(['openai-compatible']), 2.5, 0.25, 10, 16, 14, 'busy'],
      ['svc_005', 'gpt-4o', 'openai', 'seller_003', 'DeepCompute Hub', JSON.stringify(['coding','uncensored']), JSON.stringify(['openai-chat']), 5, 1.25, 15, 8, 6, 'busy'],
      ['svc_006', 'gpt-4o-mini', 'openai', 'seller_003', 'DeepCompute Hub', JSON.stringify(['coding']), JSON.stringify(['openai-chat']), 0.15, 0.075, 0.6, 15, 4, 'online'],
      ['svc_007', 'llama-3.3-70b', 'meta', 'seller_004', 'EdgeNode West', JSON.stringify(['privacy','uncensored']), JSON.stringify(['openai-compatible']), 0.9, 0.09, 0.9, 4, 1, 'online'],
      ['svc_008', 'llama-3.3-8b', 'meta', 'seller_004', 'EdgeNode West', JSON.stringify(['privacy']), JSON.stringify(['openai-compatible']), 0.2, 0.02, 0.2, 6, 2, 'online'],
      ['svc_009', 'deepseek-chat', 'deepseek', 'seller_005', 'CryptoMine AI', JSON.stringify(['coding','finance']), JSON.stringify(['openai-compatible']), 0.5, 0.05, 2, 8, 0, 'offline'],
      ['svc_010', 'gemini-1.5-pro', 'google', 'seller_006', 'RenderFarm Pro', JSON.stringify(['coding','legal']), JSON.stringify(['google-generative']), 3.5, 0.875, 10.5, 30, 18, 'online'],
      ['svc_011', 'gemini-1.5-flash', 'google', 'seller_006', 'RenderFarm Pro', JSON.stringify(['coding']), JSON.stringify(['google-generative']), 0.35, 0.0875, 1.05, 40, 22, 'online'],
      ['svc_012', 'mistral-large', 'mistral', 'seller_007', 'LocalHost Max', JSON.stringify(['coding','finance','legal']), JSON.stringify(['openai-compatible']), 2, 0.5, 6, 6, 5, 'busy'],
      ['svc_013', 'qwen-2.5-72b', 'alibaba', 'seller_008', 'CloudNode One', JSON.stringify(['coding','tee']), JSON.stringify(['openai-compatible']), 1.2, 0.12, 3.6, 12, 7, 'online'],
      ['svc_014', 'qwen-2.5-32b', 'alibaba', 'seller_008', 'CloudNode One', JSON.stringify(['coding']), JSON.stringify(['openai-compatible']), 0.6, 0.06, 1.8, 14, 6, 'online'],
    ];
    const servicesTx = db.transaction(() => {
      for (const s of services) insertService.run(...s);
    });
    servicesTx();
  }

  const statsCount = db.prepare('SELECT COUNT(*) as count FROM stats').get().count;
  if (statsCount === 0) {
    db.prepare(`
      INSERT INTO stats (id, total_buyers, total_sellers, total_services, total_volume, active_transactions, buyer_growth, seller_growth, service_growth, volume_growth, transaction_growth)
      VALUES (1, 156, 89, 47, 458900.50, 1234, 12.5, 8.3, 18.7, 23.7, 15.2)
    `).run();
  }

  // ─── On-chain metrics cache ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS chain_metrics (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      fetched_at INTEGER NOT NULL,
      ants_total_supply REAL,
      ants_max_supply REAL,
      emissions_epoch INTEGER,
      emissions_rate REAL,
      emissions_genesis INTEGER,
      emissions_halving INTEGER,
      usdc_deposits_balance REAL,
      usdc_channels_balance REAL,
      rpc_url TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS address_emissions (
      address TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS address_balances (
      address TEXT PRIMARY KEY,
      ants REAL,
      fetched_at INTEGER NOT NULL
    );
  `);
}

seedIfEmpty();

export default db;
