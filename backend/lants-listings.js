// Self-hosted Seaport order book for lANTS NFTs. Listings created here are
// real, valid Seaport orders (same format OpenSea's own SDK produces) --
// they just live in our own database instead of OpenSea's, and are fulfilled
// by a buyer's wallet calling Seaport directly. No OpenSea API involved at
// any point, so no API key and no rate limit.
import db from './database.js';

const upsertStmt = db.prepare(`
  INSERT INTO lants_listings (token_id, offerer, price_wei, protocol_address, order_parameters, signature, created_at, cancelled_at)
  VALUES (@token_id, @offerer, @price_wei, @protocol_address, @order_parameters, @signature, @created_at, NULL)
  ON CONFLICT(token_id) DO UPDATE SET
    offerer = excluded.offerer,
    price_wei = excluded.price_wei,
    protocol_address = excluded.protocol_address,
    order_parameters = excluded.order_parameters,
    signature = excluded.signature,
    created_at = excluded.created_at,
    cancelled_at = NULL
`);

export function saveListing({ tokenId, offerer, priceWei, protocolAddress, orderParameters, signature }) {
  upsertStmt.run({
    token_id: Number(tokenId),
    offerer: String(offerer).toLowerCase(),
    price_wei: String(priceWei),
    protocol_address: protocolAddress,
    order_parameters: JSON.stringify(orderParameters),
    signature,
    created_at: Date.now(),
  });
}

export function getListing(tokenId) {
  const row = db.prepare('SELECT * FROM lants_listings WHERE token_id = ? AND cancelled_at IS NULL').get(Number(tokenId));
  if (!row) return null;
  return {
    tokenId: row.token_id,
    offerer: row.offerer,
    priceWei: row.price_wei,
    protocolAddress: row.protocol_address,
    orderParameters: JSON.parse(row.order_parameters),
    signature: row.signature,
    createdAt: row.created_at,
  };
}

export function allActiveListings() {
  const rows = db.prepare('SELECT * FROM lants_listings WHERE cancelled_at IS NULL').all();
  return rows.map((row) => ({
    tokenId: row.token_id,
    offerer: row.offerer,
    priceWei: row.price_wei,
    protocolAddress: row.protocol_address,
    orderParameters: JSON.parse(row.order_parameters),
    signature: row.signature,
    createdAt: row.created_at,
  }));
}

/** Drop a listing whose offerer no longer owns the position (sold, transferred, or withdrawn on-chain). */
export function invalidateListing(tokenId) {
  db.prepare('UPDATE lants_listings SET cancelled_at = ? WHERE token_id = ? AND cancelled_at IS NULL').run(Date.now(), Number(tokenId));
}
