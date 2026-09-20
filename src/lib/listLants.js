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

// Only the split entry point -- other SellerPools calls (stake/claim/etc.)
// live in StakeANTS.jsx's own ABI, this file only needs this one.
const SELLER_POOLS_SPLIT_ABI = [
  {
    name: 'splitStake', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'positionId', type: 'uint256' }, { name: 'splitAmount', type: 'uint256' }],
    outputs: [{ name: 'firstPositionId', type: 'uint256' }, { name: 'secondPositionId', type: 'uint256' }],
  },
  {
    type: 'event', name: 'StakeSplit', anonymous: false,
    inputs: [
      { name: 'positionId', type: 'uint256', indexed: true },
      { name: 'firstPositionId', type: 'uint256', indexed: true },
      { name: 'secondPositionId', type: 'uint256', indexed: true },
      { name: 'staker', type: 'address', indexed: false },
      { name: 'firstAmount', type: 'uint256', indexed: false },
      { name: 'secondAmount', type: 'uint256', indexed: false },
    ],
  },
];
// Canonical WETH predeploy, same address on every OP-Stack chain (Base
// included) -- confirmed by calling name() on it, not assumed. Offers have
// to be WETH: fulfillOrder is called by the SELLER, who can only pull an
// ERC20 the buyer pre-approved, not attach the buyer's raw ETH as msg.value.
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const WETH_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'deposit', type: 'function', stateMutability: 'payable', inputs: [], outputs: [] },
];

async function signTimestampedMessage(walletClient, account, action, id) {
  const message = `Antseed-zh lANTS: ${action} #${id} @ ${Date.now()}`;
  const signature = await walletClient.signMessage({ account, message });
  return { message, signature };
}

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

/** Unlist: removes antseed-zh's own copy of the order. Nothing was ever
 * posted on-chain (Seaport orders are gas-free signatures until fulfilled),
 * so there's no separate on-chain cancel needed for an order that only
 * ever lived in this order book. */
export async function cancelListing({ walletClient, account, tokenId }) {
  const { message, signature } = await signTimestampedMessage(walletClient, account, 'Cancel listing', tokenId);
  const { cancelLantsListing } = await import('../api.js');
  return cancelLantsListing({ tokenId, message, signature });
}

async function ensureWeth(walletClient, account, amountWei) {
  const [{ BrowserProvider, Contract, parseEther }] = await Promise.all([import('ethers')]);
  const network = { chainId: walletClient.chain.id, name: walletClient.chain.name };
  const provider = new BrowserProvider(walletClient.transport, network);
  const signer = await provider.getSigner(account);
  const weth = new Contract(WETH_BASE, WETH_ABI, signer);
  const balance = await weth.balanceOf(account);
  if (balance < amountWei) {
    const tx = await weth.deposit({ value: amountWei - balance });
    await tx.wait();
  }
}

/** Offer WETH for a specific lANTS NFT -- the owner doesn't have to be
 * selling yet; they can review and accept later (or never). */
export async function makeOffer({ walletClient, account, contract, tokenId, priceEth, durationDays }) {
  const [{ Seaport, ItemType }, { BrowserProvider, parseEther }] = await Promise.all([
    import('@opensea/seaport-js'),
    import('ethers'),
  ]);
  const amountWei = parseEther(String(priceEth));
  await ensureWeth(walletClient, account, amountWei);

  const network = { chainId: walletClient.chain.id, name: walletClient.chain.name };
  const provider = new BrowserProvider(walletClient.transport, network);
  const seaport = new Seaport(provider);
  const endTime = Math.floor(Date.now() / 1000) + Math.max(1, Number(durationDays) || 30) * 86400;
  const { executeAllActions } = await seaport.createOrder({
    conduitKey: DEFAULT_CONDUIT_KEY,
    endTime,
    offer: [{
      itemType: ItemType.ERC20,
      token: WETH_BASE,
      amount: amountWei.toString(),
    }],
    consideration: [{
      itemType: ItemType.ERC721,
      token: contract,
      identifier: String(tokenId),
      recipient: account,
    }],
  }, account);
  const order = await executeAllActions();
  const { postLantsOffer } = await import('../api.js');
  return postLantsOffer({ tokenId, protocolAddress: SEAPORT_V16, order: stringify(order) });
}

export async function cancelOffer({ walletClient, account, offerId }) {
  const { message, signature } = await signTimestampedMessage(walletClient, account, 'Cancel offer', offerId);
  const { cancelLantsOffer } = await import('../api.js');
  return cancelLantsOffer({ offerId, message, signature });
}

/** Accept a standing offer: the current owner fulfills the buyer's signed
 * order directly against Seaport -- same mechanism as a buyer fulfilling a
 * listing, just with the two sides swapped. */
export async function acceptOffer({ walletClient, account, offerId }) {
  const [{ Seaport }, { BrowserProvider }, { fetchLantsOffer, acceptLantsOffer }] = await Promise.all([
    import('@opensea/seaport-js'),
    import('ethers'),
    import('../api.js'),
  ]);
  const stored = await fetchLantsOffer(offerId);
  const network = { chainId: walletClient.chain.id, name: walletClient.chain.name };
  const provider = new BrowserProvider(walletClient.transport, network);
  const seaport = new Seaport(provider);
  const order = { parameters: stored.orderParameters, signature: stored.signature };
  const { executeAllActions } = await seaport.fulfillOrder({ order, accountAddress: account });
  const result = await executeAllActions();
  await acceptLantsOffer(offerId);
  return result;
}

/**
 * Split one lANTS position into two, both still owned by the caller --
 * splitStake() burns the source NFT and mints two new ones (amount -
 * splitAmount, splitAmount), preserving the original's lock end epoch and
 * early-exit slash basis. This does NOT send anything to another address;
 * to give one half away, transfer that resulting position id separately
 * (a normal ERC-721 transfer) after this confirms. Takes effect at the
 * next epoch -- both halves show "Pending" until then. Reverts if the
 * position is max-locked (call disableMaxLock first) or already matured.
 */
export async function splitPosition({ walletClient, account, poolsAddress, positionId, splitAmountAnts }) {
  const [{ BrowserProvider, Contract, Interface, parseEther }] = await Promise.all([import('ethers')]);
  const network = { chainId: walletClient.chain.id, name: walletClient.chain.name };
  const provider = new BrowserProvider(walletClient.transport, network);
  const signer = await provider.getSigner(account);
  const pools = new Contract(poolsAddress, SELLER_POOLS_SPLIT_ABI, signer);
  const splitAmountWei = parseEther(String(splitAmountAnts));
  const tx = await pools.splitStake(positionId, splitAmountWei);
  const receipt = await tx.wait();

  const iface = new Interface(SELLER_POOLS_SPLIT_ABI);
  let firstPositionId = null;
  let secondPositionId = null;
  for (const log of receipt.logs || []) {
    if (log.address?.toLowerCase() !== poolsAddress.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === 'StakeSplit') {
        firstPositionId = parsed.args.firstPositionId.toString();
        secondPositionId = parsed.args.secondPositionId.toString();
        break;
      }
    } catch { /* not this event */ }
  }
  return { hash: receipt.hash, firstPositionId, secondPositionId };
}
