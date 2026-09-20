// Trade history for the lANTS marketplace -- one row per completed sale
// (a bought listing or an accepted offer). Purely a record for the History
// tab; ownership/listing state itself is never derived from this table.
import db from './database.js';

const insertStmt = db.prepare(`
  INSERT INTO lants_trades (token_id, seller, buyer, price_wei, currency, trade_type, tx_hash, amount, agent_id, created_at)
  VALUES (@tokenId, @seller, @buyer, @priceWei, @currency, @tradeType, @txHash, @amount, @agentId, @createdAt)
`);

export function recordTrade({ tokenId, seller, buyer, priceWei, currency, tradeType, txHash, amount, agentId }) {
  const info = insertStmt.run({
    tokenId: Number(tokenId),
    seller: String(seller).toLowerCase(),
    buyer: String(buyer).toLowerCase(),
    priceWei: String(priceWei),
    currency,
    tradeType,
    txHash: txHash || null,
    amount: amount != null ? Number(amount) : null,
    agentId: agentId != null ? Number(agentId) : null,
    createdAt: Date.now(),
  });
  return info.lastInsertRowid;
}

function rowToTrade(row) {
  return {
    id: row.id,
    tokenId: row.token_id,
    seller: row.seller,
    buyer: row.buyer,
    priceWei: row.price_wei,
    currency: row.currency,
    tradeType: row.trade_type,
    txHash: row.tx_hash,
    amount: row.amount,
    agentId: row.agent_id,
    createdAt: row.created_at,
  };
}

export function listTrades({ page = 1, pageSize = 20 } = {}) {
  const limit = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const offset = Math.max(0, (Math.max(1, Number(page) || 1) - 1) * limit);
  const total = db.prepare('SELECT COUNT(*) AS c FROM lants_trades').get().c;
  const rows = db.prepare('SELECT * FROM lants_trades ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  return { rows: rows.map(rowToTrade), total };
}
