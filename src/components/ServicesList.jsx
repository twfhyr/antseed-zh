import React, { useEffect, useMemo, useState } from 'react';
import { Search, Tag, Zap, ArrowRight, HelpCircle, Trophy, X } from 'lucide-react';
import { useI18n } from '../i18n/index.jsx';
// Taxonomy (company → family filter chips) is still local: it is a purely
// presentational grouping with no protocol meaning. Model *identity*, by
// contrast, comes from the protocol SDK via the API (`canonicalKey` /
// `displayName` on each service row, computed server-side with
// @antseed/node's `canonicalModelKey`) — see backend/server.js parseService().
import { buildModelTaxonomy, classifyModel } from '../lib/modelTaxonomy.js';
import { fetchReferencePrices } from '../api';

// Two views over the same `services` data (one row per seller x model,
// fetched once in App.jsx via fetchServices()) rather than two separate
// pages — see notes/dev-plan.md. 'listings' is the original flat catalog;
// 'byModel' groups the same rows by model name and keeps only the 5
// cheapest sellers per model. No new backend endpoint, no new numbers —
// this is purely a different sort/group of data already on screen.
const VIEW_LISTINGS = 'listings';
const VIEW_BY_MODEL = 'byModel';

// "Cheaper" needs a single sortable number, but input and output prices are
// two different figures. Rank by a 3:1 output:input-weighted blended price
// per 1M tokens (a typical chat response has far more output than input
// tokens) rather than inventing a fixed synthetic "average request" cost.
// This is a ranking heuristic only — the table always shows the real,
// unblended input/output prices, never the blended value.
const OUTPUT_WEIGHT = 3;
const INPUT_WEIGHT = 1;

function blendedPrice(svc) {
  const input = Number(svc.pricing?.inputUsdPerMillion);
  const output = Number(svc.pricing?.outputUsdPerMillion);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return (input * INPUT_WEIGHT + output * OUTPUT_WEIGHT) / (INPUT_WEIGHT + OUTPUT_WEIGHT);
}

const rankColors = ['#facc15', '#c0c0c0', '#cd7f32', '#9ca3af', '#9ca3af'];

/**
 * Seller price vs the OpenRouter list price for the same model, as a percent.
 * Negative = cheaper than the reference, positive = more expensive.
 *
 * Compared on the same 3:1 output-weighted blend used for ranking, so input
 * and output are weighted identically on both sides — comparing a seller's
 * input price against a reference output price would be meaningless.
 *
 * Returns null (rendered `—`) whenever an honest number isn't available:
 * no reference for this model, or a non-positive reference we can't divide
 * by. Both directions are reported as-is: some sellers really are more
 * expensive than the list price, and hiding that would misrepresent the
 * network.
 */
function referenceDelta(svc, reference) {
  if (!reference) return null;
  const refBlended = (Number(reference.inputUsdPerMillion) * INPUT_WEIGHT
    + Number(reference.outputUsdPerMillion) * OUTPUT_WEIGHT) / (INPUT_WEIGHT + OUTPUT_WEIGHT);
  const sellerBlended = blendedPrice(svc);
  if (!Number.isFinite(refBlended) || refBlended <= 0) return null;
  if (sellerBlended === null) return null;
  return (sellerBlended / refBlended - 1) * 100;
}

function ServicesList({ services }) {
  const { t } = useI18n();
  // Default to the grouped cheapest-first view: "which seller is cheapest for
  // the model I want" is the question this page exists to answer. The flat
  // 900-row catalog stays one click away for browsing the whole network.
  const [view, setView] = useState(VIEW_BY_MODEL);
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('all');
  const [showLoadTip, setShowLoadTip] = useState(false);
  // Two-level filter for the byModel view: pick a company (OpenAI), then
  // optionally narrow to one family (GPT-5.6). ~400 raw model names are far
  // too many to scan as a flat list.
  const [filterCompany, setFilterCompany] = useState('all');
  const [filterFamily, setFilterFamily] = useState('all');
  // Reference (OpenRouter list) prices, keyed by canonical model identity so
  // they line up with the merged model groups. Never blocks render: until it
  // arrives — or if it fails — the comparison column just shows `—`.
  const [referenceByKey, setReferenceByKey] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchReferencePrices()
      .then(payload => {
        if (cancelled) return;
        const index = new Map();
        for (const entry of Object.values(payload?.models ?? {})) {
          // Key is computed server-side by the protocol's canonicalModelKey.
          const key = entry.canonicalKey;
          if (!key) continue;
          // First match wins; the upstream list is already de-duped per id.
          if (!index.has(key)) index.set(key, entry);
        }
        setReferenceByKey(index);
      })
      .catch(() => { if (!cancelled) setReferenceByKey(new Map()); });
    return () => { cancelled = true; };
  }, []);

  // The .filter() used to be applied to the whole array *including* the
  // leading 'all', which stripped it again — so the "All" button never
  // rendered and there was no way to clear a category filter short of
  // reloading the page. Filter the network-supplied categories only.
  const categories = [
    'all',
    ...Array.from(new Set(services.flatMap(s => s.categories ?? []))).filter(c => c && c !== 'all'),
  ];

  const filtered = services.filter(s => {
    const matchesSearch =
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.provider.toLowerCase().includes(search.toLowerCase()) ||
      s.sellerName.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = filterCategory === 'all' || s.categories.includes(filterCategory);
    return matchesSearch && matchesCategory;
  });

  // Grouped-by-model view: same `services` array, grouped by model name and
  // ranked cheapest-first, capped at the 5 cheapest sellers per model.
  const modelGroups = useMemo(() => {
    // Group by canonical identity, not by raw name: sellers spell the same
    // model differently (`claude-opus-4-8` vs `claude-opus-4.8`), and
    // grouping on the raw string would split one model into several rows —
    // each showing the cheapest seller among only the sellers who used that
    // exact spelling, which is a wrong answer, not just an untidy one.
    const byModel = new Map();
    for (const svc of services) {
      const price = blendedPrice(svc);
      if (price === null) continue; // never rank a service with no real price data
      // Server-provided (protocol canonicalModelKey). Fall back to the raw
      // advertised name rather than dropping the row, so a service is never
      // silently missing from the comparison.
      const key = svc.canonicalKey || svc.name;
      if (!byModel.has(key)) byModel.set(key, []);
      byModel.get(key).push({ ...svc, _blendedPrice: price });
    }
    const groups = [];
    for (const [key, rows] of byModel.entries()) {
      rows.sort((a, b) => a._blendedPrice - b._blendedPrice);
      // One seller can list the same model under several aliases (e.g. both
      // `gpt-56-sol` and `openai-gpt-56-sol`). Keep only its cheapest entry
      // so a single seller can't occupy multiple slots in a top-5 of sellers.
      const seen = new Set();
      const providers = [];
      for (const r of rows) {
        const id = r.peerId || r.sellerName;
        if (seen.has(id)) continue;
        seen.add(id);
        providers.push(r);
        if (providers.length === 5) break;
      }
      groups.push({
        key,
        // Display name = the most vendor-like spelling actually in use; the
        // per-provider spellings stay visible in their own column.
        // Protocol-preferred human label ("Claude Opus 4.8"), from
        // preferredModelDisplayName. All rows in a group share a canonical
        // key, so any row's displayName is the same label.
        name: rows[0].displayName || rows[0].name,
        aliasCount: new Set(rows.map(r => r.name)).size,
        sellerCount: seen.size,
        providers,
        reference: referenceByKey?.get(key) ?? null,
      });
    }
    groups.sort((a, b) => b.sellerCount - a.sellerCount || a.name.localeCompare(b.name));
    return groups;
  }, [services, referenceByKey]);

  // Company -> family tree, derived from the models actually listed on the
  // network right now (never a hardcoded catalog, so a brand only appears
  // once some seller offers it).
  const taxonomy = useMemo(
    () => buildModelTaxonomy(modelGroups.map(g => g.name)),
    [modelGroups]
  );

  const activeCompany = taxonomy.find(c => c.id === filterCompany) || null;

  const filteredModelGroups = useMemo(() => {
    const q = search.toLowerCase();
    return modelGroups.filter(g => {
      // Match the canonical label OR any seller's own spelling — someone who
      // searches `claude-opus-4-8` must still find the `claude-opus-4.8` row.
      if (q && !g.name.toLowerCase().includes(q)
            && !g.providers.some(p => p.name.toLowerCase().includes(q))) return false;
      if (filterCompany === 'all') return true;
      const { companyId, family } = classifyModel(g.name);
      if (companyId !== filterCompany) return false;
      return filterFamily === 'all' || family === filterFamily;
    });
  }, [modelGroups, search, filterCompany, filterFamily]);

  // Changing company invalidates any family chosen under the previous one.
  const selectCompany = (id) => {
    setFilterCompany(id);
    setFilterFamily('all');
  };

  const categoryColors = {
    privacy:    { bg: 'rgba(139,92,246,0.15)', color: '#8b5cf6' },
    legal:      { bg: 'rgba(59,130,246,0.15)',  color: '#3b82f6' },
    uncensored: { bg: 'rgba(239,68,68,0.15)',   color: '#ef4444' },
    coding:     { bg: 'rgba(16,185,129,0.15)',  color: '#10b981' },
    finance:    { bg: 'rgba(245,158,11,0.15)',  color: '#f59e0b' },
    tee:        { bg: 'rgba(236,72,153,0.15)',  color: '#ec4899' },
    general:    { bg: 'rgba(107,114,128,0.15)', color: '#9ca3af' },
    anon:       { bg: 'rgba(139,92,246,0.15)',  color: '#8b5cf6' },
    chat:       { bg: 'rgba(59,130,246,0.15)',  color: '#3b82f6' },
    fast:       { bg: 'rgba(245,158,11,0.15)',  color: '#f59e0b' },
    reasoning:  { bg: 'rgba(6,182,212,0.15)',   color: '#06b6d4' },
    vision:     { bg: 'rgba(236,72,153,0.15)',  color: '#ec4899' },
    multimodal: { bg: 'rgba(139,92,246,0.15)',  color: '#8b5cf6' },
    cheap:      { bg: 'rgba(16,185,129,0.15)',  color: '#10b981' },
    premium:    { bg: 'rgba(250,204,21,0.15)',  color: '#facc15' },
    code:       { bg: 'rgba(16,185,129,0.15)',  color: '#10b981' },
    math:       { bg: 'rgba(59,130,246,0.15)',  color: '#3b82f6' },
    writing:    { bg: 'rgba(245,158,11,0.15)',  color: '#f59e0b' },
    tasks:      { bg: 'rgba(107,114,128,0.15)', color: '#9ca3af' },
    agents:     { bg: 'rgba(139,92,246,0.15)',  color: '#8b5cf6' },
    tools:      { bg: 'rgba(107,114,128,0.15)', color: '#9ca3af' },
    audio:      { bg: 'rgba(236,72,153,0.15)',  color: '#ec4899' },
    video:      { bg: 'rgba(236,72,153,0.15)',  color: '#ec4899' },
    research:   { bg: 'rgba(6,182,212,0.15)',   color: '#06b6d4' },
    translate:  { bg: 'rgba(107,114,128,0.15)', color: '#9ca3af' },
    creative:   { bg: 'rgba(245,158,11,0.15)',  color: '#f59e0b' },
    free:       { bg: 'rgba(16,185,129,0.15)',  color: '#10b981' },
    roleplay:   { bg: 'rgba(139,92,246,0.15)',  color: '#8b5cf6' },
    mcp:        { bg: 'rgba(107,114,128,0.15)', color: '#9ca3af' },
    analytics:  { bg: 'rgba(107,114,128,0.15)', color: '#9ca3af' },
    crypto:     { bg: 'rgba(245,158,11,0.15)',  color: '#f59e0b' },
    audit:      { bg: 'rgba(239,68,68,0.15)',   color: '#ef4444' },
    'web-search':{ bg: 'rgba(59,130,246,0.15)', color: '#3b82f6' },
    'x-search':  { bg: 'rgba(0,0,0,0.2)',         color: '#9ca3af' },
  };

  const formatPrice = (val) => {
    // Was: null -> '$0' (fabricates a price we don't know), 0 -> '<$0.01'
    // (a genuinely free service shown as costing something), and otherwise
    // raw string concat, which rendered unrounded floats straight from the
    // network like "$0.4751238243109613" and blew out the column.
    if (val === undefined || val === null) return '—';
    const n = Number(val);
    if (!Number.isFinite(n)) return '—';
    if (n === 0) return '$0';
    if (n < 0.01) return '<$0.01';
    return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  };

  const loadBarColor = (load, max) => {
    const ratio = max > 0 ? load / max : 0;
    if (ratio > 0.8) return 'var(--danger)';
    if (ratio > 0.5) return 'var(--warning)';
    return 'var(--accent)';
  };

  return (
    <div className="table-container">
      <div className="table-header">
        <h2 className="table-title">Available Services</h2>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          {/* Two views over the same data, not two nav tabs — see the
              header comment at the top of this file. */}
          <div style={{ display: 'flex', gap: '0.25rem', background: 'var(--bg-secondary)', padding: '0.2rem', borderRadius: '8px' }}>
            {[
              { id: VIEW_BY_MODEL, label: t('services.view.byModel') },
              { id: VIEW_LISTINGS, label: t('services.view.listings') },
            ].map(opt => (
              <button
                key={opt.id}
                onClick={() => setView(opt.id)}
                style={{
                  padding: '0.35rem 0.75rem',
                  borderRadius: '6px',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  border: 'none',
                  cursor: 'pointer',
                  background: view === opt.id ? 'var(--accent)' : 'transparent',
                  color: view === opt.id ? 'white' : 'var(--text-secondary)',
                  transition: 'all 0.2s',
                  whiteSpace: 'nowrap',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="search-box">
            <Search size={16} className="search-icon" />
            <input
              type="text"
              placeholder={view === VIEW_BY_MODEL ? t('services.byModel.searchPlaceholder') : 'Search services...'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      {view === VIEW_BY_MODEL ? (
        <>
          <p style={{ padding: '0.75rem 1.5rem', margin: 0, color: 'var(--text-secondary)', fontSize: '0.8125rem', borderBottom: '1px solid var(--border)' }}>
            {t('services.byModel.intro')}
          </p>

          {/* Level 1: company. Level 2 (model family) only appears once a
              company is picked, so the default view stays a short row of
              brands instead of ~400 model names. */}
          <div style={{ padding: '0.85rem 1.5rem', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center' }}>
              <span style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', marginRight: '0.35rem' }}>
                {t('services.byModel.filterCompany')}
              </span>
              <button
                onClick={() => selectCompany('all')}
                style={{
                  padding: '0.3rem 0.7rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 600,
                  border: '1px solid var(--border)', cursor: 'pointer', transition: 'all 0.2s',
                  background: filterCompany === 'all' ? 'var(--accent)' : 'var(--bg-secondary)',
                  color: filterCompany === 'all' ? 'white' : 'var(--text-secondary)',
                }}
              >
                {t('services.byModel.allCompanies')}
              </button>
              {taxonomy.map(c => (
                <button
                  key={c.id}
                  onClick={() => selectCompany(c.id)}
                  style={{
                    padding: '0.3rem 0.7rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 600,
                    border: '1px solid var(--border)', cursor: 'pointer', transition: 'all 0.2s',
                    background: filterCompany === c.id ? 'var(--accent)' : 'var(--bg-secondary)',
                    color: filterCompany === c.id ? 'white' : 'var(--text-secondary)',
                  }}
                >
                  {c.label}
                  <span style={{ opacity: 0.65, marginLeft: '0.35rem', fontWeight: 500 }}>{c.count}</span>
                </button>
              ))}
            </div>

            {activeCompany && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center', marginTop: '0.6rem', paddingTop: '0.6rem', borderTop: '1px dashed var(--border)' }}>
                <span style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', marginRight: '0.35rem' }}>
                  {t('services.byModel.filterModel')}
                </span>
                <button
                  onClick={() => setFilterFamily('all')}
                  style={{
                    padding: '0.25rem 0.6rem', borderRadius: '999px', fontSize: '0.72rem', fontWeight: 600,
                    border: '1px solid var(--border)', cursor: 'pointer', transition: 'all 0.2s',
                    background: filterFamily === 'all' ? 'var(--accent)' : 'transparent',
                    color: filterFamily === 'all' ? 'white' : 'var(--text-secondary)',
                  }}
                >
                  {t('services.byModel.allModels')}
                </button>
                {activeCompany.families.map(f => (
                  <button
                    key={f.label}
                    onClick={() => setFilterFamily(f.label)}
                    style={{
                      padding: '0.25rem 0.6rem', borderRadius: '999px', fontSize: '0.72rem', fontWeight: 600,
                      border: '1px solid var(--border)', cursor: 'pointer', transition: 'all 0.2s',
                      background: filterFamily === f.label ? 'var(--accent)' : 'transparent',
                      color: filterFamily === f.label ? 'white' : 'var(--text-secondary)',
                    }}
                  >
                    {f.label}
                    <span style={{ opacity: 0.65, marginLeft: '0.3rem', fontWeight: 500 }}>{f.count}</span>
                  </button>
                ))}
                <button
                  onClick={() => selectCompany('all')}
                  title={t('services.byModel.clearFilter')}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '0.25rem', marginLeft: 'auto',
                    padding: '0.25rem 0.6rem', borderRadius: '999px', fontSize: '0.72rem',
                    border: 'none', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer',
                  }}
                >
                  <X size={12} /> {t('services.byModel.clearFilter')}
                </button>
              </div>
            )}
          </div>

          <div style={{ display: 'grid', gap: '1px', background: 'var(--border)' }}>
            {filteredModelGroups.length === 0 && (
              <div className="empty-state" style={{ background: 'var(--bg-card)' }}>{t('services.byModel.noResults')}</div>
            )}
            {filteredModelGroups.map(group => (
              <div key={group.key} style={{ background: 'var(--bg-card)', padding: '1rem 1.5rem' }}>
                <h3 style={{ fontSize: '0.9375rem', fontWeight: 600, marginBottom: '0.6rem', fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {group.name}
                  {/* Sellers spell this model more than one way — say so, so a
                      reader who searched the other spelling understands why
                      their string isn't the heading. */}
                  {group.aliasCount > 1 && (
                    <span
                      title={t('services.byModel.aliasHint')}
                      style={{
                        fontSize: '0.65rem', fontWeight: 600, fontFamily: 'inherit',
                        padding: '0.1rem 0.45rem', borderRadius: '999px',
                        background: 'rgba(139,92,246,0.15)', color: '#a78bfa', whiteSpace: 'nowrap',
                      }}
                    >
                      {group.aliasCount} {t('services.byModel.aliases')}
                    </span>
                  )}
                </h3>
                <table className="table" style={{ tableLayout: 'fixed' }}>
                  <thead>
                    <tr>
                      <th style={{ width: 70 }}>{t('services.byModel.col.rank')}</th>
                      <th>{t('services.byModel.col.provider')}</th>
                      <th>{t('services.byModel.col.providerModelName')}</th>
                      <th style={{ width: 170 }}>{t('services.byModel.col.price')}</th>
                      <th style={{ width: 150 }}>{t('services.byModel.col.reference')}</th>
                      <th style={{ width: 110 }}>{t('services.byModel.col.discount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.providers.map((svc, idx) => (
                      <tr key={svc.id}>
                        <td>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontWeight: 700, color: rankColors[idx] || 'var(--text-secondary)' }}>
                            {idx < 3 ? <Trophy size={14} /> : null}
                            #{idx + 1}
                          </span>
                        </td>
                        <td><span style={{ fontSize: '0.875rem' }}>{svc.sellerName}</span></td>
                        {/* The exact string this seller advertises — what you
                            must actually send as the model id. */}
                        <td>
                          <code
                            style={{
                              fontSize: '0.78rem', fontFamily: 'monospace',
                              color: svc.name === group.name ? 'var(--text-secondary)' : '#a78bfa',
                              wordBreak: 'break-all',
                            }}
                          >
                            {svc.name}
                          </code>
                        </td>
                        {/* Input and output in one cell: they're always read
                            together, and two columns of near-identical
                            numbers made the row hard to scan. */}
                        <td>
                          <span style={{ fontSize: '0.8125rem', fontWeight: 500, whiteSpace: 'nowrap' }}>
                            <span style={{ color: '#34d399' }}>{formatPrice(svc.pricing.inputUsdPerMillion)}</span>
                            <span style={{ color: 'var(--text-secondary)', margin: '0 0.3rem' }}>/</span>
                            <span style={{ color: '#fbbf24' }}>{formatPrice(svc.pricing.outputUsdPerMillion)}</span>
                          </span>
                        </td>
                        {/* Reference list price — identical for every row in
                            the group (it's per-model), shown per row so each
                            line can be read on its own. `—` when this model
                            has no entry in the reference catalogue. */}
                        <td>
                          {group.reference ? (
                            <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                              {formatPrice(group.reference.inputUsdPerMillion)}
                              <span style={{ margin: '0 0.3rem' }}>/</span>
                              {formatPrice(group.reference.outputUsdPerMillion)}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--text-secondary)', opacity: 0.5 }}>—</span>
                          )}
                        </td>
                        <td>
                          {(() => {
                            const delta = referenceDelta(svc, group.reference);
                            if (delta === null) {
                              return <span style={{ color: 'var(--text-secondary)', opacity: 0.5 }}>—</span>;
                            }
                            const cheaper = delta < 0;
                            return (
                              <span
                                style={{
                                  fontSize: '0.8125rem', fontWeight: 600, whiteSpace: 'nowrap',
                                  padding: '0.15rem 0.45rem', borderRadius: '6px',
                                  background: cheaper ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)',
                                  color: cheaper ? '#34d399' : '#fbbf24',
                                }}
                              >
                                {cheaper ? '−' : '+'}{Math.abs(delta).toFixed(0)}%
                              </span>
                            );
                          })()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>

          <p style={{ padding: '1rem 1.5rem 0.5rem', margin: 0, color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
            {t('services.byModel.footnote')}
          </p>
          <p style={{ padding: '0 1.5rem 1rem', margin: 0, color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
            {t('services.byModel.referenceNote')}
          </p>
        </>
      ) : (
      <>
      <div style={{ padding: '0.75rem 1.5rem', borderBottom: '1px solid var(--border)', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Filter by category:
        </span>
        {categories.map(cat => (
          <button
            key={cat}
            onClick={() => setFilterCategory(cat)}
            style={{
              padding: '0.25rem 0.75rem',
              borderRadius: '9999px',
              fontSize: '0.75rem',
              fontWeight: 500,
              border: 'none',
              cursor: 'pointer',
              background: filterCategory === cat ? 'var(--accent)' : 'var(--bg-secondary)',
              color: filterCategory === cat ? 'white' : 'var(--text-secondary)',
              transition: 'all 0.2s',
            }}
          >
            {cat === 'all' ? 'All' : cat}
          </button>
        ))}
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Service</th>
            <th>Seller</th>
            <th>Status</th>
            <th>Price (per 1M tokens)</th>
            <th>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', cursor: 'help' }}
                onMouseEnter={() => setShowLoadTip(true)}
                onMouseLeave={() => setShowLoadTip(false)}
              >
                Load
                <HelpCircle size={13} color="var(--text-secondary)" />
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(svc => {
            const loadRatio = svc.maxConcurrency > 0 ? svc.currentLoad / svc.maxConcurrency : 0;
            return (
              <tr key={svc.id}>
                <td>
                  <div className="user-cell">
                    <div className="avatar" style={{ background: 'var(--info)' }}>
                      <Zap size={16} />
                    </div>
                    <div className="user-info">
                      <span className="user-name">{svc.name}</span>
                      <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', marginTop: '0.35rem' }}>
                        {svc.categories.slice(0, 4).map(cat => {
                          const color = categoryColors[cat] || categoryColors['general'];
                          return (
                            <span
                              key={cat}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.2rem',
                                padding: '0.1rem 0.4rem',
                                borderRadius: '9999px',
                                fontSize: '0.65rem',
                                fontWeight: 500,
                                background: color.bg,
                                color: color.color,
                                lineHeight: 1.2,
                              }}
                            >
                              <Tag size={8} />
                              {cat}
                            </span>
                          );
                        })}
                        {svc.categories.length > 4 && (
                          <span
                            style={{
                              fontSize: '0.65rem',
                              color: 'var(--text-secondary)',
                              padding: '0.1rem 0.4rem',
                            }}
                          >
                            +{svc.categories.length - 4}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </td>
                <td>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>{svc.sellerName}</span>
                </td>
                <td>
                  <span className={`status-badge ${svc.status}`}>
                    <span className="status-dot" style={{ animation: 'none', background: 'currentColor' }}></span>
                    {svc.status}
                  </span>
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      padding: '0.35rem 0.7rem',
                      borderRadius: '8px',
                      background: 'rgba(16,185,129,0.12)',
                      border: '1px solid rgba(16,185,129,0.25)',
                      fontSize: '0.825rem',
                      fontWeight: 600,
                      color: '#34d399',
                      whiteSpace: 'nowrap',
                    }}>
                      In: {formatPrice(svc.pricing.inputUsdPerMillion)}
                    </div>
                    <ArrowRight size={14} color="var(--text-secondary)" />
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      padding: '0.35rem 0.7rem',
                      borderRadius: '8px',
                      background: 'rgba(245,158,11,0.12)',
                      border: '1px solid rgba(245,158,11,0.25)',
                      fontSize: '0.825rem',
                      fontWeight: 600,
                      color: '#fbbf24',
                      whiteSpace: 'nowrap',
                    }}>
                      Out: {formatPrice(svc.pricing.outputUsdPerMillion)}
                    </div>
                  </div>
                  {svc.pricing.cachedInputUsdPerMillion !== undefined && svc.pricing.cachedInputUsdPerMillion !== 0 && svc.pricing.cachedInputUsdPerMillion !== svc.pricing.inputUsdPerMillion && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.35rem' }}>
                      Cached in: <span style={{ color: '#34d399', fontWeight: 500 }}>{formatPrice(svc.pricing.cachedInputUsdPerMillion)}</span>
                    </div>
                  )}
                </td>
                <td style={{ position: 'relative' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div className="volume-bar" style={{ width: 80 }}>
                      <div
                        className="volume-fill"
                        style={{
                          width: `${loadRatio * 100}%`,
                          background: loadBarColor(svc.currentLoad, svc.maxConcurrency),
                        }}
                      ></div>
                    </div>
                    <span style={{ fontSize: '0.8rem', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                      {svc.currentLoad}/{svc.maxConcurrency}
                    </span>
                  </div>
                </td>
              </tr>
            );
          })}
          {filtered.length === 0 && (
            <tr>
              <td colSpan="5">
                <div className="empty-state">No services found matching your search.</div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </>
      )}

      {/* Tooltip for Load header */}
      {showLoadTip && (
        <div
          style={{
            position: 'fixed',
            bottom: '2rem',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: '12px',
            padding: '1rem 1.5rem',
            boxShadow: '0 10px 40px rgba(0,0,0,0.4)',
            zIndex: 1000,
            maxWidth: '480px',
            textAlign: 'center',
          }}
          onMouseEnter={() => setShowLoadTip(true)}
          onMouseLeave={() => setShowLoadTip(false)}
        >
          <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>What is Load?</div>
          <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            Load shows how busy a provider node is right now.<br />
            <span style={{ color: 'var(--accent)' }}>Green</span> = plenty of capacity &middot;
            <span style={{ color: 'var(--warning)' }}> Orange</span> = getting busy &middot;
            <span style={{ color: 'var(--danger)' }}> Red</span> = near capacity (may be slower).<br />
            The AntSeed proxy routes requests to the least-loaded provider for faster responses.
          </div>
        </div>
      )}
    </div>
  );
}

export default ServicesList;
