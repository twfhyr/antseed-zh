// Wallet profiles for antseedmarkets: unique nickname, optional bio and
// avatar, plus the providers that wallet has used so they can comment
// without searching the directory. Catalog provider names are reserved
// for that provider's owner wallet: the owner is shown under that name
// and cannot change it. Writes are signed
// `antseedmarkets profile: save @ <ts>` with the same 5-minute window as
// provider social.

import { Contract, Interface, verifyMessage } from 'ethers';
import { DepositsClient, resolveChainConfig } from '@antseed/node';
import db from './database.js';
import {
  fetchBuyerSellerPairs,
  fetchBuyerSellerPairsForBuyer,
} from './antscan.js';

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const AGENT_ID_RE = /^\d+$/;
const ACTION_WINDOW_MS = 5 * 60_000;
const NICK_MIN = 2;
const NICK_MAX = 24;
const RESERVED_NICK_MAX = 64;
const BIO_MAX = 280;
const AVATAR_MAX_BYTES = 220_000;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const OPERATOR_IFACE = new Interface([
  'function getOperator(address buyer) view returns (address)',
]);
const MULTICALL_IFACE = new Interface([
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
]);
const PAIR_TTL_MS = 5 * 60_000;
const OPERATOR_TTL_MS = 10 * 60_000;
const OPERATOR_CHUNK = 200;

const operatorCache = new Map();
let pairCache = { at: 0, items: null, promise: null };
let reservedCache = { at: 0, index: null };
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

function jsonError(res, status, error) {
  return res.status(status).json({ error });
}

function isAddr(value) {
  return ADDR_RE.test(String(value || ''));
}

function normalizeAddress(value) {
  const addr = String(value || '').toLowerCase();
  return isAddr(addr) ? addr : null;
}

export function normalizeNickname(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  const chars = [...trimmed];
  if (chars.length < NICK_MIN || chars.length > NICK_MAX) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (ADDR_RE.test(trimmed)) return null;
  return trimmed;
}

function nicknameKey(nickname) {
  return nickname.normalize('NFC').toLowerCase();
}

function normalizeReservedName(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  const chars = [...trimmed];
  if (chars.length < NICK_MIN || chars.length > RESERVED_NICK_MAX) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (ADDR_RE.test(trimmed)) return null;
  return trimmed;
}

function ownerWalletForSeller(seller) {
  if (!seller) return null;
  if (seller.agent_id != null && String(seller.agent_id) !== '') {
    const onchain = db.prepare(
      'SELECT address FROM sellers_onchain WHERE agent_id = ?'
    ).get(String(seller.agent_id));
    if (onchain?.address && ADDR_RE.test(onchain.address)) {
      return onchain.address.toLowerCase();
    }
  }
  const m = String(seller.id || '').match(/^seller_([0-9a-fA-F]{40})$/);
  return m ? `0x${m[1].toLowerCase()}` : null;
}

function reservedNameIndex() {
  if (reservedCache.index && Date.now() - reservedCache.at < 30_000) {
    return reservedCache.index;
  }
  const byKey = new Map();
  const byOwner = new Map();
  const onchain = db.prepare('SELECT agent_id, address FROM sellers_onchain').all();
  const onchainByAgent = new Map(
    onchain
      .filter((row) => AGENT_ID_RE.test(String(row.agent_id || '')) && ADDR_RE.test(String(row.address || '')))
      .map((row) => [String(row.agent_id), String(row.address).toLowerCase()])
  );
  const sellers = db.prepare(
    'SELECT id, name, agent_id FROM sellers WHERE agent_id IS NOT NULL'
  ).all();
  const rows = [];
  for (const seller of sellers) {
    const name = normalizeReservedName(seller.name);
    if (!name) continue;
    const agentId = String(seller.agent_id);
    if (!AGENT_ID_RE.test(agentId)) continue;
    const owner = onchainByAgent.get(agentId) || ownerWalletForSeller(seller);
    if (!owner) continue;
    rows.push({
      name,
      owner,
      agentId,
      key: nicknameKey(name),
    });
  }
  rows.sort((a, b) => Number(a.agentId) - Number(b.agentId));
  for (const rec of rows) {
    if (!byKey.has(rec.key)) byKey.set(rec.key, rec);
    if (!byOwner.has(rec.owner)) byOwner.set(rec.owner, []);
    byOwner.get(rec.owner).push(rec);
  }
  const index = { byKey, byOwner };
  reservedCache = { at: Date.now(), index };
  return index;
}

function reservedNicknameFor(address) {
  const addr = normalizeAddress(address);
  if (!addr) return null;
  const owned = reservedNameIndex().byOwner.get(addr) || [];
  return owned[0] || null;
}

function reservedClaimForKey(key) {
  if (!key) return null;
  return reservedNameIndex().byKey.get(key) || null;
}

function uniqueFallbackNickname(address) {
  const suffix = String(address || '').replace(/^0x/i, '').slice(0, 6).toLowerCase();
  const { byKey } = reservedNameIndex();
  let candidate = `user-${suffix}`;
  let n = 2;
  while (loadRowByKey(nicknameKey(candidate)) || byKey.has(nicknameKey(candidate))) {
    candidate = `user-${suffix}-${n}`;
    n += 1;
  }
  return candidate;
}

function reclaimNickname(key, ownerAddr) {
  const taken = loadRowByKey(key);
  if (!taken || taken.address === ownerAddr) return;
  const fallback = uniqueFallbackNickname(taken.address);
  db.prepare(
    `UPDATE user_profiles
     SET nickname = ?, nickname_key = ?, updated_at = ?
     WHERE address = ?`
  ).run(fallback, nicknameKey(fallback), Date.now(), taken.address);
}

function normalizeBio(raw) {
  if (raw == null) return '';
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\r\n/g, '\n').trim();
  if ([...text].length > BIO_MAX) return null;
  return text;
}

function parseAvatarDataUrl(dataUrl) {
  if (dataUrl == null || dataUrl === false || dataUrl === '') {
    return { clear: true };
  }
  if (typeof dataUrl !== 'string') return { error: 'avatar must be an image' };
  const m = dataUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) return { error: 'avatar must be a jpeg, png, or webp image' };
  const mime = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
  let buf;
  try {
    buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  } catch {
    return { error: 'avatar could not be decoded' };
  }
  if (!buf || buf.length < 24) return { error: 'avatar is empty' };
  if (buf.length > AVATAR_MAX_BYTES) return { error: 'avatar is too large' };
  if (mime === 'image/jpeg' && (buf[0] !== 0xff || buf[1] !== 0xd8)) {
    return { error: 'avatar is not a jpeg image' };
  }
  if (mime === 'image/png' && (buf[0] !== 0x89 || buf[1] !== 0x50)) {
    return { error: 'avatar is not a png image' };
  }
  return { mime, buf };
}

function verifySignedAction(message, signature, expectedAddress) {
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

function verifyProfileSave(message, signature, address) {
  const prefix = 'antseedmarkets profile: save @ ';
  if (typeof message !== 'string' || !message.startsWith(prefix)) return false;
  return verifySignedAction(message, signature, address);
}

function loadRow(address) {
  const addr = normalizeAddress(address);
  if (!addr) return null;
  return db.prepare('SELECT * FROM user_profiles WHERE address = ?').get(addr) || null;
}

function loadRowByKey(key) {
  if (!key) return null;
  return db.prepare('SELECT * FROM user_profiles WHERE nickname_key = ?').get(key) || null;
}

function avatarUrlFor(row) {
  if (!row?.avatar) return null;
  return `/api/profiles/${row.address}/avatar?t=${row.updated_at}`;
}

export function publicProfile(address) {
  const addr = normalizeAddress(address);
  if (!addr) return null;
  const reserved = reservedNicknameFor(addr);
  const row = loadRow(addr);
  if (reserved) {
    return {
      nickname: reserved.name,
      avatarUrl: avatarUrlFor(row),
    };
  }
  if (!row) return null;
  const claim = reservedClaimForKey(nicknameKey(row.nickname));
  if (claim && claim.owner !== addr) {
    if (!row.avatar) return null;
    return {
      nickname: null,
      avatarUrl: avatarUrlFor(row),
    };
  }
  return {
    nickname: row.nickname,
    avatarUrl: avatarUrlFor(row),
  };
}

function profileResponse(addr, row) {
  const reserved = reservedNicknameFor(addr);
  const base = row ? profileJson(row) : { exists: false, address: addr };
  if (reserved) {
    return {
      ...base,
      address: addr,
      nickname: reserved.name,
      reserved: true,
      nicknameLocked: true,
      reservedNickname: reserved.name,
      reservedAgentId: reserved.agentId,
    };
  }
  const claim = row ? reservedClaimForKey(nicknameKey(row.nickname)) : null;
  const blocked = Boolean(claim && claim.owner !== addr);
  return {
    ...base,
    address: addr,
    nickname: blocked ? null : (row ? row.nickname : undefined),
    reserved: false,
    nicknameLocked: false,
    reservedNickname: null,
    nicknameBlocked: blocked,
  };
}

export function profilesForAddresses(addresses) {
  const map = {};
  const seen = new Set();
  for (const raw of addresses || []) {
    const addr = normalizeAddress(raw);
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    const profile = publicProfile(addr);
    if (profile) map[addr] = profile;
  }
  return map;
}

export function attachAuthorProfiles(items) {
  const list = Array.isArray(items) ? items : [];
  const map = profilesForAddresses(list.map((item) => item?.author));
  return list.map((item) => {
    const profile = map[String(item?.author || '').toLowerCase()];
    return profile ? { ...item, profile } : item;
  });
}

function profileJson(row) {
  if (!row) return { exists: false };
  return {
    exists: true,
    address: row.address,
    nickname: row.nickname,
    bio: row.bio || '',
    hasAvatar: Boolean(row.avatar),
    avatarUrl: avatarUrlFor(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isActivationStake(amountWei) {
  if (amountWei == null) return false;
  const ants = Number(amountWei) / 1e18;
  return Number.isFinite(ants) && Math.abs(ants - 1) < 1e-6;
}

function catalogByAgentId(agentId) {
  const id = String(agentId || '');
  if (!AGENT_ID_RE.test(id)) return null;
  const seller = db.prepare(
    'SELECT id, name, agent_id, status FROM sellers WHERE agent_id = ?'
  ).get(id);
  if (!seller) return { agentId: id, name: null };
  return {
    agentId: String(seller.agent_id),
    name: seller.name || null,
    sellerId: seller.id,
    online: String(seller.status || '').toLowerCase() === 'online',
  };
}

function agentIdForPaymentAddress(addr) {
  const wallet = normalizeAddress(addr);
  if (!wallet) return null;
  const row = db.prepare(
    'SELECT agent_id FROM sellers_onchain WHERE lower(address) = ?'
  ).get(wallet);
  const id = row?.agent_id != null ? String(row.agent_id) : '';
  return AGENT_ID_RE.test(id) ? id : null;
}

function addUsed(map, agentId, how) {
  const id = String(agentId || '');
  if (!AGENT_ID_RE.test(id)) return;
  let rec = map.get(id);
  if (!rec) {
    const catalog = catalogByAgentId(id);
    rec = {
      agentId: id,
      name: catalog?.name || null,
      how: new Set(),
    };
    map.set(id, rec);
  }
  rec.how.add(how);
}

async function allPairsCached() {
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
          const value = isAddr(op) ? op : ZERO_ADDRESS;
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
        return [buyer, isAddr(op) ? op : ZERO_ADDRESS];
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

async function usedProvidersFor(address) {
  const addr = normalizeAddress(address);
  const map = new Map();
  if (!addr) return [];

  const commentRows = db.prepare(
    `SELECT DISTINCT s.agent_id AS agent_id
     FROM provider_comments pc
     JOIN sellers s ON s.id = pc.seller_id
     WHERE lower(pc.author) = ?`
  ).all(addr);
  for (const row of commentRows) addUsed(map, row.agent_id, 'commented');

  const stakeRows = db.prepare(
    `SELECT agent_id, amount FROM stake_positions
     WHERE lower(owner) = ? AND COALESCE(closed_at_epoch, 0) = 0`
  ).all(addr);
  for (const row of stakeRows) {
    if (row.amount == null || Number(row.amount) <= 0 || isActivationStake(row.amount)) continue;
    addUsed(map, row.agent_id, 'staker');
  }

  const noteBuyer = (sellerAddr) => {
    const agentId = agentIdForPaymentAddress(sellerAddr);
    if (agentId) addUsed(map, agentId, 'buyer');
  };

  try {
    const asBuyer = await fetchBuyerSellerPairsForBuyer(addr);
    for (const pair of asBuyer.items || []) noteBuyer(pair.seller);
  } catch {
    /* keep stake + comment rows if Antscan is down */
  }

  try {
    const pairs = await allPairsCached();
    const buyers = [];
    const seenBuyers = new Set();
    for (const pair of pairs) {
      const buyer = normalizeAddress(pair.buyer);
      if (!buyer || seenBuyers.has(buyer)) continue;
      seenBuyers.add(buyer);
      buyers.push(buyer);
    }
    const operators = await operatorsOfBuyers(buyers);
    for (const pair of pairs) {
      const buyer = normalizeAddress(pair.buyer);
      if (!buyer) continue;
      const op = operators.get(buyer);
      if (op === addr) noteBuyer(pair.seller);
    }
  } catch {
    /* operator reverse is best-effort */
  }

  const HOW_ORDER = ['buyer', 'staker', 'commented'];
  return [...map.values()]
    .map((rec) => ({
      agentId: rec.agentId,
      name: rec.name,
      how: HOW_ORDER.filter((h) => rec.how.has(h)),
    }))
    .sort((a, b) => {
      const an = String(a.name || '');
      const bn = String(b.name || '');
      if (an && bn && an !== bn) return an.localeCompare(bn);
      if (an && !bn) return -1;
      if (!an && bn) return 1;
      return Number(a.agentId) - Number(b.agentId);
    });
}

export function registerUserProfileRoutes(app) {
  app.get('/api/profiles/check-nickname', (req, res) => {
    const reservedName = normalizeReservedName(String(req.query.name || ''));
    const nickname = normalizeNickname(req.query.name) || reservedName;
    if (!nickname) {
      return res.json({ available: false, reason: 'invalid' });
    }
    const key = nicknameKey(nickname);
    const self = normalizeAddress(req.query.address);
    const reserved = reservedClaimForKey(key);
    if (reserved && reserved.owner !== self) {
      return res.json({ available: false, reason: 'reserved', nickname: reserved.name });
    }
    const existing = loadRowByKey(key);
    if (existing && existing.address !== self && reserved?.owner !== self) {
      return res.json({ available: false, reason: 'taken', nickname });
    }
    return res.json({ available: true, nickname });
  });

  app.get('/api/profiles/:address/avatar', (req, res) => {
    const row = loadRow(req.params.address);
    if (!row?.avatar) return jsonError(res, 404, 'no avatar');
    res.set('content-type', row.avatar_mime || 'image/jpeg');
    res.set('cache-control', 'public, max-age=3600');
    return res.send(row.avatar);
  });

  app.get('/api/profiles/:address/providers', async (req, res) => {
    const addr = normalizeAddress(req.params.address);
    if (!addr) return jsonError(res, 400, 'address required');
    try {
      const items = await usedProvidersFor(addr);
      res.json({ address: addr, items });
    } catch (e) {
      return jsonError(res, 503, e?.message || 'could not load used providers');
    }
  });

  app.get('/api/profiles/:address', (req, res) => {
    const addr = normalizeAddress(req.params.address);
    if (!addr) return jsonError(res, 400, 'address required');
    return res.json(profileResponse(addr, loadRow(addr)));
  });

  app.get('/api/profiles', (req, res) => {
    const raw = String(req.query.addresses || '');
    const addresses = raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
    if (addresses.length === 0) return jsonError(res, 400, 'addresses required');
    res.json({ items: profilesForAddresses(addresses) });
  });

  app.post('/api/profiles', (req, res) => {
    const body = req.body || {};
    const addr = normalizeAddress(body.address);
    if (!addr) return jsonError(res, 400, 'address required');
    if (!verifyProfileSave(body.message, body.signature, addr)) {
      return jsonError(res, 401, 'signature does not match this wallet');
    }

    const existing = loadRow(addr);
    const reserved = reservedNicknameFor(addr);
    let nickname;
    if (reserved) {
      nickname = reserved.name;
    } else if (body.nickname == null || body.nickname === '') {
      if (!existing) return jsonError(res, 400, 'nickname required');
      nickname = existing.nickname;
    } else {
      nickname = normalizeNickname(body.nickname);
      if (!nickname) {
        return jsonError(res, 400, `nickname must be ${NICK_MIN} to ${NICK_MAX} characters and cannot be a wallet address`);
      }
    }

    const bio = body.bio === undefined && existing ? (existing.bio || '') : normalizeBio(body.bio);
    if (bio == null) return jsonError(res, 400, `bio is too long (max ${BIO_MAX})`);

    let avatar = existing?.avatar ?? null;
    let avatarMime = existing?.avatar_mime ?? null;
    if (body.clearAvatar === true || body.avatarDataUrl === null) {
      avatar = null;
      avatarMime = null;
    } else if (typeof body.avatarDataUrl === 'string' && body.avatarDataUrl) {
      const parsed = parseAvatarDataUrl(body.avatarDataUrl);
      if (parsed.error) return jsonError(res, 400, parsed.error);
      if (parsed.buf) {
        avatar = parsed.buf;
        avatarMime = parsed.mime;
      }
    }

    const key = nicknameKey(nickname);
    if (!reserved && reservedClaimForKey(key)) {
      return jsonError(res, 409, 'that name is reserved for a provider');
    }

    const now = Date.now();
    try {
      const write = db.transaction(() => {
        if (reserved) reclaimNickname(key, addr);
        const taken = loadRowByKey(key);
        if (taken && taken.address !== addr) {
          const err = new Error('that nickname is already taken');
          err.code = 'NICK_TAKEN';
          throw err;
        }
        if (existing) {
          db.prepare(`
            UPDATE user_profiles
            SET nickname = ?, nickname_key = ?, bio = ?, avatar = ?, avatar_mime = ?, updated_at = ?
            WHERE address = ?
          `).run(nickname, key, bio, avatar, avatarMime, now, addr);
        } else {
          db.prepare(`
            INSERT INTO user_profiles
              (address, nickname, nickname_key, bio, avatar, avatar_mime, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(addr, nickname, key, bio, avatar, avatarMime, now, now);
        }
      });
      write();
    } catch (e) {
      const msg = String(e?.message || '');
      if (e?.code === 'NICK_TAKEN' || msg.includes('UNIQUE') || msg.includes('unique') || msg.includes('already taken')) {
        return jsonError(res, 409, 'that nickname is already taken');
      }
      throw e;
    }

    return res.json(profileResponse(addr, loadRow(addr)));
  });
}
