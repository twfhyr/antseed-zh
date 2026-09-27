// Ground-truth lANTS ownership + trade history from the Ponder indexer at
// indexer/ (indexes AntseedSellerPools Transfer events, plus a same-tx
// Seaport OrderFulfilled log when one exists, directly off Base mainnet --
// see indexer/src/index.ts). Same trust model as backend/antscan.js's
// GraphQL client: this module throws on failure, callers decide the
// fallback (see lants-trades.js).
//
// Point LANTS_INDEXER_URL at wherever indexer/ is actually running
// (`ponder dev`/`ponder start`, default port 42069). Unset or unreachable
// just means no indexer-sourced correction this cycle -- never fabricated,
// same failure mode as the OpenSea scrape being best-effort input only.

const INDEXER_URL = process.env.LANTS_INDEXER_URL || 'http://localhost:42069';

const NATIVE = '0x0000000000000000000000000000000000000000';
const WETH_BASE = '0x4200000000000000000000000000000000000006'; // same address listLants.js signs offers in
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'; // Base USDC, same token lANTS listings use

function currencyLabel(addr) {
  if (addr == null || addr === '') return '';
  const a = String(addr).toLowerCase();
  if (a === 'eth' || a === NATIVE) return 'ETH';
  if (a === 'usdc' || a === USDC_BASE) return 'USDC';
  if (a === 'weth' || a === WETH_BASE) return 'WETH';
  return addr;
}

async function gql(query, variables = {}) {
  const res = await fetch(`${INDEXER_URL}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`lANTS indexer GraphQL ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return body.data;
}

async function paginateAll(fieldName, query) {
  const items = [];
  let after = null;
  for (;;) {
    const data = await gql(query, { after });
    const page = data[fieldName];
    items.push(...page.items);
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return items;
}

const POSITIONS_QUERY = `
  query($after: String) {
    lantsPositions(after: $after, limit: 1000) {
      items { id owner lastTransferAt }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** Current owner per tokenId, straight from on-chain Transfer events. */
export async function indexerOwners() {
  const items = await paginateAll('lantsPositions', POSITIONS_QUERY);
  const map = new Map();
  for (const it of items) {
    const id = Number(it.id);
    if (Number.isFinite(id)) {
      map.set(id, { owner: it.owner.toLowerCase(), at: Number(it.lastTransferAt) * 1000 });
    }
  }
  return map;
}

const TRADES_QUERY = `
  query($after: String) {
    lantsTrades(after: $after, limit: 1000, where: { priceWei_not: null }, orderBy: "timestamp", orderDirection: "desc") {
      items { id tokenId seller buyer priceWei currency txHash timestamp }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/**
 * Real sales decoded from a Seaport OrderFulfilled log in the same tx as
 * the position's Transfer -- catches a trade regardless of which channel
 * executed it (this app / OpenSea / a raw fulfillOrder() call). The
 * `priceWei_not: null` filter means every row here already resolved to a
 * real, single-currency price; a Transfer with no matching Seaport log
 * (split/merge/internal move) or an ambiguous multi-currency consideration
 * never shows up here at all -- the indexer leaves those null rather than
 * guess, so there's nothing to filter out on this side.
 */
export async function indexerTrades() {
  const items = await paginateAll('lantsTrades', TRADES_QUERY);
  return items.map((t) => ({
    id: `indexer-${t.id}`,
    tokenId: Number(t.tokenId),
    seller: t.seller.toLowerCase(),
    buyer: t.buyer.toLowerCase(),
    priceWei: t.priceWei,
    currency: currencyLabel(t.currency),
    tradeType: 'onchain',
    txHash: t.txHash,
    amount: null,
    agentId: null,
    createdAt: Number(t.timestamp) * 1000,
  }));
}
