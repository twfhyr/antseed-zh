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
  const tx = await executeAllActions();
  const receipt = typeof tx?.wait === 'function' ? await tx.wait() : tx;
  return {
    hash: receipt?.hash || tx?.hash || null,
    seller: stored.orderParameters?.offerer || null,
    priceWei: stored.orderParameters?.consideration?.[0]?.startAmount ?? null,
  };
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
  const tx = await executeAllActions();
  const receipt = typeof tx?.wait === 'function' ? await tx.wait() : tx;
  const hash = receipt?.hash || tx?.hash || null;
  await acceptLantsOffer(offerId, account, hash);
  return { hash };
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

// Only the merge/move entry points -- same pattern as
// SELLER_POOLS_SPLIT_ABI above, one file per action isn't warranted for
// two more single-function ABIs.
const SELLER_POOLS_MERGE_MOVE_ABI = [
  {
    name: 'mergeStakes', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'positionIds', type: 'uint256[]' }],
    outputs: [{ name: 'newPositionId', type: 'uint256' }],
  },
  {
    type: 'event', name: 'StakesMerged', anonymous: false,
    inputs: [
      { name: 'positionIds', type: 'uint256[]', indexed: false },
      { name: 'newPositionId', type: 'uint256', indexed: true },
      { name: 'staker', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'weightAmount', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'moveStake', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'positionId', type: 'uint256' }, { name: 'toAgentId', type: 'uint256' }],
    outputs: [{ name: 'newPositionId', type: 'uint256' }],
  },
  {
    type: 'event', name: 'StakeMoved', anonymous: false,
    inputs: [
      { name: 'oldPositionId', type: 'uint256', indexed: true },
      { name: 'newPositionId', type: 'uint256', indexed: true },
      { name: 'staker', type: 'address', indexed: true },
      { name: 'fromAgentId', type: 'uint256', indexed: false },
      { name: 'toAgentId', type: 'uint256', indexed: false },
    ],
  },
];

/**
 * Merge 2+ of the caller's own lANTS positions in the SAME seller pool into
 * one. On-chain requirement (AntseedSellerPools.sol): every position must
 * share the same agent id and, after closing for restructure, the same
 * normal start/end epoch -- in practice, positions with the same lock end
 * date in the same pool. Never pre-validated beyond that here: the chain is
 * the source of truth for exact eligibility, a mismatched pick just reverts
 * with the real reason rather than being guessed at client-side. Sources
 * close next epoch; the merged position inherits their combined amount and
 * weight and cannot be withdrawn before it takes over their power.
 */
export async function mergePositions({ walletClient, account, poolsAddress, positionIds }) {
  const [{ BrowserProvider, Contract, Interface }] = await Promise.all([import('ethers')]);
  const network = { chainId: walletClient.chain.id, name: walletClient.chain.name };
  const provider = new BrowserProvider(walletClient.transport, network);
  const signer = await provider.getSigner(account);
  const pools = new Contract(poolsAddress, SELLER_POOLS_MERGE_MOVE_ABI, signer);
  const tx = await pools.mergeStakes(positionIds);
  const receipt = await tx.wait();

  const iface = new Interface(SELLER_POOLS_MERGE_MOVE_ABI);
  let newPositionId = null;
  for (const log of receipt.logs || []) {
    if (log.address?.toLowerCase() !== poolsAddress.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === 'StakesMerged') {
        newPositionId = parsed.args.newPositionId.toString();
        break;
      }
    } catch { /* not this event */ }
  }
  return { hash: receipt.hash, newPositionId };
}

/**
 * Move one lANTS position to a different seller's pool -- re-targets who
 * the stake counts toward, keeping the same principal and lock end epoch.
 * Takes effect next epoch; future weight only (never principal) may be
 * reduced by a configured move penalty (AntseedSellerPools.sol:
 * moveWeightPenaltyBps). Closes the source and mints a replacement, same
 * restructure pattern as split/merge.
 */
export async function movePosition({ walletClient, account, poolsAddress, positionId, toAgentId }) {
  const [{ BrowserProvider, Contract, Interface }] = await Promise.all([import('ethers')]);
  const network = { chainId: walletClient.chain.id, name: walletClient.chain.name };
  const provider = new BrowserProvider(walletClient.transport, network);
  const signer = await provider.getSigner(account);
  const pools = new Contract(poolsAddress, SELLER_POOLS_MERGE_MOVE_ABI, signer);
  const tx = await pools.moveStake(positionId, toAgentId);
  const receipt = await tx.wait();

  const iface = new Interface(SELLER_POOLS_MERGE_MOVE_ABI);
  let newPositionId = null;
  for (const log of receipt.logs || []) {
    if (log.address?.toLowerCase() !== poolsAddress.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === 'StakeMoved') {
        newPositionId = parsed.args.newPositionId.toString();
        break;
      }
    } catch { /* not this event */ }
  }
  return { hash: receipt.hash, newPositionId };
}
