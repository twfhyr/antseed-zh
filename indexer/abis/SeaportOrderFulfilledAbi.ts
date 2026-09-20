// Minimal ABI for decoding Seaport 1.6's OrderFulfilled event ad hoc, from
// inside the AntseedSellerPools:Transfer handler, against whatever logs
// share that transaction. Deliberately NOT registered as a ponder contract:
// Seaport is a shared, high-volume protocol contract used by unrelated
// collections across all of Base, and OrderFulfilled carries no
// per-collection topic to filter on at the RPC layer, so indexing it
// directly would mean backfilling and storing every Seaport trade on the
// chain to find the handful that touch our own NFT. We already know which
// transactions matter (the ones that moved one of our tokenIds), so we look
// up just those receipts instead.
export const SeaportOrderFulfilledAbi = [
  {
    type: "event",
    name: "OrderFulfilled",
    inputs: [
      { name: "orderHash", type: "bytes32", indexed: false },
      { name: "offerer", type: "address", indexed: true },
      { name: "zone", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: false },
      {
        name: "offer",
        type: "tuple[]",
        indexed: false,
        components: [
          { name: "itemType", type: "uint8" },
          { name: "token", type: "address" },
          { name: "identifier", type: "uint256" },
          { name: "amount", type: "uint256" },
        ],
      },
      {
        name: "consideration",
        type: "tuple[]",
        indexed: false,
        components: [
          { name: "itemType", type: "uint8" },
          { name: "token", type: "address" },
          { name: "identifier", type: "uint256" },
          { name: "amount", type: "uint256" },
          { name: "recipient", type: "address" },
        ],
      },
    ],
  },
] as const;
