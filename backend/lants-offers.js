// Buy-side Seaport orders (offers) for lANTS NFTs: a buyer offers an ERC20
// (raw ETH can't be pulled by fulfillOrder, only pushed by the offerer at
// fulfillment time, so an offer that isn't the current owner fulfilling it
// has to be an ERC20 -- USDC as of 2026-09-21, WETH before that) for a
// specific token; the owner accepts by fulfilling that order directly
// against Seaport, same mechanism as buying a listing, just with the roles
// swapped. No OpenSea involved.
import db from './database.js';

// Kept for identifying pre-2026-09-21 offer rows (the `weth` column name
// predates the USDC switch but still just stores "whatever ERC20 token
// address this offer's payment item names") -- current offers use
// emissionsCfg.usdcContractAddress instead, resolved live in server.js.
export const WETH_BASE = '0x4200000000000000000000000000000000000006';

const insertStmt = db.prepare(`
  INSERT INTO lants_offers (token_id, offerer, price_wei, weth, protocol_address, order_parameters, signature, created_at)
  VALUES (@tokenId, @offerer, @priceWei, @weth, @protocolAddress, @orderParameters, @signature, @createdAt)
`);

export function saveOffer({ tokenId, offerer, priceWei, weth, protocolAddress, orderParameters, signature }) {
  const info = insertStmt.run({
    tokenId: Number(tokenId),
    offerer: String(offerer).toLowerCase(),
    priceWei: String(priceWei),
    weth,
    protocolAddress,
    orderParameters: JSON.stringify(orderParameters),
    signature,
    createdAt: Date.now(),
  });
  return info.lastInsertRowid;
}

function rowToOffer(row) {
  return {
    id: row.id,
    tokenId: row.token_id,
    offerer: row.offerer,
    priceWei: row.price_wei,
    weth: row.weth,
    protocolAddress: row.protocol_address,
    orderParameters: JSON.parse(row.order_parameters),
    signature: row.signature,
    createdAt: row.created_at,
  };
}

export function getOffer(id) {
  const row = db.prepare('SELECT * FROM lants_offers WHERE id = ? AND cancelled_at IS NULL AND accepted_at IS NULL').get(Number(id));
  return row ? rowToOffer(row) : null;
}

/**
 * Active (not cancelled/accepted) offers for one token, highest price
 * first -- sorted in JS with BigInt rather than SQL's ORDER BY, since
 * price_wei is TEXT (arbitrary-precision amounts don't fit a REAL/INTEGER
 * column) and a lexicographic string sort gets differing-digit-length
 * numbers wrong (e.g. "9" would sort after "10000"). This assumes every
 * offer on a given token shares one currency's decimals, which holds for
 * all new (USDC) offers; it's only approximate for the rare token that
 * mixes an old pre-2026-09-21 WETH (18-decimal) offer in with new USDC
 * (6-decimal) ones, since their raw base-unit amounts aren't comparable.
 */
export function offersForToken(tokenId) {
  const rows = db.prepare('SELECT * FROM lants_offers WHERE token_id = ? AND cancelled_at IS NULL AND accepted_at IS NULL')
    .all(Number(tokenId)).map(rowToOffer);
  rows.sort((a, b) => {
    const diff = BigInt(b.priceWei) - BigInt(a.priceWei);
    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
  });
  return rows;
}

export function offererForOffer(id) {
  const row = db.prepare('SELECT offerer FROM lants_offers WHERE id = ?').get(Number(id));
  return row ? row.offerer : null;
}

export function cancelOffer(id) {
  db.prepare('UPDATE lants_offers SET cancelled_at = ? WHERE id = ? AND cancelled_at IS NULL AND accepted_at IS NULL').run(Date.now(), Number(id));
}

export function markOfferAccepted(id) {
  db.prepare('UPDATE lants_offers SET accepted_at = ? WHERE id = ?').run(Date.now(), Number(id));
}

/** Other active offers on the same token become stale once one is accepted (only one owner to sell it). */
export function cancelOtherOffers(tokenId, exceptId) {
  db.prepare('UPDATE lants_offers SET cancelled_at = ? WHERE token_id = ? AND id != ? AND cancelled_at IS NULL AND accepted_at IS NULL')
    .run(Date.now(), Number(tokenId), Number(exceptId));
}
