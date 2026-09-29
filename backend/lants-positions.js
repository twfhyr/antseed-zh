// Local cache of lANTS position metadata (owner, agent, amount, lock epochs)
// so the market page can page/filter/sort with plain SQL instead of an
// on-chain (or antscan) read on every request. Refreshed by
// computeLantsMarket() in server.js each time it runs; this file is just
// the storage + query layer.
import db from './database.js';

const upsertStmt = db.prepare(`
  INSERT INTO lants_positions (id, owner, agent_id, amount, weight_amount, stake_start_epoch, stake_end_epoch, closed_at_epoch, withdrawn, synced_at)
  VALUES (@id, @owner, @agentId, @amount, @weightAmount, @stakeStartEpoch, @stakeEndEpoch, @closedAtEpoch, @withdrawn, @syncedAt)
  ON CONFLICT(id) DO UPDATE SET
    owner = excluded.owner,
    agent_id = excluded.agent_id,
    amount = excluded.amount,
    weight_amount = excluded.weight_amount,
    stake_start_epoch = excluded.stake_start_epoch,
    stake_end_epoch = excluded.stake_end_epoch,
    closed_at_epoch = excluded.closed_at_epoch,
    withdrawn = excluded.withdrawn,
    synced_at = excluded.synced_at
`);

export function upsertPositions(rows) {
  const tx = db.transaction((items) => {
    for (const p of items) {
      upsertStmt.run({
        id: Number(p.id),
        owner: p.owner ? String(p.owner).toLowerCase() : null,
        agentId: p.agentId != null ? Number(p.agentId) : null,
        amount: p.amount != null ? Number(p.amount) : null,
        weightAmount: p.weightAmount != null ? Number(p.weightAmount) : null,
        stakeStartEpoch: p.stakeStartEpoch != null ? Number(p.stakeStartEpoch) : null,
        stakeEndEpoch: p.stakeEndEpoch != null ? Number(p.stakeEndEpoch) : null,
        closedAtEpoch: p.closedAtEpoch != null ? Number(p.closedAtEpoch) : 0,
        withdrawn: p.withdrawn ? 1 : 0,
        syncedAt: Date.now(),
      });
    }
  });
  tx(rows);
}

const SORT_COLUMNS = {
  id: 'id',
  amount: 'amount',
  stakeStartEpoch: 'stake_start_epoch',
  stakeEndEpoch: 'stake_end_epoch',
};

/**
 * Page/filter/sort cached positions. Filters are all optional; omitted ones
 * are not applied. Returns { rows, total } -- rows are raw DB shape (see
 * rowToPosition to convert).
 */
export function queryPositions({
  page = 1,
  pageSize = 10,
  sort = 'id',
  dir = 'asc',
  owner = null,
  agentId = null,
  minAmount = null,
  maxAmount = null,
  minStartEpoch = null,
  maxEndEpoch = null,
  excludeWithdrawn = true,
} = {}) {
  const where = [];
  const params = {};
  if (excludeWithdrawn) where.push('withdrawn = 0');
  if (owner) { where.push('owner = @owner'); params.owner = String(owner).toLowerCase(); }
  if (agentId != null) { where.push('agent_id = @agentId'); params.agentId = Number(agentId); }
  if (minAmount != null) { where.push('amount >= @minAmount'); params.minAmount = Number(minAmount); }
  if (maxAmount != null) { where.push('amount <= @maxAmount'); params.maxAmount = Number(maxAmount); }
  if (minStartEpoch != null) { where.push('stake_start_epoch >= @minStartEpoch'); params.minStartEpoch = Number(minStartEpoch); }
  if (maxEndEpoch != null) { where.push('stake_end_epoch <= @maxEndEpoch'); params.maxEndEpoch = Number(maxEndEpoch); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortCol = SORT_COLUMNS[sort] || 'id';
  const sortDir = dir === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.max(1, Math.min(100, Number(pageSize) || 10));
  const offset = Math.max(0, (Math.max(1, Number(page) || 1) - 1) * limit);

  const total = db.prepare(`SELECT COUNT(*) AS c FROM lants_positions ${whereSql}`).get(params).c;
  const rows = db.prepare(`
    SELECT * FROM lants_positions ${whereSql}
    ORDER BY ${sortCol} ${sortDir}
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset });

  return { rows: rows.map(rowToPosition), total };
}

export function rowToPosition(row) {
  return {
    id: row.id,
    owner: row.owner,
    agentId: row.agent_id,
    amount: row.amount,
    weightAmount: row.weight_amount,
    stakeStartEpoch: row.stake_start_epoch,
    stakeEndEpoch: row.stake_end_epoch,
    closedAtEpoch: row.closed_at_epoch,
    withdrawn: !!row.withdrawn,
  };
}

export function distinctAgentIds() {
  return db.prepare('SELECT DISTINCT agent_id AS agentId FROM lants_positions WHERE withdrawn = 0 AND agent_id IS NOT NULL ORDER BY agent_id').all().map((r) => r.agentId);
}

/**
 * Every non-withdrawn position id this backend has ever confirmed on-chain,
 * regardless of whether Antscan/OpenSea currently know about it. See
 * computeLantsMarket()'s use of this in server.js for why: a freshly
 * split/staked position gets upserted here via an explicit ensureIds read,
 * but Antscan can lag far longer than this cache's 90s TTL, so without this
 * the position drops out of the *global* market recompute (not just one
 * user's "Mine" view) the very next time anything else triggers a refresh
 * without re-listing that exact id in ensureIds -- reported live as a split
 * position "disappearing" from Mine right after listing its sibling.
 */
export function knownPositionIds() {
  return db.prepare('SELECT id FROM lants_positions WHERE withdrawn = 0').all().map((r) => r.id);
}

const markWithdrawnStmt = db.prepare('UPDATE lants_positions SET withdrawn = 1, synced_at = @syncedAt WHERE id = @id');
/**
 * A confirmed-on-chain-gone id (split/merged/moved/withdrawn) needs to stop
 * coming back from knownPositionIds(), or computeLantsMarket() re-forces an
 * on-chain read for it forever -- every id this cache has ever known about
 * that's since closed, on every single recompute.
 */
export function markWithdrawn(ids) {
  const list = ids.filter((id) => Number.isFinite(id));
  if (!list.length) return;
  const tx = db.transaction((items) => {
    for (const id of items) markWithdrawnStmt.run({ id, syncedAt: Date.now() });
  });
  tx(list);
}
