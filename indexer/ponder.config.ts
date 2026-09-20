import { createConfig } from "ponder";

import { AntseedSellerPoolsAbi } from "./abis/AntseedSellerPoolsAbi";

// Same public Base mainnet endpoints the rest of the AntSeed protocol uses
// (see antseed monorepo's packages/node/src/payments/chain-config.ts), no
// API key needed. Passed as a list so ponder fails over when one is
// rate-limited or flaky -- a single free public gateway alone isn't enough
// to sustain a multi-million-block backfill.
const DEFAULT_BASE_RPC_URLS = [
  "https://base.gateway.tenderly.co",
  "https://base.drpc.org",
  "https://base-public.nodies.app",
  "https://mainnet.base.org",
];

export default createConfig({
  chains: {
    base: {
      id: 8453,
      rpc: process.env.PONDER_RPC_URL_8453
        ? [process.env.PONDER_RPC_URL_8453, ...DEFAULT_BASE_RPC_URLS]
        : DEFAULT_BASE_RPC_URLS,
      // base-public.nodies.app's free tier hard-caps eth_getLogs at 50
      // blocks and returns a plain "resource not found" (not a retryable
      // rate-limit shape) for anything wider -- ponder treated that as fatal
      // instead of shrinking the range, which crashed a live backfill at
      // 93.4%. Capping every chain's request to 40 blocks avoids the
      // mismatch regardless of which fallback RPC actually serves it.
      ethGetLogsBlockRange: 40,
    },
  },
  contracts: {
    // lANTS positions -- locked ANTS stake represented as ERC-721s. Address
    // from the antseed monorepo's DEPLOYED_CONTRACT_ADDRESSES['base-mainnet'].sellerPoolsAddress.
    AntseedSellerPools: {
      chain: "base",
      abi: AntseedSellerPoolsAbi,
      address: "0x8bf4d39aa13f3cb03f87d9500767fbc4d0940652",
      // Verified live against base.gateway.tenderly.co on 2026-09-20: eth_getCode
      // is empty at block 50955028 and non-empty at 50955029 for this address.
      startBlock: 50955029,
    },
  },
});
