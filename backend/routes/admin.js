import { asyncHandler } from '../lib/async.js';

export function registerAdminRoutes(app, { requireAdminAccess, updateChainMetrics, syncFromOfficialNetwork }) {
  app.post('/api/admin/force-chain-sync', requireAdminAccess, asyncHandler(async (_req, res) => {
    const data = await updateChainMetrics();
    res.json({ success: true, data });
  }));

  app.post('/api/admin/sync', requireAdminAccess, asyncHandler(async (_req, res) => {
    await syncFromOfficialNetwork();
    res.json({ success: true, message: 'Synced from official network' });
  }));
}
