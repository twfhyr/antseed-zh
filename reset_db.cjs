const Database = require('better-sqlite3');
const db = new Database('/home/ubuntu/antseed/opencode/backend/database.sqlite');
db.prepare('DELETE FROM chain_metrics WHERE id = 1').run();
db.prepare('DROP TABLE IF EXISTS chain_metrics').run();
db.exec(`
CREATE TABLE chain_metrics (
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
console.log('Reset chain_metrics table');
