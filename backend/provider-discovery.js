// Discovery directory for antseedmarkets. Owners pitch their provider;
// buyers and stakers vote. Ten votes highlights the provider in the
// passive Providers catalog. Writes are signed
// `antseedmarkets discovery: submit <agentId> @ <ts>` and
// `antseedmarkets discovery: vote <listingId> <role> @ <ts>`.

import db from './database.js';
import { attachAuthorProfiles, publicProfile } from './user-profiles.js';
import {
  loadSellerByAgentId,
  resolveProviderWallet,
  isOwnerAddress,
  displayIdentity,
  verifySignedAction,
  networkVoterRoles,
  ownedProvidersFor,
} from './provider-social.js';

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const AGENT_ID_RE = /^\d+$/;
const PITCH_MIN = 20;
const PITCH_MAX = 1000;
const VOTE_ROLES = ['buyer', 'staker'];
export const DISCOVERY_THRESHOLD = 10;

function jsonError(res, status, error) {
  return res.status(status).json({ error });
}

function normalizeAddress(value) {
  const addr = String(value || '').toLowerCase();
  return ADDR_RE.test(addr) ? addr : null;
}

function normalizePitch(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\r\n/g, '\n').trim();
  const n = [...text].length;
  if (n < PITCH_MIN || n > PITCH_MAX) return null;
  return text;
}

function verifyDiscoveryAction(message, signature, address, action) {
  const prefix = `antseedmarkets discovery: ${action} @ `;
  if (typeof message !== 'string' || !message.startsWith(prefix)) return false;
  return verifySignedAction(message, signature, address);
}

function servicesForSeller(sellerId) {
  const rows = db.prepare(
    `SELECT name, status, pricing_input, pricing_cached_input, pricing_output
     FROM services WHERE seller_id = ? ORDER BY name COLLATE NOCASE`
  ).all(sellerId);
  return rows.map((row) => ({
    name: row.name,
    status: row.status,
    pricing: {
      inputUsdPerMillion: row.pricing_input,
      cachedInputUsdPerMillion: row.pricing_cached_input,
      outputUsdPerMillion: row.pricing_output,
    },
  }));
}

function voteCounts(listingId) {
  const rows = db.prepare(
    'SELECT role, COUNT(*) AS n FROM discovery_votes WHERE listing_id = ? GROUP BY role'
  ).all(listingId);
  const buyer = Number(rows.find((r) => r.role === 'buyer')?.n) || 0;
  const staker = Number(rows.find((r) => r.role === 'staker')?.n) || 0;
  return { buyer, staker, total: buyer + staker };
}

function myVotesFor(listingId, voter) {
  if (!voter) return [];
  return db.prepare(
    'SELECT role FROM discovery_votes WHERE listing_id = ? AND voter = ?'
  ).all(listingId, voter).map((r) => r.role);
}

function listingJson(row, voter) {
  const seller = db.prepare('SELECT * FROM sellers WHERE id = ?').get(row.seller_id);
  const votes = voteCounts(row.id);
  const item = {
    id: row.id,
    agentId: String(row.agent_id),
    sellerId: row.seller_id,
    name: seller?.name || null,
    online: String(seller?.status || '').toLowerCase() === 'online',
    models: seller?.models ?? null,
    pitch: row.pitch,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    votes,
    featured: votes.total >= DISCOVERY_THRESHOLD,
    services: servicesForSeller(row.seller_id),
    myVotes: myVotesFor(row.id, voter),
  };
  const profile = publicProfile(row.author);
  if (profile) item.profile = profile;
  return item;
}

export function featuredAgentIds() {
  const rows = db.prepare(`
    SELECT l.agent_id AS agent_id
    FROM discovery_listings l
    JOIN discovery_votes v ON v.listing_id = l.id
    GROUP BY l.id
    HAVING COUNT(*) >= ?
  `).all(DISCOVERY_THRESHOLD);
  return rows.map((r) => String(r.agent_id));
}

export function registerProviderDiscoveryRoutes(app) {
  app.get('/api/discovery/featured', (_req, res) => {
    res.json({ threshold: DISCOVERY_THRESHOLD, agentIds: featuredAgentIds() });
  });

  app.get('/api/discovery/access', async (req, res) => {
    const addr = normalizeAddress(req.query.address);
    if (!addr) return jsonError(res, 400, 'address required');
    let roles;
    try {
      roles = await networkVoterRoles(addr);
    } catch (e) {
      return jsonError(res, 503, e?.message || "couldn't check this wallet's roles");
    }
    const owned = ownedProvidersFor(addr);
    const listed = new Map(
      db.prepare('SELECT agent_id, id FROM discovery_listings').all()
        .map((r) => [String(r.agent_id), r.id])
    );
    res.json({
      address: addr,
      identity: roles.identity,
      isBuyer: roles.buyer,
      isStaker: roles.staker,
      profile: publicProfile(roles.identity),
      owned: owned.map((p) => ({
        ...p,
        listingId: listed.get(p.agentId) || null,
        services: servicesForSeller(p.sellerId),
      })),
    });
  });

  app.get('/api/discovery', async (req, res) => {
    const addr = normalizeAddress(req.query.address);
    let voter = null;
    if (addr) {
      try {
        voter = (await displayIdentity(addr));
      } catch {
        voter = addr;
      }
    }
    const rows = db.prepare(
      'SELECT * FROM discovery_listings ORDER BY updated_at DESC'
    ).all();
    const items = attachAuthorProfiles(rows.map((row) => listingJson(row, voter)));
    items.sort((a, b) => {
      if (a.featured !== b.featured) return a.featured ? -1 : 1;
      if (b.votes.total !== a.votes.total) return b.votes.total - a.votes.total;
      return b.updatedAt - a.updatedAt;
    });
    res.json({ threshold: DISCOVERY_THRESHOLD, items });
  });

  app.post('/api/discovery', async (req, res) => {
    const body = req.body || {};
    const addr = normalizeAddress(body.address);
    if (!addr) return jsonError(res, 400, 'address required');
    const agentId = String(body.agentId || '');
    if (!AGENT_ID_RE.test(agentId)) return jsonError(res, 400, 'agentId required');
    const pitch = normalizePitch(body.pitch);
    if (!pitch) {
      return jsonError(res, 400, `pitch must be ${PITCH_MIN} to ${PITCH_MAX} characters`);
    }
    if (!verifyDiscoveryAction(body.message, body.signature, addr, `submit ${agentId}`)) {
      return jsonError(res, 401, 'signature does not match this wallet');
    }
    const seller = loadSellerByAgentId(agentId);
    if (!seller) return jsonError(res, 404, 'provider not found');
    const identity = await displayIdentity(addr);
    if (!isOwnerAddress(seller, addr) && !isOwnerAddress(seller, identity)) {
      return jsonError(res, 403, 'only this provider can submit a Discovery pitch');
    }
    const now = Date.now();
    const existing = db.prepare(
      'SELECT * FROM discovery_listings WHERE agent_id = ?'
    ).get(agentId);
    const author = resolveProviderWallet(seller) || identity;
    let id;
    if (existing) {
      db.prepare(
        'UPDATE discovery_listings SET pitch = ?, author = ?, updated_at = ? WHERE id = ?'
      ).run(pitch, author, now, existing.id);
      id = existing.id;
    } else {
      const result = db.prepare(
        `INSERT INTO discovery_listings (seller_id, agent_id, author, pitch, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(seller.id, agentId, author, pitch, now, now);
      id = result.lastInsertRowid;
    }
    const row = db.prepare('SELECT * FROM discovery_listings WHERE id = ?').get(id);
    res.status(existing ? 200 : 201).json(listingJson(row, identity));
  });

  app.post('/api/discovery/:id/vote', async (req, res) => {
    const listingId = Number(req.params.id);
    if (!Number.isInteger(listingId) || listingId <= 0) {
      return jsonError(res, 400, 'listing id required');
    }
    const listing = db.prepare('SELECT * FROM discovery_listings WHERE id = ?').get(listingId);
    if (!listing) return jsonError(res, 404, 'listing not found');
    const body = req.body || {};
    const addr = normalizeAddress(body.address);
    if (!addr) return jsonError(res, 400, 'address required');
    const role = String(body.role || '');
    if (!VOTE_ROLES.includes(role)) {
      return jsonError(res, 400, 'role must be buyer or staker');
    }
    if (!verifyDiscoveryAction(body.message, body.signature, addr, `vote ${listingId} ${role}`)) {
      return jsonError(res, 401, 'signature does not match this wallet');
    }
    let roles;
    try {
      roles = await networkVoterRoles(addr);
    } catch (e) {
      return jsonError(res, 503, e?.message || "couldn't check this wallet's roles");
    }
    if (role === 'buyer' && !roles.buyer) {
      return jsonError(res, 403, 'only buyers can cast the buyer vote');
    }
    if (role === 'staker' && !roles.staker) {
      return jsonError(res, 403, 'only stakers can cast the staker vote');
    }
    const voter = roles.identity;
    const author = String(listing.author || '').toLowerCase();
    if (voter === author || addr === author) {
      return jsonError(res, 403, 'this provider cannot vote on its own pitch');
    }
    const already = db.prepare(
      'SELECT 1 FROM discovery_votes WHERE listing_id = ? AND voter = ? AND role = ?'
    ).get(listingId, voter, role);
    if (already) {
      return jsonError(res, 409, 'this wallet already used its vote as ' + role);
    }
    db.prepare(
      'INSERT INTO discovery_votes (listing_id, voter, role, created_at) VALUES (?, ?, ?, ?)'
    ).run(listingId, voter, role, Date.now());
    const row = db.prepare('SELECT * FROM discovery_listings WHERE id = ?').get(listingId);
    res.json(listingJson(row, voter));
  });
}
