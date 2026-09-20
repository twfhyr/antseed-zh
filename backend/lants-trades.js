// Trade history for the lANTS marketplace -- one row per completed sale
// (a bought listing or an accepted offer). Purely a record for the History
// tab; ownership/listing state itself is never derived from this table.
import db from './database.js';
import { indexerOwners, indexerTrades } from './lants-indexer.js';

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

/** Most recent recorded buyer per token id, self-reported by whichever
 *  browser called /api/lants/trade or /api/lants/offer/accept right after
 *  its own tx confirmed. No on-chain check of its own -- see indexerOwners()
 *  below for the ground-truth version this feeds into. */
function selfReportedOwners() {
  const rows = db.prepare(`
    SELECT token_id, buyer, MAX(created_at) AS created_at
    FROM lants_trades
    GROUP BY token_id
  `).all();
  const map = new Map();
  for (const r of rows) map.set(r.token_id, { owner: r.buyer, createdAt: r.created_at });
  return map;
}

/** Current owner per token id. Antscan's own indexer can lag well behind a
 *  real sale (it still reports the old owner for a while), and our own
 *  market cache rebuilds from Antscan on every refresh cycle -- so without
 *  a correction, a sold position's ownership silently reverts to the seller
 *  again as soon as any refresh happens without an explicit ensureIds
 *  override. Layers two corrections over Antscan, most authoritative last:
 *  our own self-reported trade log, then the Ponder indexer (see
 *  backend/lants-indexer.js) reading real Transfer events straight off Base
 *  mainnet -- ground truth regardless of which channel moved the NFT, not
 *  just the sales a browser reported back to us. An unreachable/not-yet-
 *  running indexer just falls back to the self-reported log alone. */
export async function latestOwners() {
  const map = selfReportedOwners();
  try {
    const onchain = await indexerOwners();
    for (const [id, v] of onchain) map.set(id, { owner: v.owner, createdAt: v.at });
  } catch (e) {
    console.error('[lants-indexer] owners fetch failed, continuing with self-reported trades only:', e.message);
  }
  return map;
}

function tradeTuple(t) {
  return `${t.tokenId}|${t.seller}|${t.buyer}|${t.priceWei}`;
}

/** Trade history for the History tab. Merges our own self-reported log with
 *  real sales the Ponder indexer decoded from an on-chain Seaport
 *  OrderFulfilled log (see backend/lants-indexer.js) -- this catches a sale
 *  regardless of which channel executed it (this app / OpenSea / a raw
 *  fulfillOrder() call), not just the ones a browser reported back to us.
 *
 *  Dedup can't rely on txHash alone: in production, self-reported rows
 *  routinely have `tx_hash IS NULL` for both trade types (confirmed against
 *  the live DB, not just the offer/accept endpoint that never asks for one
 *  -- the listing-buy endpoint accepts a txHash but apparently isn't always
 *  sent one in practice). So a local row missing a txHash is instead matched
 *  against the indexer by (tokenId, seller, buyer, priceWei) -- the indexer's
 *  version wins when matched, since it carries a real txHash/currency ours
 *  doesn't. This can in theory treat two real trades between the same pair,
 *  on the same tokenId, at the exact same price, as one -- a narrow
 *  false-positive on a display list, never a fabricated number, and far
 *  better than showing every real trade twice once the indexer is live. */
export async function listTrades({ page = 1, pageSize = 20 } = {}) {
  const limit = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const offset = Math.max(0, (Math.max(1, Number(page) || 1) - 1) * limit);

  const localRows = db.prepare('SELECT * FROM lants_trades ORDER BY created_at DESC').all().map(rowToTrade);

  let onchainRows = [];
  try {
    onchainRows = await indexerTrades();
  } catch (e) {
    console.error('[lants-indexer] trades fetch failed, continuing with self-reported trades only:', e.message);
  }

  const localByTxHash = new Map(localRows.filter((t) => t.txHash).map((t) => [t.txHash.toLowerCase(), t]));
  const localByTuple = new Map(localRows.map((t) => [tradeTuple(t), t]));
  const supersededLocalIds = new Set();
  for (const t of onchainRows) {
    const match = (t.txHash && localByTxHash.get(t.txHash.toLowerCase())) || localByTuple.get(tradeTuple(t));
    if (match) supersededLocalIds.add(match.id);
  }
  const keptLocal = localRows.filter((t) => !supersededLocalIds.has(t.id));

  const merged = [...keptLocal, ...onchainRows].sort((a, b) => b.createdAt - a.createdAt);
  const total = merged.length;
  const rows = merged.slice(offset, offset + limit);
  return { rows, total };
}
