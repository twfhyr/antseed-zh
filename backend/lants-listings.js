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
  recordListingEvent({
    tokenId,
    eventType: 'listed',
    reason: 'local_seaport_order_saved',
    offerer,
    details: { priceWei: String(priceWei), protocolAddress },
  });
}

function rowToListing(row, { includeOrder = true } = {}) {
  if (!row) return null;
  const listing = {
    tokenId: row.token_id,
    offerer: row.offerer,
    priceWei: row.price_wei,
    protocolAddress: row.protocol_address,
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at ?? null,
  };
  if (includeOrder) {
    listing.orderParameters = JSON.parse(row.order_parameters);
    listing.signature = row.signature;
  }
  return listing;
}

export function getListing(tokenId) {
  const row = db.prepare('SELECT * FROM lants_listings WHERE token_id = ? AND cancelled_at IS NULL').get(Number(tokenId));
  return rowToListing(row);
}

export function getListingRecord(tokenId) {
  const row = db.prepare('SELECT * FROM lants_listings WHERE token_id = ?').get(Number(tokenId));
  return rowToListing(row, { includeOrder: false });
}

export function allActiveListings() {
  const rows = db.prepare('SELECT * FROM lants_listings WHERE cancelled_at IS NULL').all();
  return rows.map((row) => rowToListing(row));
}

export function recordListingEvent({ tokenId, eventType, reason = null, offerer = null, positionOwner = null, details = null, dedupMs = 0 }) {
  const createdAt = Date.now();
  const normalizedTokenId = Number(tokenId);
  const normalizedOfferer = offerer ? String(offerer).toLowerCase() : null;
  const normalizedPositionOwner = positionOwner ? String(positionOwner).toLowerCase() : null;
  const serializedDetails = details == null ? null : JSON.stringify(details);
  if (dedupMs > 0) {
    const recent = db.prepare(`
      SELECT id FROM lants_listing_events
      WHERE token_id = ? AND event_type = ? AND COALESCE(reason, '') = COALESCE(?, '')
        AND created_at >= ?
      ORDER BY created_at DESC LIMIT 1
    `).get(normalizedTokenId, eventType, reason, createdAt - dedupMs);
    if (recent) return null;
  }
  const info = db.prepare(`
    INSERT INTO lants_listing_events (token_id, event_type, reason, offerer, position_owner, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(normalizedTokenId, eventType, reason, normalizedOfferer, normalizedPositionOwner, serializedDetails, createdAt);
  return Number(info.lastInsertRowid);
}

export function recentListingEvents({ tokenId = null, limit = 50 } = {}) {
  const cappedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const rows = tokenId == null
    ? db.prepare('SELECT * FROM lants_listing_events ORDER BY created_at DESC LIMIT ?').all(cappedLimit)
    : db.prepare('SELECT * FROM lants_listing_events WHERE token_id = ? ORDER BY created_at DESC LIMIT ?').all(Number(tokenId), cappedLimit);
  return rows.map((row) => ({
    id: row.id,
    tokenId: row.token_id,
    eventType: row.event_type,
    reason: row.reason,
    offerer: row.offerer,
    positionOwner: row.position_owner,
    details: row.details ? JSON.parse(row.details) : null,
    createdAt: row.created_at,
  }));
}

/** Drop a listing whose offerer no longer owns the position (sold, transferred, or withdrawn on-chain). */
export function invalidateListing(tokenId, { reason = 'manual_or_unknown', positionOwner = null, details = null, dedupMs = 0 } = {}) {
  const id = Number(tokenId);
  const existing = db.prepare('SELECT offerer FROM lants_listings WHERE token_id = ? AND cancelled_at IS NULL').get(id);
  const info = db.prepare('UPDATE lants_listings SET cancelled_at = ? WHERE token_id = ? AND cancelled_at IS NULL').run(Date.now(), id);
  if (info.changes > 0) {
    recordListingEvent({
      tokenId: id,
      eventType: 'invalidated',
      reason,
      offerer: existing?.offerer || null,
      positionOwner,
      details,
      dedupMs,
    });
    console.warn('[lants-listings] invalidated', JSON.stringify({
      tokenId: id, reason, offerer: existing?.offerer || null, positionOwner, details,
    }));
  }
  return info.changes;
}
