import Database from 'better-sqlite3';

const db = new Database('./backend/database.sqlite');

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// Idempotent schema additions for pre-existing database files (older
// deployments won't have these columns from CREATE TABLE IF NOT EXISTS alone).
for (const stmt of [
  'ALTER TABLE sellers ADD COLUMN agent_id TEXT',
  'ALTER TABLE sellers ADD COLUMN unique_buyers INTEGER',
  'ALTER TABLE sellers ADD COLUMN first_seen_at INTEGER',
  'ALTER TABLE sellers ADD COLUMN total_requests TEXT',
]) {
  try { db.prepare(stmt).run(); } catch (_) { /* column already exists */ }
}

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
    joined TEXT NOT NULL,
    agent_id TEXT,
    unique_buyers INTEGER,
    first_seen_at INTEGER,
    total_requests TEXT
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

  CREATE TABLE IF NOT EXISTS lants_positions (
    id INTEGER PRIMARY KEY,
    owner TEXT NOT NULL,
    agent_id INTEGER,
    amount REAL,
    weight_amount REAL,
    stake_start_epoch INTEGER,
    stake_end_epoch INTEGER,
    closed_at_epoch INTEGER,
    withdrawn INTEGER NOT NULL DEFAULT 0,
    synced_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lants_positions_owner ON lants_positions(owner);
  CREATE INDEX IF NOT EXISTS idx_lants_positions_agent ON lants_positions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_lants_positions_withdrawn ON lants_positions(withdrawn);

  CREATE TABLE IF NOT EXISTS lants_listings (
    token_id INTEGER PRIMARY KEY,
    offerer TEXT NOT NULL,
    price_wei TEXT NOT NULL,
    protocol_address TEXT NOT NULL,
    order_parameters TEXT NOT NULL, -- JSON, the signed Seaport order's parameters
    signature TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    cancelled_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS lants_offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id INTEGER NOT NULL,
    offerer TEXT NOT NULL,
    price_wei TEXT NOT NULL,
    weth TEXT NOT NULL,
    protocol_address TEXT NOT NULL,
    order_parameters TEXT NOT NULL, -- JSON, the signed Seaport order's parameters
    signature TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    cancelled_at INTEGER,
    accepted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_lants_offers_token ON lants_offers(token_id);

  CREATE TABLE IF NOT EXISTS lants_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id INTEGER NOT NULL,
    seller TEXT NOT NULL,
    buyer TEXT NOT NULL,
    price_wei TEXT NOT NULL,
    currency TEXT NOT NULL, -- 'ETH' (listing fulfillment) or 'WETH' (offer accept)
    trade_type TEXT NOT NULL, -- 'listing' | 'offer'
    tx_hash TEXT,
    amount REAL, -- ANTS locked in the position at trade time, for context
    agent_id INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lants_trades_token ON lants_trades(token_id);
  CREATE INDEX IF NOT EXISTS idx_lants_trades_created ON lants_trades(created_at);

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
  // NOTE: this function used to seed 8 invented buyers ("TechCorp AI",
  // "DataFlow Inc", ...), 8 invented sellers, 14 invented services and a
  // fabricated stats row (156 buyers / $458,900.50 volume / 18.7% growth).
  // That violated the project's core rule: never present fabricated data as
  // real network data. The `sellers`/`services` tables are wiped and
  // repopulated from the live DHT by sync-official.js, but `buyers` was
  // never touched by any sync, so those 8 fake rows were being served
  // verbatim by GET /api/buyers, and the fake stats row's `service_growth`
  // (18.7) survived every sync because sync-official.js does not update
  // that column.
  //
  // Real data sources now used instead:
  //   buyers   -> buyers_onchain      (Antscan, via sync-history.js)
  //   sellers  -> sellers_onchain     (Antscan) + sellers (live DHT)
  //   services -> services            (live DHT, sync-official.js)
  //   stats    -> network_snapshots   (Antscan) via sync-official.js
  //
  // Purge any fake rows left over in existing deployments' database files.
  db.prepare("DELETE FROM buyers WHERE id LIKE 'buyer_00%'").run();

  // The stats row must exist (sync-official.js only ever UPDATEs it), but it
  // starts as all-NULL so the UI renders "—" until a real sync populates it,
  // rather than showing invented numbers.
  const statsCount = db.prepare('SELECT COUNT(*) as count FROM stats').get().count;
  if (statsCount === 0) {
    db.prepare(`
      INSERT INTO stats (id, total_buyers, total_sellers, total_services, total_volume,
        active_transactions, buyer_growth, seller_growth, service_growth, volume_growth, transaction_growth)
      VALUES (1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
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
      emissions_effective_epoch INTEGER,
      emissions_duration INTEGER,
      allocation_json TEXT,
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
CREATE TABLE IF NOT EXISTS epoch_history (
  address TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (address, epoch)
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS address_balances (
address TEXT PRIMARY KEY,
ants REAL,
fetched_at INTEGER NOT NULL
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS buyer_channels (
address TEXT PRIMARY KEY,
data TEXT NOT NULL,
fetched_at INTEGER NOT NULL
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS operator_buyers (
operator TEXT NOT NULL,
buyer TEXT NOT NULL,
PRIMARY KEY (operator, buyer)
);
`);

const obCount = db.prepare('SELECT COUNT(*) as count FROM operator_buyers').get().count;
if (obCount === 0) {
db.prepare('INSERT INTO operator_buyers (operator, buyer) VALUES (?, ?)').run(
'0xc43ddf3bee752183a2e1af96299298aee4b35409',
'0x8e0abd6c6cfec9e643c205e7804e259ebff585c1'
);
}

// ─── Real historical/network data (Antscan-sourced) ───
// Replaces fabricated per-seller earnings/uptime and the requests*0.1 volume
// heuristic. Historical daily rows are immutable once the UTC day has fully
// elapsed — we never overwrite a closed day, only append/refresh "today" and
// any days we haven't stored yet, so history doesn't churn on every sync.
db.exec(`
  CREATE TABLE IF NOT EXISTS network_snapshots (
    fetched_at INTEGER PRIMARY KEY,
    total_volume_usdc TEXT,
    total_platform_fees_usdc TEXT,
    total_deposited_usdc TEXT,
    total_withdrawn_usdc TEXT,
    total_staked_usdc TEXT,
    total_requests TEXT,
    total_input_tokens TEXT,
    total_output_tokens TEXT,
    channel_count INTEGER,
    active_channel_count INTEGER,
    settled_channel_count INTEGER,
    buyer_count INTEGER,
    seller_count INTEGER,
    last_event_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS buyers_onchain (
    address TEXT PRIMARY KEY,
    spent_usdc TEXT,
    deposited_usdc TEXT,
    withdrawn_usdc TEXT,
    request_count TEXT,
    input_tokens TEXT,
    output_tokens TEXT,
    channel_count INTEGER,
    unique_sellers INTEGER,
    first_seen_at INTEGER,
    last_seen_at INTEGER,
    fetched_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sellers_onchain (
    address TEXT PRIMARY KEY,
    agent_id TEXT,
    stake_usdc TEXT,
    earned_usdc TEXT,
    request_count TEXT,
    input_tokens TEXT,
    output_tokens TEXT,
    unique_buyers INTEGER,
    channel_count INTEGER,
    first_seen_at INTEGER,
    last_seen_at INTEGER,
    fetched_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS daily_metrics (
    day TEXT PRIMARY KEY,
    day_start INTEGER NOT NULL,
    volume_usdc TEXT,
    platform_fees_usdc TEXT,
    deposits_usdc TEXT,
    withdrawals_usdc TEXT,
    requests TEXT,
    input_tokens TEXT,
    output_tokens TEXT,
    opened_channels INTEGER,
    settled_events INTEGER,
    closed_channels INTEGER,
    active_buyers INTEGER,
    active_sellers INTEGER,
    is_closed INTEGER NOT NULL DEFAULT 0,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_meta (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER
  );

  -- Per-epoch breakdown (buyers/sellers/volume/requests), used for the
  -- Overview tab's "by epoch" charts. Epoch 22 is the only currently-open
  -- epoch (recognized-usage era); everything before it is immutable, and is
  -- never re-fetched once stored, same rule as daily_metrics.
  CREATE TABLE IF NOT EXISTS epoch_metrics (
    epoch INTEGER PRIMARY KEY,
    volume_usdc TEXT,
    requests TEXT,
    input_tokens TEXT,
    output_tokens TEXT,
    active_buyers INTEGER,
    active_sellers INTEGER,
    is_closed INTEGER NOT NULL DEFAULT 0,
    fetched_at INTEGER NOT NULL
  );

  -- Durable cache for computed payloads that are expensive to rebuild from
  -- chain (notably /api/tokenomics, ~42s cold). The in-memory cache alone
  -- meant the first visitor after every restart paid the full cost; this
  -- survives restarts so the page can render immediately from the last known
  -- good snapshot while a refresh runs in the background.
  CREATE TABLE IF NOT EXISTS payload_cache (
    key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  -- Current-epoch per-participant points and reward estimates (recognized-
  -- usage era). Refreshed hourly by backend/epoch-rewards.js, not computed
  -- per-request — see notes/epoch-features-plan.md. usage_reward_wei is the
  -- real on-chain pendingBuyerReward/pendingAgentReward; pool_reward_wei is
  -- the real on-chain previewStakerRewards sum for any lANTS positions the
  -- address holds (zero for the vast majority, who don't stake). Both are
  -- wei-string ANTS amounts, null until first successfully fetched — never
  -- fabricated. One row per (address, epoch); old epochs' rows are kept
  -- (not deleted) so the table also works as a light history, though only
  -- the current epoch's row is ever refreshed.
  CREATE TABLE IF NOT EXISTS buyer_epoch_rewards (
    address TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    points TEXT,
    volume_usdc TEXT,
    requests TEXT,
    usage_reward_wei TEXT,
    pool_reward_wei TEXT,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (address, epoch)
  );

  CREATE TABLE IF NOT EXISTS seller_epoch_rewards (
    address TEXT NOT NULL,
    agent_id TEXT,
    epoch INTEGER NOT NULL,
    points TEXT,
    volume_usdc TEXT,
    requests TEXT,
    staked_ants_wei TEXT,
    usage_reward_wei TEXT,
    pool_reward_wei TEXT,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (address, epoch)
  );
`);
}

seedIfEmpty();

export default db;
