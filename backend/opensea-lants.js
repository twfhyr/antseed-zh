// OpenSea market for lANTS (Locked Antseed Stake).
// Collection slug comes from the public URL the founders pointed at
// (https://opensea.io/collection/antseed) — it is a marketplace identifier,
// not a contract address. The NFT contract is always the live
// AntseedSellerPools address from chain config, never hardcoded here.

export const OPENSEA_COLLECTION_SLUG = 'antseed';
export const OPENSEA_COLLECTION_URL = `https://opensea.io/collection/${OPENSEA_COLLECTION_SLUG}`;

/** 1 ANT positions are the provider-activation stake. They are not for sale. */
export function isProviderActivationStake(amount) {
  if (amount == null || Number.isNaN(Number(amount))) return false;
  return Math.abs(Number(amount) - 1) < 1e-6;
}

const OPENSEA_UA = 'Mozilla/5.0 (compatible; antseed-zh/1.0; +https://antseed-zh.com)';

export function openseaItemUrl(contract, tokenId) {
  return `https://opensea.io/item/base/${contract}/${tokenId}`;
}

function takeJsonObject(src) {
  if (!src || src[0] !== '{') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(src.slice(0, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Pull a USD / native price out of an OpenSea listing object without guessing. */
export function listingPriceFromUnknown(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const usd =
    numOrNull(obj.usd)
    ?? numOrNull(obj.price?.usd)
    ?? numOrNull(obj.price?.current?.usd)
    ?? numOrNull(obj.pricePerItem?.usd)
    ?? numOrNull(obj.pricePerItem?.token?.usd);
  const unit =
    numOrNull(obj.unit)
    ?? numOrNull(obj.pricePerItem?.token?.unit)
    ?? numOrNull(obj.pricePerItem?.unit)
    ?? (obj.price?.current?.value != null && obj.price?.current?.decimals != null
      ? Number(obj.price.current.value) / (10 ** Number(obj.price.current.decimals))
      : null);
  const symbol =
    obj.symbol
    || obj.pricePerItem?.token?.symbol
    || obj.price?.current?.currency
    || obj.native?.symbol
    || null;
  if (usd == null && unit == null) return null;
  return { usd, unit, symbol: symbol || null };
}

function parseBestListingFromSlice(slice) {
  const key = '"bestListing":';
  const idx = slice.indexOf(key);
  if (idx < 0) return null;
  const rest = slice.slice(idx + key.length);
  if (rest.startsWith('null')) return null;
  const obj = takeJsonObject(rest);
  return listingPriceFromUnknown(obj);
}

/**
 * Parse the public collection page HTML (same payload the OpenSea UI ships).
 * Used when OPENSEA_API_KEY is unset. Returns [] rather than invented listings.
 */
export function parseOpenSeaCollectionHtml(html, expectedContract) {
  if (!html || !expectedContract) return { items: [], uniqueItemCount: null };
  const expected = String(expectedContract).toLowerCase();
  const items = [];
  const seen = new Set();
  const re = /"tokenId":"(\d+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const id = Number(m[1]);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    const slice = html.slice(m.index, m.index + 5000);
    const contractMatch = slice.match(/"contractAddress":"(0x[a-fA-F0-9]{40})"/i);
    if (contractMatch && contractMatch[1].toLowerCase() !== expected) continue;
    seen.add(id);
    const ownerMatch = slice.match(/"owner":\{[^}]*?"address":"(0x[a-fA-F0-9]{40})"/i);
    items.push({
      id,
      owner: ownerMatch ? ownerMatch[1] : null,
      listing: parseBestListingFromSlice(slice),
    });
  }
  const supplyMatch = html.match(/"uniqueItemCount":(\d+)/);
  return {
    items,
    uniqueItemCount: supplyMatch ? Number(supplyMatch[1]) : items.length,
  };
}

async function fetchCollectionHtml() {
  const res = await fetch(OPENSEA_COLLECTION_URL, {
    headers: { 'user-agent': OPENSEA_UA, accept: 'text/html' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`OpenSea collection HTTP ${res.status}`);
  return res.text();
}

function tokenIdFromApiListing(listing) {
  const id =
    listing?.nft?.identifier
    ?? listing?.protocol_data?.parameters?.offer?.find?.((o) => o?.identifierOrCriteria != null)?.identifierOrCriteria
    ?? listing?.criteria?.token?.token_id
    ?? listing?.token_id
    ?? listing?.identifier;
  const n = Number(id);
  return Number.isFinite(n) ? n : null;
}

async function fetchListingsViaApi(apiKey) {
  const url = `https://api.opensea.io/api/v2/listings/collection/${OPENSEA_COLLECTION_SLUG}/all?limit=50`;
  const res = await fetch(url, {
    headers: { 'x-api-key': apiKey, accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`OpenSea listings HTTP ${res.status}`);
  const body = await res.json();
  const rows = body.listings || body.orders || [];
  const byId = new Map();
  for (const row of rows) {
    const id = tokenIdFromApiListing(row);
    if (id == null) continue;
    const price = listingPriceFromUnknown(row);
    if (!price) continue;
    const prev = byId.get(id);
    if (!prev || (price.usd != null && (prev.usd == null || price.usd < prev.usd))) {
      byId.set(id, price);
    }
  }
  return byId;
}

/**
 * OpenSea items + best listings for the lANTS collection.
 * Prefers the API when OPENSEA_API_KEY is set; otherwise reads the public page.
 * Never invents a listing: missing / unparseable prices stay null.
 */
export async function fetchOpenSeaLantsMarket(expectedContract) {
  const apiKey = process.env.OPENSEA_API_KEY || null;
  let htmlItems = [];
  let uniqueItemCount = null;
  let htmlError = null;
  try {
    const html = await fetchCollectionHtml();
    const parsed = parseOpenSeaCollectionHtml(html, expectedContract);
    htmlItems = parsed.items;
    uniqueItemCount = parsed.uniqueItemCount;
  } catch (e) {
    htmlError = e.message;
  }

  let apiListings = null;
  let source = htmlItems.length ? 'opensea-html' : 'none';
  if (apiKey) {
    try {
      apiListings = await fetchListingsViaApi(apiKey);
      if (apiListings) source = htmlItems.length ? 'opensea-api+html' : 'opensea-api';
    } catch {
      // Keep the HTML result; do not fail the market on an API error.
    }
  }

  const byId = new Map();
  for (const item of htmlItems) {
    byId.set(item.id, { id: item.id, owner: item.owner, listing: item.listing });
  }
  if (apiListings) {
    for (const [id, listing] of apiListings) {
      const prev = byId.get(id) || { id, owner: null, listing: null };
      prev.listing = listing;
      byId.set(id, prev);
    }
  }

  return {
    items: [...byId.values()],
    uniqueItemCount,
    source,
    htmlError,
    collectionUrl: OPENSEA_COLLECTION_URL,
  };
}
