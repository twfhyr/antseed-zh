import db from './database.js';

const PROXY_BASE = 'http://localhost:8377';

export async function syncModelsFromProxy() {
  try {
    // Wipe old mock services and sellers so the dashboard reflects reality
    db.prepare('DELETE FROM services').run();
    db.prepare('DELETE FROM sellers').run();

    const res = await fetch(`${PROXY_BASE}/v1/models`);
    if (!res.ok) {
      console.error('Proxy models endpoint failed:', res.status, res.statusText);
      return;
    }
    const data = await res.json();
    const models = data.data || [];

    // Derive provider from model id prefix
    function guessProvider(modelId) {
      const id = modelId.toLowerCase();
      if (id.includes('kimi')) return 'moonshotai';
      if (id.includes('deepseek')) return 'deepseek';
      if (id.includes('gemini') || id.includes('google')) return 'google';
      if (id.includes('glm')) return 'zhipu';
      if (id.includes('qwen')) return 'alibaba';
      if (id.includes('minimax')) return 'minimax';
      if (id.includes('claude')) return 'anthropic';
      if (id.includes('gpt') || id.includes('o1') || id.includes('o3')) return 'openai';
      if (id.includes('llama') || id.includes('meta')) return 'meta';
      return 'antseed';
    }

    // Try to get real pricing for one model via a tiny completion
    let realPricing = null;
    try {
      const testRes = await fetch(`${PROXY_BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: models[0]?.id,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
      });
      if (testRes.ok) {
        const testData = await testRes.json();
        const cost = testData.usage?.estimated_cost;
        if (cost && testData.usage?.prompt_tokens && testData.usage?.completion_tokens) {
          // estimated_cost from proxy already reflects total cost for the tokens used
          // convert to "per 1M tokens" estimate using ratio (rough)
          const promptRatio = testData.usage.prompt_tokens;
          const completionRatio = testData.usage.completion_tokens;
          const totalTokens = promptRatio + completionRatio;
          const costPerToken = cost / totalTokens;
          realPricing = {
            inputUsdPerMillion: Math.round(costPerToken * 1_000_000 * 10) / 10,
            cachedInputUsdPerMillion: 0,
            outputUsdPerMillion: Math.round(costPerToken * 1_000_000 * 10) / 10,
          };
        }
      }
    } catch (e) {
      console.warn('Could not fetch live pricing:', e.message);
    }

    const insertService = db.prepare(`
      INSERT INTO services (id, name, provider, seller_id, seller_name, categories, protocols, pricing_input, pricing_cached_input, pricing_output, max_concurrency, current_load, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        provider = excluded.provider,
        pricing_input = excluded.pricing_input,
        pricing_cached_input = excluded.pricing_cached_input,
        pricing_output = excluded.pricing_output,
        status = excluded.status
    `);

    const insertSeller = db.prepare(`
      INSERT INTO sellers (id, name, status, total_earned, capacity, uptime, models, joined)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        models = excluded.models
    `);

    let sellersMap = {};
    let sellerIdx = 1;

    db.prepare('BEGIN TRANSACTION').run();

    try {
      for (const m of models) {
        const modelId = m.id;
        const provider = guessProvider(modelId);
        const svcId = `svc_${modelId.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 32)}`;

        // Derive a synthetic seller per provider
        const sellerId = `seller_${provider}`;
        if (!sellersMap[sellerId]) {
          sellersMap[sellerId] = {
            id: sellerId,
            name: `${provider.charAt(0).toUpperCase() + provider.slice(1)} Node`,
            status: 'online',
            totalEarned: 0,
            capacity: 'Shared / Elastic',
            uptime: 99.5,
            models: 0,
            joined: new Date().toISOString().split('T')[0],
          };
        }
        sellersMap[sellerId].models += 1;

        const pricing = realPricing || {
          inputUsdPerMillion: 0,
          cachedInputUsdPerMillion: 0,
          outputUsdPerMillion: 0,
        };

        // Estimate category tags from model name
        const categories = [];
        const lowerName = modelId.toLowerCase();
        if (lowerName.includes('coder') || lowerName.includes('code')) categories.push('coding');
        if (lowerName.includes('flash') || lowerName.includes('mini')) categories.push('speed');
        if (categories.length === 0) categories.push('general');

        insertService.run(
          svcId,
          modelId,
          provider,
          sellerId,
          sellersMap[sellerId].name,
          JSON.stringify(categories),
          JSON.stringify(['openai-compatible']),
          pricing.inputUsdPerMillion,
          pricing.cachedInputUsdPerMillion,
          pricing.outputUsdPerMillion,
          10,   // maxConcurrency placeholder
          0,    // currentLoad placeholder
          'online'
        );
      }

      // Upsert sellers
      for (const s of Object.values(sellersMap)) {
        insertSeller.run(
          s.id, s.name, s.status, s.totalEarned, s.capacity, s.uptime,
          s.models, s.joined
        );
      }

      // Update stats to reflect real model count
      const svcCount = db.prepare('SELECT COUNT(*) as c FROM services').get().c;
      const sellerCount = Object.keys(sellersMap).length;
      db.prepare(`
        UPDATE stats SET
          total_services = ?,
          total_sellers = ?
        WHERE id = 1
      `).run(svcCount, sellerCount);

      db.prepare('COMMIT').run();
      console.log(`Synced ${models.length} real models from AntSeed proxy.`);
    } catch (e) {
      db.prepare('ROLLBACK').run();
      throw e;
    }
  } catch (e) {
    console.error('Failed to sync models from proxy:', e);
  }
}

export function getProxyStatus() {
  return { url: PROXY_BASE, reachable: null };
}
