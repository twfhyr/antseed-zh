// Create and fulfill Seaport listings for lANTS NFTs directly against the
// Seaport contract -- antseed-zh is its own order book (backend/lants-listings.js),
// not OpenSea's. seaport-js is loaded on demand so the rest of the dashboard
// does not pay for ethers until someone actually lists or buys.
//
// Uses Seaport's own default conduit (the zero conduit key) rather than
// OpenSea's conduit: sellers approve the Seaport contract itself for
// transfers, with no dependency on OpenSea-operated infrastructure anywhere
// in the flow.

const DEFAULT_CONDUIT_KEY = `0x${'0'.repeat(64)}`;
const SEAPORT_V16 = '0x0000000000000068F116a894984e2DB1123eB395';

export function isProviderActivationStake(amount) {
  if (amount == null || Number.isNaN(Number(amount))) return false;
  return Math.abs(Number(amount) - 1) < 1e-6;
}

function stringify(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(stringify);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = stringify(v);
    return out;
  }
  return value;
}

export async function createAndPostListing({ walletClient, account, contract, tokenId, priceEth, durationDays }) {
  const [{ Seaport, ItemType }, { BrowserProvider, parseEther }] = await Promise.all([
    import('@opensea/seaport-js'),
    import('ethers'),
  ]);
  const network = {
    chainId: walletClient.chain.id,
    name: walletClient.chain.name,
  };
  const provider = new BrowserProvider(walletClient.transport, network);
  const seaport = new Seaport(provider);
  const endTime = Math.floor(Date.now() / 1000) + Math.max(1, Number(durationDays) || 30) * 86400;
  const { executeAllActions } = await seaport.createOrder({
    conduitKey: DEFAULT_CONDUIT_KEY,
    endTime,
    offer: [{
      itemType: ItemType.ERC721,
      token: contract,
      identifier: String(tokenId),
    }],
    consideration: [{
      amount: parseEther(String(priceEth)).toString(),
      recipient: account,
    }],
  }, account);
  const order = await executeAllActions();
  const payload = {
    tokenId,
    protocolAddress: SEAPORT_V16,
    order: stringify(order),
  };
  const { postLantsListing } = await import('../api.js');
  return postLantsListing(payload);
}

/**
 * Buy a listed lANTS NFT: fetch the stored signed order from antseed-zh's
 * own order book and fulfill it directly against Seaport. No OpenSea
 * involvement -- the buyer's wallet pays the seller in one on-chain tx.
 */
export async function fulfillListing({ walletClient, account, tokenId }) {
  const [{ Seaport }, { BrowserProvider }, { fetchLantsOrder }] = await Promise.all([
    import('@opensea/seaport-js'),
    import('ethers'),
    import('../api.js'),
  ]);
  const stored = await fetchLantsOrder(tokenId);
  const network = { chainId: walletClient.chain.id, name: walletClient.chain.name };
  const provider = new BrowserProvider(walletClient.transport, network);
  const seaport = new Seaport(provider);
  const order = { parameters: stored.orderParameters, signature: stored.signature };
  const { executeAllActions } = await seaport.fulfillOrder({
    order,
    accountAddress: account,
  });
  return executeAllActions();
}
