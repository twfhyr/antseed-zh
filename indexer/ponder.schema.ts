import { onchainTable } from "ponder";

// Current owner per lANTS tokenId, kept up to date by every Transfer --
// the ground truth this indexer exists to provide, since Antscan's own
// indexer can lag behind a real sale (see backend/lants-trades.js in the
// main app for the workaround this is meant to replace).
export const lantsPosition = onchainTable("lants_position", (t) => ({
  id: t.text().primaryKey(), // tokenId, as a string
  owner: t.hex().notNull(),
  lastTransferBlock: t.bigint().notNull(),
  lastTransferAt: t.bigint().notNull(), // unix seconds
}));

// One row per non-mint Transfer of a lANTS position. priceWei/currency are
// filled in only when the same transaction also contains a Seaport
// OrderFulfilled log whose consideration resolves to a single currency --
// otherwise they stay null rather than guess (a split/merge/internal move
// has no sale price at all; an unusual multi-currency consideration is left
// unresolved rather than reported wrong).
export const lantsTrade = onchainTable("lants_trade", (t) => ({
  id: t.text().primaryKey(), // `${txHash}-${logIndex}`
  tokenId: t.text().notNull(),
  seller: t.hex().notNull(),
  buyer: t.hex().notNull(),
  priceWei: t.bigint(),
  currency: t.hex(), // ERC-20 paid; Seaport represents native ETH as the zero address
  seaportOrderHash: t.hex(),
  txHash: t.hex().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
}));
