import { ponder } from "ponder:registry";
import { zeroAddress, decodeEventLog } from "viem";

import { lantsPosition, lantsTrade } from "../ponder.schema";
import { SeaportOrderFulfilledAbi } from "../abis/SeaportOrderFulfilledAbi";

// Seaport 1.6 on Base -- same address backend/opensea-list.js and
// src/lib/listLants.js sign orders against (SEAPORT_V16).
const SEAPORT_V16 = "0x0000000000000068F116a894984e2DB1123eB395".toLowerCase();

ponder.on("AntseedSellerPools:Transfer", async ({ event, context }) => {
  const { from, to, tokenId } = event.args;
  const tokenIdStr = tokenId.toString();
  const blockNumber = event.block.number;
  const timestamp = event.block.timestamp;

  await context.db
    .insert(lantsPosition)
    .values({ id: tokenIdStr, owner: to, lastTransferBlock: blockNumber, lastTransferAt: timestamp })
    .onConflictDoUpdate({ owner: to, lastTransferBlock: blockNumber, lastTransferAt: timestamp });

  if (from === zeroAddress) return; // mint, not a transfer between holders -- no trade to record

  let priceWei: bigint | null = null;
  let currency: `0x${string}` | null = null;
  let seaportOrderHash: `0x${string}` | null = null;

  // Ground truth for "was this actually a Seaport sale, and at what price" --
  // look at whatever else Seaport logged in this same transaction, rather
  // than trusting whichever channel (this app / OpenSea / a raw
  // fulfillOrder call) triggered the transfer. A Transfer with no matching
  // OrderFulfilled log here (a split/merge/internal move) correctly leaves
  // price null instead of a guess.
  const receipt = await context.client.getTransactionReceipt({ hash: event.transaction.hash });
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== SEAPORT_V16) continue;
    let decoded: ReturnType<typeof decodeEventLog<typeof SeaportOrderFulfilledAbi>>;
    try {
      decoded = decodeEventLog({ abi: SeaportOrderFulfilledAbi, data: log.data, topics: log.topics });
    } catch {
      continue; // Seaport emits other events too (OrderCancelled, OrdersMatched, ...)
    }
    if (decoded.eventName !== "OrderFulfilled") continue;

    const { orderHash, offer, consideration } = decoded.args;
    // Seaport ItemType: 0 = native ETH, 1 = ERC20 -- both are a real price.
    // 2/3/4/5 are ERC721/ERC1155 (incl. criteria-based) items, e.g. a swap or
    // the position NFT itself moving as part of a merge/split -- not a price,
    // and must not be summed as if their `amount` (a token quantity) were wei.
    //
    // The currency leg can land on either side depending on who created the
    // order: a listing's offerer gives the NFT (offer) for ETH/WETH
    // (consideration to them), but a bid/offer's offerer gives WETH (offer)
    // for the NFT (consideration to them) -- e.g. tokenId 46's WETH offer
    // accept on 2026-09-20 (tx 0xb66ba8d7...) had the whole 0.0011 WETH
    // payment in `offer`, with `consideration` holding only the NFT itself.
    // Checking both sides and filtering by itemType handles either shape.
    const paymentItems = [...offer, ...consideration].filter((c) => c.itemType === 0 || c.itemType === 1);
    const tokens = new Set(paymentItems.map((c) => c.token.toLowerCase()));
    if (paymentItems.length > 0 && tokens.size === 1) {
      priceWei = paymentItems.reduce((sum, c) => sum + c.amount, 0n);
      currency = paymentItems[0]!.token;
      seaportOrderHash = orderHash;
    }
    break; // one fulfilled order accounts for this transfer either way
  }

  await context.db.insert(lantsTrade).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    tokenId: tokenIdStr,
    seller: from,
    buyer: to,
    priceWei,
    currency,
    seaportOrderHash,
    txHash: event.transaction.hash,
    blockNumber,
    timestamp,
  });
});
