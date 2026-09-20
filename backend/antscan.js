// Antscan GraphQL client — the same public, CORS-open API antseed.com's own
// useNetworkStats.ts uses for real (non-fabricated) network numbers.
// https://antscan.co/graphql (Ponder-generated schema).

const ANTSCAN_GRAPHQL = 'https://antscan.co/graphql';

async function gql(query, variables = {}) {
  const res = await fetch(ANTSCAN_GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Antscan GraphQL ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return body.data;
}

/** Network-wide totals: real settled volume, tokens, buyer/seller/channel counts. */
export async function fetchNetworkSnapshot() {
  const data = await gql(`{
    networkSnapshot(id: "network") {
      totalVolumeUsdc
      totalPlatformFeesUsdc
      totalDepositedUsdc
      totalWithdrawnUsdc
      totalStakedUsdc
      totalRequests
      totalInputTokens
      totalOutputTokens
      channelCount
      activeChannelCount
      settledChannelCount
      buyerCount
      sellerCount
      lastEventAt
    }
  }`);
  return data.networkSnapshot;
}

/** Per-buyer real aggregates (spend, requests, unique sellers, first/last seen). */
export async function fetchBuyers(limit = 2000) {
  return fetchAllPaged('buyers', 'spentUsdc', BUYER_FIELDS, limit);
}

// Antscan hard-caps `limit` at 1000 (anything above returns "Unexpected
// error"), so anything larger must be walked with the cursor API.
const PAGE_MAX = 1000;

/** Walks `pageInfo.endCursor` until `want` rows are collected or the entity
 *  is exhausted. Returns the same `{ items, totalCount }` shape a single
 *  query would. `where`, if given, is inlined verbatim as a GraphQL object
 *  literal (e.g. `{epoch: "22"}`) — callers build it, this just plumbs it
 *  through pagination. */
async function fetchAllPaged(entity, orderBy, fields, want, where = null) {
  const items = [];
  let cursor = null;
  let totalCount = 0;
  const whereClause = where ? `, where: ${where}` : '';
  while (items.length < want) {
    const pageSize = Math.min(PAGE_MAX, want - items.length);
    const after = cursor ? `, after: ${JSON.stringify(cursor)}` : '';
    const data = await gql(`{
    ${entity}(limit: ${pageSize}, orderBy: "${orderBy}", orderDirection: "desc"${whereClause}${after}) {
      items { ${fields} }
      pageInfo { hasNextPage endCursor }
      totalCount
    }
  }`);
    const page = data[entity];
    totalCount = page.totalCount;
    items.push(...page.items);
    if (!page.pageInfo?.hasNextPage || !page.pageInfo?.endCursor) break;
    cursor = page.pageInfo.endCursor;
  }
  return { items, totalCount };
}

const BUYER_FIELDS = `
        address
        spentUsdc
        depositedUsdc
        withdrawnUsdc
        requestCount
        inputTokens
        outputTokens
        channelCount
        uniqueSellers
        firstSeenAt
        lastSeenAt
`;

const SELLER_FIELDS = `
        address
        agentId
        stakeUsdc
        earnedUsdc
        requestCount
        inputTokens
        outputTokens
        uniqueBuyers
        channelCount
        firstSeenAt
        lastSeenAt
`;


/** Per-seller real aggregates (earned USDC, stake, requests, unique buyers). */
export async function fetchSellers(limit = 2000) {
  return fetchAllPaged('sellers', 'earnedUsdc', SELLER_FIELDS, limit);
}


/** Daily network activity — the historical time series. Days are immutable
 *  once the UTC day has fully elapsed, so callers should only refetch
 *  "today" and any not-yet-seen prior days, never overwrite closed days
 *  with new fetches (closed-day data never changes on Antscan either, but
 *  fewer requests is still better for a public API we don't operate). */
export async function fetchDailyMetrics(limit = 120) {
  const data = await gql(`{
    dailyMetrics(limit: ${limit}, orderBy: "dayStart", orderDirection: "desc") {
      items {
        day
        dayStart
        volumeUsdc
        platformFeesUsdc
        depositsUsdc
        withdrawalsUsdc
        requests
        inputTokens
        outputTokens
        openedChannels
        settledEvents
        closedChannels
        activeBuyers
        activeSellers
      }
    }
  }`);
  return data.dailyMetrics.items;
}

/** Per-epoch network totals (volume, requests, tokens). Epochs are the
 *  recognized-usage era's reward-accounting periods (epoch 22 = current,
 *  started 2026-09-10). Real data, no groupBy/aggregate support on this
 *  API, so buyer/seller *counts* per epoch come from separate queries
 *  below (sellerEpochs/buyerEpochs .totalCount). */
export async function fetchEpochMetrics(limit = 30) {
  // Ordered DESC so `limit` keeps the most RECENT epochs (ASC + limit would
  // pin the sync to epochs 0..limit-1 and never fetch new ones once the
  // protocol passes that many epochs). Reversed back to chronological order
  // before returning, so callers still see oldest-first.
  const data = await gql(`{
    epochMetrics(limit: ${limit}, orderBy: "epoch", orderDirection: "desc") {
      items {
        epoch
        volumeUsdc
        requests
        inputTokens
        outputTokens
      }
    }
  }`);
  return [...data.epochMetrics.items].reverse();
}

/** Count of distinct sellers that settled at least one channel in a given
 *  epoch. NOTE: the `epoch` filter must be passed as a String
 *  (`where: {epoch: "22"}`), not an Int/BigInt literal — Antscan's schema
 *  types `epoch` as a `BigInt` scalar, encoded as a GraphQL StringValue. */
export async function fetchSellerEpochCount(epoch) {
  const data = await gql(`{
    sellerEpochs(limit: 1, where: {epoch: "${epoch}"}) {
      totalCount
    }
  }`);
  return data.sellerEpochs.totalCount;
}

/** Count of distinct buyers that settled at least one channel in a given
 *  epoch. Same String-typed `epoch` filter requirement as above. */
export async function fetchBuyerEpochCount(epoch) {
  const data = await gql(`{
    buyerEpochs(limit: 1, where: {epoch: "${epoch}"}) {
      totalCount
    }
  }`);
  return data.buyerEpochs.totalCount;
}

// ─── Current-epoch per-participant data (recognized-usage era, M001) ───
// Real per-address/per-agent points and stake for a single epoch — used to
// show buyers/sellers what they've earned *this* epoch, not just all-time.
// See notes/epoch-features-plan.md.

const EPOCH_PARTICIPANT_FIELDS = `
        buyer
        epoch
        points
        volumeUsdc
        requests
`;

/** Every buyer with recognized activity in a given epoch, points-desc.
 *  `points` is recognized volume in micro-USDC units after policy
 *  filtering (wash-trading etc.) — NOT the same as `weightedPoints`, which
 *  is an internal fixed-point reward-index intermediate and not
 *  human-readable on its own. */
export async function fetchBuyerEpochs(epoch, limit = 5000) {
  return fetchAllPaged('buyerEpochs', 'points', EPOCH_PARTICIPANT_FIELDS, limit, `{epoch: "${epoch}"}`);
}

const SELLER_EPOCH_FIELDS = `
        seller
        agentId
        epoch
        points
        volumeUsdc
        requests
`;

/** Every seller with recognized activity in a given epoch, points-desc. */
export async function fetchSellerEpochs(epoch, limit = 5000) {
  return fetchAllPaged('sellerEpochs', 'points', SELLER_EPOCH_FIELDS, limit, `{epoch: "${epoch}"}`);
}

/** Per-seller-pool stake for a given epoch (`activeStake`, in ANTS wei) —
 *  the pool's total, contributed by anyone who staked into it, not just
 *  the seller themselves. Keyed by `agentId`. */
export async function fetchPoolEpochs(epoch, limit = 5000) {
  const fields = `agentId epoch activeStake weight usagePoints settled`;
  return fetchAllPaged('poolEpochs', 'activeStake', fields, limit, `{epoch: "${epoch}"}`);
}

/** Every currently-open (not withdrawn) lANTS stake position, network-wide —
 *  small (tens, not thousands, as of the recognized-usage era's early
 *  weeks), so fetched in full rather than filtered per-owner. Used to find
 *  which buyers/sellers also hold a staking position, for the pool-reward
 *  component of "potential rewards" (see notes/epoch-features-plan.md). */
export async function fetchOpenStakePositions(limit = 5000) {
  // closedAtEpoch: a split/merge/move burns the NFT via _burn() but leaves
  // `withdrawn` false forever on the source position -- only closedAtEpoch
  // marks it dead. Without this field callers can't tell a real open
  // position from a burned one that still happens to pass {withdrawn: false}.
  const fields = `id owner agentId amount weightAmount stakeStartEpoch stakeEndEpoch closedAtEpoch`;
  return fetchAllPaged('stakePositions', 'id', fields, limit, `{withdrawn: false}`);
}

/** Network-wide totals for a single epoch (total buyer/seller points, total
 *  active stake, total settled volume/requests) — the denominator side of
 *  the dynamic reward-share formula. Singular lookup, not paginated. */
export async function fetchStakingEpoch(epoch) {
  const data = await gql(`{
    stakingEpoch(id: "${epoch}") {
      epoch totalBuyerPoints totalSellerPoints totalActiveStake totalPowerWeight volumeUsdc requests stakerBudget
    }
  }`);
  return data.stakingEpoch;
}
