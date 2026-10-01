// Provider social APIs for antseedmarkets' Providers tab.
// Public identifier is the provider's on-chain agentId (not the wallet
// and not the DHT seller_ id). Catalog still comes from GET /api/sellers.
// Membership: Antscan buyerSellerPair for buyers (deposits buyer wallet
// or that buyer's on-chain operator); local stake_positions (open,
// non-activation) for stakers; sellers_onchain address for owner.
// Comments/chat display the operator wallet so a buyer hot wallet and
// its operator post as the same identity.

import { Contract, Interface, verifyMessage } from 'ethers';
import { DepositsClient, resolveChainConfig } from '@antseed/node';
import db from './database.js';
import {
  fetchBuyerSellerPair,
  fetchBuyerSellerPairs,
  fetchBuyerSellerPairsForBuyer,
  fetchBuyerSellerPairsForSeller,
} from './antscan.js';
import { attachAuthorProfiles, publicProfile } from './user-profiles.js';

const AGENT_ID_RE = /^\d+$/;
const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const ACTION_WINDOW_MS = 5 * 60_000;
const COMMENT_MAX = 2000;
const ANNOUNCE_MAX = 4000;
const CHAT_MAX = 500;
const COMMENT_COOLDOWN_MS = 30_000;
const ANNOUNCE_COOLDOWN_MS = 10_000;
const CHAT_COOLDOWN_MS = 2_000;
const BUYER_COUNT_TTL_MS = 5 * 60_000;
const MEMBER_TTL_MS = 2 * 60_000;
const OPERATOR_TTL_MS = 10 * 60_000;
const OPERATOR_CHUNK = 200;
const PAIR_TTL_MS = 5 * 60_000;
const ROLE_ORDER = ['owner', 'buyer', 'staker'];
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const OPERATOR_IFACE = new Interface([
  'function getOperator(address buyer) view returns (address)',
]);
const MULTICALL_IFACE = new Interface([
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
]);

const memberCache = new Map();
const operatorCache = new Map();
const sellerBuyersCache = new Map();
const sellerOperatorsCache = new Map();
let buyerCountCache = { at: 0, map: null, promise: null };
let pairCache = { at: 0, items: null, promise: null };
let depositsClient = null;

function getDepositsClient() {
  if (depositsClient) return depositsClient;
  const cfg = resolveChainConfig('base-mainnet');
  depositsClient = new DepositsClient({
    rpcUrl: cfg.rpcUrl,
    fallbackRpcUrls: cfg.fallbackRpcUrls,
    contractAddress: cfg.depositsContractAddress,
    usdcAddress: cfg.usdcContractAddress,
    evmChainId: cfg.evmChainId,
  });
  return depositsClient;
}

function isZeroAddress(addr) {
  return !addr || String(addr).toLowerCase() === ZERO_ADDRESS;
}

function jsonError(res, status, error) {
  return res.status(status).json({ error });
}

function parseRoles(raw, fallbackRole) {
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return ROLE_ORDER.filter((r) => parsed.includes(r));
      }
    } catch {
      /* stored as comma list */
      const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
      return ROLE_ORDER.filter((r) => parts.includes(r));
    }
  }
  if (fallbackRole === 'owner' || fallbackRole === 'buyer' || fallbackRole === 'staker') {
    return [fallbackRole];
  }
  return [];
}

function camelizeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sellerId: row.seller_id,
    author: row.author,
    body: row.body,
    rating: row.rating == null ? null : Number(row.rating),
    roles: parseRoles(row.roles, row.role),
    createdAt: row.created_at,
  };
}

function parseAgentId(raw) {
  const id = String(raw || '');
  return AGENT_ID_RE.test(id) ? id : null;
}

export function loadSellerByAgentId(agentId) {
  const id = parseAgentId(agentId);
  if (!id) return null;
  return db.prepare('SELECT * FROM sellers WHERE agent_id = ?').get(id) || null;
}

/** On-chain seller wallet for a DHT catalog row. Prefer sellers_onchain
 *  matched by agent_id (Venice's DHT peer id is not its payment address);
 *  fall back to the seller_id suffix, which matches for most peers. */
export function resolveProviderWallet(sellerRow) {
  if (!sellerRow) return null;
  if (sellerRow.agent_id != null && String(sellerRow.agent_id) !== '') {
    const onchain = db.prepare(
      'SELECT address FROM sellers_onchain WHERE agent_id = ?'
    ).get(String(sellerRow.agent_id));
    if (onchain?.address && ADDR_RE.test(onchain.address)) {
      return onchain.address.toLowerCase();
    }
  }
  const m = String(sellerRow.id || '').match(/^seller_([0-9a-fA-F]{40})$/);
  return m ? `0x${m[1].toLowerCase()}` : null;
}

export function isOwnerAddress(sellerRow, address) {
  const wallet = resolveProviderWallet(sellerRow);
  if (!wallet || !address) return false;
  return wallet === String(address).toLowerCase();
}

function isActivationStake(amountWei) {
  if (amountWei == null) return false;
  const ants = Number(amountWei) / 1e18;
  return Number.isFinite(ants) && Math.abs(ants - 1) < 1e-6;
}

/** Open lANTS position in this provider's pool, excluding the mandatory
 *  1 ANT activation stake (same rule as /api/stakers). */
function isStakerOf(sellerRow, address) {
  const agentId = sellerRow?.agent_id != null ? String(sellerRow.agent_id) : '';
  const owner = String(address || '').toLowerCase();
  if (!agentId || !ADDR_RE.test(owner)) return false;
  const rows = db.prepare(
    `SELECT amount FROM stake_positions
     WHERE lower(owner) = ? AND agent_id = ? AND COALESCE(closed_at_epoch, 0) = 0`
  ).all(owner, agentId);
  return rows.some((r) => r.amount != null && Number(r.amount) > 0 && !isActivationStake(r.amount));
}

async function getOperatorCached(address) {
  const addr = String(address || '').toLowerCase();
  if (!ADDR_RE.test(addr)) return ZERO_ADDRESS;
  const hit = operatorCache.get(addr);
  if (hit && Date.now() - hit.at < OPERATOR_TTL_MS) return hit.value;
  const op = String(await getDepositsClient().getOperator(addr) || '').toLowerCase();
  const value = ADDR_RE.test(op) ? op : ZERO_ADDRESS;
  operatorCache.set(addr, { at: Date.now(), value });
  return value;
}

async function operatorsOfBuyers(buyers) {
  const out = new Map();
  const missing = [];
  const now = Date.now();
  for (const buyer of buyers) {
    const hit = operatorCache.get(buyer);
    if (hit && now - hit.at < OPERATOR_TTL_MS) out.set(buyer, hit.value);
    else missing.push(buyer);
  }
  if (missing.length === 0) return out;

  const client = getDepositsClient();
  const target = client.contractAddress;
  const multicall = new Contract(MULTICALL3_ADDRESS, MULTICALL_IFACE, client.provider);

  for (let i = 0; i < missing.length; i += OPERATOR_CHUNK) {
    const chunk = missing.slice(i, i + OPERATOR_CHUNK);
    const calls = chunk.map((buyer) => ({
      target,
      allowFailure: true,
      callData: OPERATOR_IFACE.encodeFunctionData('getOperator', [buyer]),
    }));
    let returned;
    try {
      returned = await multicall.getFunction('aggregate3').staticCall(calls);
    } catch {
      returned = null;
    }

    const at = Date.now();
    if (returned) {
      chunk.forEach((buyer, idx) => {
        const row = returned[idx];
        if (!row?.success || !row.returnData) return;
        try {
          const decoded = OPERATOR_IFACE.decodeFunctionResult('getOperator', row.returnData);
          const op = String(decoded[0] || '').toLowerCase();
          const value = ADDR_RE.test(op) ? op : ZERO_ADDRESS;
          operatorCache.set(buyer, { at, value });
          out.set(buyer, value);
        } catch {
          /* skip a single decode miss */
        }
      });
      continue;
    }

    const rows = await Promise.all(chunk.map(async (buyer) => {
      try {
        const op = String(await client.getOperator(buyer) || '').toLowerCase();
        return [buyer, ADDR_RE.test(op) ? op : ZERO_ADDRESS];
      } catch {
        return [buyer, null];
      }
    }));
    for (const [buyer, op] of rows) {
      if (op == null) continue;
      operatorCache.set(buyer, { at: Date.now(), value: op });
      out.set(buyer, op);
    }
  }
  return out;
}

async function buyersOfSeller(sellerAddr) {
  const wallet = String(sellerAddr || '').toLowerCase();
  if (!ADDR_RE.test(wallet)) return new Set();
  const hit = sellerBuyersCache.get(wallet);
  if (hit && Date.now() - hit.at < BUYER_COUNT_TTL_MS) return hit.set;
  const result = await fetchBuyerSellerPairsForSeller(wallet);
  const set = new Set();
  for (const p of result.items || []) {
    const b = String(p.buyer || '').toLowerCase();
    if (ADDR_RE.test(b)) set.add(b);
  }
  sellerBuyersCache.set(wallet, { at: Date.now(), set });
  return set;
}

/** Display identity for comments/chat: the deposits operator if this
 *  address is a buyer that has set one, otherwise the address itself.
 *  Buyer hot wallet and operator therefore show as the same user. */
export async function displayIdentity(address) {
  const addr = String(address || '').toLowerCase();
  if (!ADDR_RE.test(addr)) return addr;
  try {
    const op = await getOperatorCached(addr);
    if (!isZeroAddress(op) && ADDR_RE.test(op)) return op;
  } catch {
    /* keep the signing wallet if the operator read fails */
  }
  return addr;
}

async function isBuyerOf(sellerRow, address) {
  const wallet = resolveProviderWallet(sellerRow);
  const addr = String(address || '').toLowerCase();
  if (!wallet || !ADDR_RE.test(addr)) return false;
  const key = `${addr}:${wallet}`;
  const hit = memberCache.get(key);
  if (hit && Date.now() - hit.at < MEMBER_TTL_MS) return hit.value;

  const pair = await fetchBuyerSellerPair(addr, wallet);
  if (pair) {
    memberCache.set(key, { at: Date.now(), value: true });
    return true;
  }

  const buyers = await buyersOfSeller(wallet);
  if (buyers.has(addr)) {
    memberCache.set(key, { at: Date.now(), value: true });
    return true;
  }

  const operators = await operatorsOfSeller(wallet, buyers);
  const value = operators.has(addr);
  memberCache.set(key, { at: Date.now(), value });
  return value;
}

async function operatorsOfSeller(sellerAddr, knownBuyers) {
  const wallet = String(sellerAddr || '').toLowerCase();
  const hit = sellerOperatorsCache.get(wallet);
  if (hit && Date.now() - hit.at < OPERATOR_TTL_MS) return hit.set;
  const buyers = knownBuyers || await buyersOfSeller(wallet);
  const ops = await operatorsOfBuyers(buyers);
  if (buyers.size > 0 && ops.size === 0) {
    throw new Error("couldn't check operator wallets for this provider");
  }
  const set = new Set();
  for (const op of ops.values()) {
    if (op && !isZeroAddress(op) && ADDR_RE.test(op)) set.add(op);
  }
  sellerOperatorsCache.set(wallet, { at: Date.now(), set });
  return set;
}

async function resolveMembership(sellerRow, address) {
  const signer = String(address || '').toLowerCase();
  const identity = await displayIdentity(signer);
  const flags = { owner: false, buyer: false, staker: false };
  const addrs = [...new Set([signer, identity])].filter((a) => ADDR_RE.test(a));
  for (const a of addrs) {
    if (isOwnerAddress(sellerRow, a)) flags.owner = true;
    if (isStakerOf(sellerRow, a)) flags.staker = true;
  }
  flags.buyer = ADDR_RE.test(signer) && await isBuyerOf(sellerRow, signer);
  if (!flags.buyer && identity !== signer) {
    flags.buyer = await isBuyerOf(sellerRow, identity);
  }
  return {
    identity: ADDR_RE.test(identity) ? identity : signer,
    roles: ROLE_ORDER.filter((r) => flags[r]),
  };
}

async function resolveRoles(sellerRow, address) {
  return (await resolveMembership(sellerRow, address)).roles;
}

function ratingStats(sellerId) {
  const row = db.prepare(
    `SELECT AVG(rating) AS avg, COUNT(rating) AS n
     FROM provider_comments WHERE seller_id = ? AND rating IS NOT NULL`
  ).get(sellerId);
  const n = Number(row?.n) || 0;
  return {
    ratingAvg: n ? Number(row.avg) : null,
    ratingCount: n,
  };
}

async function loadBuyerCounts() {
  const now = Date.now();
  if (buyerCountCache.map && now - buyerCountCache.at < BUYER_COUNT_TTL_MS) {
    return buyerCountCache.map;
  }
  if (buyerCountCache.promise) return buyerCountCache.promise;
  buyerCountCache.promise = (async () => {
    const result = await fetchBuyerSellerPairs(20000);
    const byAddr = new Map();
    for (const p of result.items || []) {
      const addr = String(p.seller || '').toLowerCase();
      if (!ADDR_RE.test(addr)) continue;
      byAddr.set(addr, (byAddr.get(addr) || 0) + 1);
    }
    const sellers = db.prepare('SELECT id, agent_id FROM sellers').all();
    const map = {};
    for (const s of sellers) {
      if (s.agent_id == null || !AGENT_ID_RE.test(String(s.agent_id))) continue;
      const addr = resolveProviderWallet(s);
      const ratings = ratingStats(s.id);
      map[String(s.agent_id)] = {
        buyers: addr ? (byAddr.get(addr) ?? 0) : null,
        ratingAvg: ratings.ratingAvg,
        ratingCount: ratings.ratingCount,
      };
    }
    buyerCountCache = { at: Date.now(), map, promise: null };
    return map;
  })().catch((err) => {
    buyerCountCache.promise = null;
    throw err;
  });
  return buyerCountCache.promise;
}

export function verifySignedAction(message, signature, expectedAddress) {
  if (!message || !signature || !expectedAddress) return false;
  const m = String(message).match(/@ (\d+)$/);
  const ts = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > ACTION_WINDOW_MS) return false;
  try {
    const recovered = verifyMessage(message, signature);
    return recovered.toLowerCase() === expectedAddress.toLowerCase();
  } catch {
    return false;
  }
}

function verifyProviderAction(message, signature, address, action, agentId) {
  const prefix = `antseedmarkets provider ${action}: ${agentId} @ `;
  if (typeof message !== 'string' || !message.startsWith(prefix)) return false;
  return verifySignedAction(message, signature, address);
}

function readSignedPost(req) {
  const { address, body, message, signature, rating } = req.body || {};
  const addr = String(address || '').toLowerCase();
  const text = typeof body === 'string' ? body.trim() : '';
  return { address: addr, body: text, message, signature, rating };
}

function parseRating(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 5) return undefined;
  return n;
}

function lastPostAt(table, sellerId, author) {
  const row = db.prepare(
    `SELECT created_at FROM ${table} WHERE seller_id = ? AND author = ? ORDER BY id DESC LIMIT 1`
  ).get(sellerId, author);
  return row?.created_at ?? 0;
}

const COMMENT_BOARD = {
  deadlineAt: Date.UTC(2026, 9, 15, 23, 59, 59, 999),
  prizeTop: 10,
  prizeLants: 10,
  commentPoints: 1,
  providerPoints: 3,
  qualityNoteMin: 40,
  qualityFullMin: 140,
  qualityNotePoints: 1,
  qualityFullPoints: 2,
};

function qualityPointsForBody(body) {
  const n = String(body || '').trim().length;
  if (n >= COMMENT_BOARD.qualityFullMin) return COMMENT_BOARD.qualityFullPoints;
  if (n >= COMMENT_BOARD.qualityNoteMin) return COMMENT_BOARD.qualityNotePoints;
  return 0;
}

function buildCommentLeaderboard() {
  const rows = db.prepare(
    `SELECT author, seller_id, body, created_at
     FROM provider_comments
     WHERE created_at <= ?
     ORDER BY id ASC`
  ).all(COMMENT_BOARD.deadlineAt);
  const byAuthor = new Map();
  for (const row of rows) {
    const author = String(row.author || '').toLowerCase();
    if (!ADDR_RE.test(author)) continue;
    let rec = byAuthor.get(author);
    if (!rec) {
      rec = {
        author,
        comments: 0,
        quality: 0,
        providers: new Set(),
        firstAt: row.created_at,
      };
      byAuthor.set(author, rec);
    }
    rec.comments += 1;
    rec.quality += qualityPointsForBody(row.body);
    rec.providers.add(row.seller_id);
    if (row.created_at < rec.firstAt) rec.firstAt = row.created_at;
  }
  const items = [...byAuthor.values()].map((rec) => {
    const providers = rec.providers.size;
    const score = rec.comments * COMMENT_BOARD.commentPoints
      + rec.quality
      + providers * COMMENT_BOARD.providerPoints;
    return {
      author: rec.author,
      comments: rec.comments,
      quality: rec.quality,
      providers,
      score,
      firstAt: rec.firstAt,
    };
  });
  items.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.providers !== a.providers) return b.providers - a.providers;
    if (b.comments !== a.comments) return b.comments - a.comments;
    if (a.firstAt !== b.firstAt) return a.firstAt - b.firstAt;
    return a.author.localeCompare(b.author);
  });
  return attachAuthorProfiles(items.map((row, i) => ({
    rank: i + 1,
    author: row.author,
    comments: row.comments,
    quality: row.quality,
    providers: row.providers,
    score: row.score,
    prizeLants: i < COMMENT_BOARD.prizeTop ? COMMENT_BOARD.prizeLants : 0,
  })));
}

function isNetworkStaker(address) {
  const owner = String(address || '').toLowerCase();
  if (!ADDR_RE.test(owner)) return false;
  const rows = db.prepare(
    `SELECT amount FROM stake_positions
     WHERE lower(owner) = ? AND COALESCE(closed_at_epoch, 0) = 0`
  ).all(owner);
  return rows.some((r) => r.amount != null && Number(r.amount) > 0 && !isActivationStake(r.amount));
}

async function allPairItems() {
  if (pairCache.items && Date.now() - pairCache.at < PAIR_TTL_MS) return pairCache.items;
  if (pairCache.promise) return pairCache.promise;
  pairCache.promise = fetchBuyerSellerPairs(20000).then((result) => {
    const items = result.items || [];
    pairCache = { at: Date.now(), items, promise: null };
    return items;
  }).catch((err) => {
    pairCache.promise = null;
    throw err;
  });
  return pairCache.promise;
}

/** Network-wide voter roles for Discovery: a buyer of any provider, or a
 *  staker of any open non-activation lANTS position. Buyer hot wallet and
 *  its operator count as one identity. */
export async function networkVoterRoles(address) {
  const signer = String(address || '').toLowerCase();
  const identity = ADDR_RE.test(signer) ? await displayIdentity(signer) : signer;
  const addrs = [...new Set([signer, identity])].filter((a) => ADDR_RE.test(a));
  let staker = false;
  for (const a of addrs) {
    if (isNetworkStaker(a)) staker = true;
  }
  let buyer = false;
  for (const a of addrs) {
    try {
      const pairs = await fetchBuyerSellerPairsForBuyer(a);
      if ((pairs.items || []).length) {
        buyer = true;
        break;
      }
    } catch {
      /* try operator reverse below */
    }
  }
  if (!buyer) {
    try {
      const items = await allPairItems();
      const buyers = [];
      const seen = new Set();
      for (const p of items) {
        const b = String(p.buyer || '').toLowerCase();
        if (!ADDR_RE.test(b) || seen.has(b)) continue;
        seen.add(b);
        buyers.push(b);
      }
      const ops = await operatorsOfBuyers(buyers);
      for (const a of addrs) {
        for (const op of ops.values()) {
          if (op === a) {
            buyer = true;
            break;
          }
        }
        if (buyer) break;
        if (seen.has(a)) buyer = true;
      }
    } catch {
      /* keep the fast-path result */
    }
  }
  return {
    identity: ADDR_RE.test(identity) ? identity : signer,
    buyer,
    staker,
  };
}

export function ownedProvidersFor(address) {
  const addr = String(address || '').toLowerCase();
  if (!ADDR_RE.test(addr)) return [];
  const sellers = db.prepare(
    'SELECT id, name, agent_id, status FROM sellers WHERE agent_id IS NOT NULL'
  ).all();
  const out = [];
  for (const s of sellers) {
    if (!AGENT_ID_RE.test(String(s.agent_id))) continue;
    if (!isOwnerAddress(s, addr)) continue;
    out.push({
      agentId: String(s.agent_id),
      name: s.name || null,
      sellerId: s.id,
      online: String(s.status || '').toLowerCase() === 'online',
    });
  }
  return out.sort((a, b) => Number(a.agentId) - Number(b.agentId));
}

export function registerProviderSocialRoutes(app) {
  app.get('/api/providers/buyer-counts', async (_req, res) => {
    try {
      const map = await loadBuyerCounts();
      res.json({ items: map });
    } catch (e) {
      return jsonError(res, 503, e?.message || 'could not load buyer counts');
    }
  });

  app.get('/api/providers/comment-leaderboard', (_req, res) => {
    const items = buildCommentLeaderboard();
    res.json({
      deadlineAt: COMMENT_BOARD.deadlineAt,
      open: Date.now() <= COMMENT_BOARD.deadlineAt,
      prizeTop: COMMENT_BOARD.prizeTop,
      prizeLants: COMMENT_BOARD.prizeLants,
      rules: {
        commentPoints: COMMENT_BOARD.commentPoints,
        providerPoints: COMMENT_BOARD.providerPoints,
        qualityNoteMin: COMMENT_BOARD.qualityNoteMin,
        qualityFullMin: COMMENT_BOARD.qualityFullMin,
        qualityNotePoints: COMMENT_BOARD.qualityNotePoints,
        qualityFullPoints: COMMENT_BOARD.qualityFullPoints,
      },
      items,
    });
  });

  app.get('/api/providers/:id/access', async (req, res) => {
    const seller = loadSellerByAgentId(req.params.id);
    if (!seller) return jsonError(res, 404, 'provider not found');
    const agentId = String(seller.agent_id);
    const address = String(req.query.address || '').toLowerCase();
    const wallet = resolveProviderWallet(seller);
    let buyers = null;
    try {
      const counts = await loadBuyerCounts();
      buyers = counts[agentId]?.buyers ?? null;
    } catch {
      buyers = null;
    }
    const ratings = ratingStats(seller.id);
    const out = {
      agentId,
      sellerId: seller.id,
      wallet,
      identity: null,
      isOwner: false,
      isBuyer: false,
      isStaker: false,
      roles: [],
      buyerCount: buyers,
      ratingAvg: ratings.ratingAvg,
      ratingCount: ratings.ratingCount,
    };
    if (ADDR_RE.test(address)) {
      try {
        const membership = await resolveMembership(seller, address);
        out.identity = membership.identity;
        out.roles = membership.roles;
      } catch (e) {
        return jsonError(res, 503, e?.message || "couldn't check this wallet's roles for this provider");
      }
      out.isOwner = out.roles.includes('owner');
      out.isBuyer = out.roles.includes('buyer');
      out.isStaker = out.roles.includes('staker');
      out.profile = publicProfile(out.identity);
    }
    res.json(out);
  });

  app.get('/api/providers/:id/comments', (req, res) => {
    const seller = loadSellerByAgentId(req.params.id);
    if (!seller) return jsonError(res, 404, 'provider not found');
    const rows = db.prepare(
      'SELECT * FROM provider_comments WHERE seller_id = ? ORDER BY id DESC LIMIT 100'
    ).all(seller.id);
    res.json({ items: attachAuthorProfiles(rows.map(camelizeRow)), ...ratingStats(seller.id) });
  });

  app.post('/api/providers/:id/comments', async (req, res) => {
    const seller = loadSellerByAgentId(req.params.id);
    if (!seller) return jsonError(res, 404, 'provider not found');
    const agentId = String(seller.agent_id);
    const { address, body, message, signature, rating: ratingRaw } = readSignedPost(req);
    if (!ADDR_RE.test(address)) return jsonError(res, 400, 'address required');
    if (!body) return jsonError(res, 400, 'comment is empty');
    if (body.length > COMMENT_MAX) return jsonError(res, 400, `comment too long (max ${COMMENT_MAX})`);
    const rating = parseRating(ratingRaw);
    if (rating === undefined || rating === null) {
      return jsonError(res, 400, 'rating must be an integer from 0 to 5');
    }
    if (!verifyProviderAction(message, signature, address, 'comment', agentId)) {
      return jsonError(res, 401, 'signature does not match this wallet');
    }
    let membership;
    try {
      membership = await resolveMembership(seller, address);
    } catch (e) {
      return jsonError(res, 503, e?.message || "couldn't check this wallet's roles for this provider");
    }
    const { roles, identity } = membership;
    if (!roles.includes('buyer') && !roles.includes('staker')) {
      return jsonError(res, 403, 'only buyers and stakers of this provider can comment');
    }
    const now = Date.now();
    if (now - lastPostAt('provider_comments', seller.id, identity) < COMMENT_COOLDOWN_MS) {
      return jsonError(res, 429, 'wait a moment before commenting again');
    }
    const result = db.prepare(
      'INSERT INTO provider_comments (seller_id, author, body, rating, roles, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(seller.id, identity, body, rating, JSON.stringify(roles), now);
    buyerCountCache = { at: 0, map: null, promise: null };
    const row = db.prepare('SELECT * FROM provider_comments WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(attachAuthorProfiles([camelizeRow(row)])[0]);
  });

  app.get('/api/providers/:id/announcements', (req, res) => {
    const seller = loadSellerByAgentId(req.params.id);
    if (!seller) return jsonError(res, 404, 'provider not found');
    const rows = db.prepare(
      'SELECT * FROM provider_announcements WHERE seller_id = ? ORDER BY id DESC LIMIT 50'
    ).all(seller.id);
    res.json({ items: attachAuthorProfiles(rows.map(camelizeRow)) });
  });

  app.post('/api/providers/:id/announcements', async (req, res) => {
    const seller = loadSellerByAgentId(req.params.id);
    if (!seller) return jsonError(res, 404, 'provider not found');
    const agentId = String(seller.agent_id);
    const { address, body, message, signature } = readSignedPost(req);
    if (!ADDR_RE.test(address)) return jsonError(res, 400, 'address required');
    if (!body) return jsonError(res, 400, 'announcement is empty');
    if (body.length > ANNOUNCE_MAX) return jsonError(res, 400, `announcement too long (max ${ANNOUNCE_MAX})`);
    if (!verifyProviderAction(message, signature, address, 'announce', agentId)) {
      return jsonError(res, 401, 'signature does not match this wallet');
    }
    if (!isOwnerAddress(seller, address)) {
      return jsonError(res, 403, 'only this provider can post announcements');
    }
    const now = Date.now();
    if (now - lastPostAt('provider_announcements', seller.id, address) < ANNOUNCE_COOLDOWN_MS) {
      return jsonError(res, 429, 'wait a moment before posting again');
    }
    let roles;
    try {
      roles = await resolveRoles(seller, address);
    } catch {
      roles = ['owner'];
    }
    const result = db.prepare(
      'INSERT INTO provider_announcements (seller_id, author, body, created_at) VALUES (?, ?, ?, ?)'
    ).run(seller.id, address, body, now);
    const row = db.prepare('SELECT * FROM provider_announcements WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ ...attachAuthorProfiles([camelizeRow(row)])[0], roles });
  });

  app.get('/api/providers/:id/chat', (req, res) => {
    const seller = loadSellerByAgentId(req.params.id);
    if (!seller) return jsonError(res, 404, 'provider not found');
    const after = Number(req.query.after) || 0;
    let rows;
    if (after > 0) {
      rows = db.prepare(
        'SELECT * FROM provider_chat_messages WHERE seller_id = ? AND id > ? ORDER BY id ASC LIMIT 200'
      ).all(seller.id, after);
    } else {
      rows = db.prepare(
        `SELECT * FROM (
           SELECT * FROM provider_chat_messages WHERE seller_id = ? ORDER BY id DESC LIMIT 200
         ) ORDER BY id ASC`
      ).all(seller.id);
    }
    res.json({ items: attachAuthorProfiles(rows.map(camelizeRow)) });
  });

  app.post('/api/providers/:id/chat', async (req, res) => {
    const seller = loadSellerByAgentId(req.params.id);
    if (!seller) return jsonError(res, 404, 'provider not found');
    const agentId = String(seller.agent_id);
    const { address, body, message, signature } = readSignedPost(req);
    if (!ADDR_RE.test(address)) return jsonError(res, 400, 'address required');
    if (!body) return jsonError(res, 400, 'message is empty');
    if (body.length > CHAT_MAX) return jsonError(res, 400, `message too long (max ${CHAT_MAX})`);
    if (!verifyProviderAction(message, signature, address, 'chat', agentId)) {
      return jsonError(res, 401, 'signature does not match this wallet');
    }
    let membership;
    try {
      membership = await resolveMembership(seller, address);
    } catch (e) {
      return jsonError(res, 503, e?.message || "couldn't check this wallet's roles for this provider");
    }
    const { roles, identity } = membership;
    if (!roles.length) {
      return jsonError(res, 403, 'only this provider, its buyers, and its stakers can chat here');
    }
    const now = Date.now();
    if (now - lastPostAt('provider_chat_messages', seller.id, identity) < CHAT_COOLDOWN_MS) {
      return jsonError(res, 429, 'wait a moment before sending again');
    }
    const result = db.prepare(
      'INSERT INTO provider_chat_messages (seller_id, author, role, roles, body, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(seller.id, identity, roles[0], JSON.stringify(roles), body, now);
    const row = db.prepare('SELECT * FROM provider_chat_messages WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(attachAuthorProfiles([camelizeRow(row)])[0]);
  });
}
