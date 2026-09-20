// Minimal ABI: just the standard ERC-721 Transfer event. AntseedSellerPools
// mints lANTS positions as ERC-721 tokens; every Transfer is ground truth for
// current ownership, independent of how a sale happened (this app, OpenSea,
// or a raw Seaport fulfillOrder call) and without waiting on Antscan's own
// indexer, which can lag behind a real sale (see backend/lants-trades.js).
export const AntseedSellerPoolsAbi = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;
