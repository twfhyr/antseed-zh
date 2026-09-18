import React, { useEffect, useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { useI18n } from '../i18n/index.jsx';
import { fetchMarketplaceCompare, fetchReferencePrices } from '../api';

// The "Inference Market" tab: how AntSeed, Surplus Intelligence and Orbio
// are built, and what the same models cost on each. Two deliberate parts:
// Part 1 is a static, sourced fact matrix (objective — no better/worse
// framing, per the owner's call); Part 2 is live pricing fetched through
// /api/marketplace-compare (backend caches 6h, never fabricates — a failed
// source renders `—`). See notes/plans/marketplace-compare.md.

// Same 3:1 output:input blend ServicesList uses for ranking — comparing
// marketplaces needs a single number, and weighting both sides identically
// keeps the comparison honest.
const OUTPUT_WEIGHT = 3;
const INPUT_WEIGHT = 1;

function blend(input, output) {
  const i = Number(input);
  const o = Number(output);
  if (!Number.isFinite(i) || !Number.isFinite(o) || i <= 0 || o <= 0) return null;
  return (i * INPUT_WEIGHT + o * OUTPUT_WEIGHT) / (INPUT_WEIGHT + OUTPUT_WEIGHT);
}

function formatPrice(val) {
  if (val === undefined || val === null) return '—';
  const n = Number(val);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatUsd(val) {
  if (val === undefined || val === null) return '—';
  const n = Number(val);
  if (!Number.isFinite(n)) return '—';
  return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

// Static matrix rows. Facts only, each sourced: AntSeed from this repo's
// protocol docs, Surplus from surplusintelligence.ai/docs, Orbio from
// orbio.so. Keep wording parallel and neutral.
const MATRIX_ROWS = ['model', 'discovery', 'transport', 'settlement', 'custody', 'sellers', 'fees', 'identity'];

// Shared-models price table size: enough to cover the models buyers actually
// look at, short enough to stay curated.
const SHARED_TABLE_LIMIT = 10;

function MarketplaceCompare({ services }) {
  const { t } = useI18n();
  const [market, setMarket] = useState(null);
  const [reference, setReference] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchMarketplaceCompare()
      .then(payload => { if (!cancelled) setMarket(payload); })
      .catch(() => { if (!cancelled) setMarket({ error: true }); });
    fetchReferencePrices()
      .then(payload => { if (!cancelled) setReference(payload?.models ?? {}); })
      .catch(() => { if (!cancelled) setReference({}); });
    return () => { cancelled = true; };
  }, []);

  // Cheapest AntSeed seller per canonical model, with seller count for
  // ranking the shared-models table.
  const antseedByKey = useMemo(() => {
    const map = new Map();
    for (const svc of services ?? []) {
      const key = svc.canonicalKey;
      if (!key) continue;
      const price = blend(svc.pricing?.inputUsdPerMillion, svc.pricing?.outputUsdPerMillion);
      let g = map.get(key);
      if (!g) {
        g = { key, name: svc.displayName ?? svc.name, sellerCount: 0, cheapest: null };
        map.set(key, g);
      }
      g.sellerCount += 1;
      if (price !== null && (g.cheapest === null || price < blend(g.cheapest.pricing?.inputUsdPerMillion, g.cheapest.pricing?.outputUsdPerMillion))) {
        g.cheapest = svc;
      }
    }
    return map;
  }, [services]);

  // Index competitor/reference catalogs by canonical key.
  const indexByKey = (models) => {
    const map = new Map();
    for (const entry of Object.values(models ?? {})) {
      if (entry?.canonicalKey && !map.has(entry.canonicalKey)) map.set(entry.canonicalKey, entry);
    }
    return map;
  };
  const surplusByKey = useMemo(() => indexByKey(market?.surplus?.models), [market]);
  const orbioByKey = useMemo(() => indexByKey(market?.orbio?.models), [market]);
  const referenceByKey = useMemo(() => indexByKey(reference), [reference]);

  // Top AntSeed models (by seller count) that at least one other source
  // also lists — comparing rows nobody else sells would be an empty table.
  const sharedRows = useMemo(() => {
    const rows = [...antseedByKey.values()].filter(g =>
      g.cheapest &&
      (surplusByKey.has(g.key) || orbioByKey.has(g.key) || referenceByKey.has(g.key))
    );
    rows.sort((a, b) => b.sellerCount - a.sellerCount || a.key.localeCompare(b.key));
    return rows.slice(0, SHARED_TABLE_LIMIT);
  }, [antseedByKey, surplusByKey, orbioByKey, referenceByKey]);

  const orbioDiscount = market?.orbio?.discount ?? null;
  const orbioDiscountPct = orbioDiscount ? (orbioDiscount.bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 }) : null;

  const sourceCell = (entry, useEffective) => {
    if (!entry) return <span style={{ color: 'var(--text-secondary)' }}>—</span>;
    const input = useEffective ? (entry.effectiveInputUsdPerMillion ?? entry.inputUsdPerMillion) : entry.inputUsdPerMillion;
    const output = useEffective ? (entry.effectiveOutputUsdPerMillion ?? entry.outputUsdPerMillion) : entry.outputUsdPerMillion;
    const blended = blend(input, output);
    if (blended === null) return <span style={{ color: 'var(--text-secondary)' }}>—</span>;
    return <span>{formatPrice(blended)}</span>;
  };

  return (
    <div>
      {/* ── Part 1: how the three are built ── */}
      <div className="table-container" style={{ marginBottom: '1.5rem' }}>
        <div className="table-header">
          <h2 className="table-title">{t('market.matrix.title')}</h2>
        </div>
        <p style={{ padding: '0.75rem 1.5rem', margin: 0, color: 'var(--text-secondary)', fontSize: '0.8125rem', borderBottom: '1px solid var(--border)' }}>
          {t('market.matrix.intro')}
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: '14%' }}>{t('market.matrix.col.dimension')}</th>
                <th style={{ width: '30%' }}>AntSeed</th>
                <th style={{ width: '28%' }}>Surplus Intelligence</th>
                <th style={{ width: '28%' }}>Orbio</th>
              </tr>
            </thead>
            <tbody>
              {MATRIX_ROWS.map(row => (
                <tr key={row}>
                  <td style={{ fontWeight: 600 }}>{t(`market.matrix.${row}.label`)}</td>
                  <td>{t(`market.matrix.${row}.antseed`)}</td>
                  <td>{t(`market.matrix.${row}.surplus`)}</td>
                  <td>{t(`market.matrix.${row}.orbio`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Part 2: live metrics ── */}
      <div className="table-container">
        <div className="table-header">
          <h2 className="table-title">
            {t('market.live.title')}
            <span className="stat-info-icon" tabIndex={0} style={{ marginLeft: '0.4rem', verticalAlign: 'middle' }}>
              <Info size={14} />
              <span className="stat-info-tooltip" role="tooltip">{t('market.live.methodology')}</span>
            </span>
          </h2>
        </div>

        {/* Headline cards: catalog size per marketplace + Orbio's current
            discount tier. Any failed source shows — rather than a guess. */}
        <div className="stats-grid" style={{ padding: '1rem 1.5rem' }}>
          <div className="stat-card">
            <div className="stat-header"><span className="stat-title">AntSeed</span></div>
            <div className="stat-value" style={{ fontSize: '1.1rem' }}>
              {market?.antseed ? t('market.live.antseedStats', {
                sellers: market.antseed.sellers, models: market.antseed.models, listings: market.antseed.listings,
              }) : '—'}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-header"><span className="stat-title">Surplus Intelligence</span></div>
            <div className="stat-value" style={{ fontSize: '1.1rem' }}>
              {market?.surplus && !market.surplus.error
                ? t('market.live.catalogStats', { models: market.surplus.pricedCount })
                : '—'}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-header"><span className="stat-title">Orbio</span></div>
            <div className="stat-value" style={{ fontSize: '1.1rem' }}>
              {market?.orbio && !market.orbio.error
                ? t('market.live.orbioStats', { models: market.orbio.pricedCount })
                : '—'}
              {orbioDiscountPct && (
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                  {t('market.live.orbioDiscount', {
                    pct: orbioDiscountPct,
                    credits: formatUsd(orbioDiscount.creditsUsd),
                    total: formatUsd(orbioDiscount.totalCreditsUsd),
                  })}
                </div>
              )}
              {market?.orbio && !market.orbio.error && !orbioDiscount && (
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                  {t('market.live.discountUnavailable')}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Shared-models price table. Blended 3:1 out:in per 1M tokens;
            cheapest source per row is highlighted. Orbio prices are its
            effective rate (list × (1−discount) × 1.05 fee) when the
            liquidity book parsed, else its list price. */}
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('market.live.col.model')}</th>
                <th>{t('market.live.col.antseed')}</th>
                <th>{t('market.live.col.openrouter')}</th>
                <th>Surplus</th>
                <th>Orbio</th>
              </tr>
            </thead>
            <tbody>
              {sharedRows.map(g => {
                const antPrice = blend(g.cheapest.pricing?.inputUsdPerMillion, g.cheapest.pricing?.outputUsdPerMillion);
                const ref = referenceByKey.get(g.key);
                const refPrice = ref ? blend(ref.inputUsdPerMillion, ref.outputUsdPerMillion) : null;
                const sur = surplusByKey.get(g.key);
                const surPrice = sur ? blend(sur.inputUsdPerMillion, sur.outputUsdPerMillion) : null;
                const orb = orbioByKey.get(g.key);
                const orbPrice = orb
                  ? blend(orb.effectiveInputUsdPerMillion ?? orb.inputUsdPerMillion, orb.effectiveOutputUsdPerMillion ?? orb.outputUsdPerMillion)
                  : null;
                const prices = [
                  { k: 'antseed', v: antPrice }, { k: 'ref', v: refPrice },
                  { k: 'surplus', v: surPrice }, { k: 'orbio', v: orbPrice },
                ].filter(p => p.v !== null);
                const cheapest = prices.length ? Math.min(...prices.map(p => p.v)) : null;
                const hl = (v) => (v !== null && v === cheapest
                  ? { color: 'var(--accent)', fontWeight: 700 }
                  : undefined);
                return (
                  <tr key={g.key}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{g.name}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{g.key}</div>
                    </td>
                    <td style={hl(antPrice)}>{formatPrice(antPrice)}</td>
                    <td style={hl(refPrice)}>{sourceCell(ref, false)}</td>
                    <td style={hl(surPrice)}>{sourceCell(sur, false)}</td>
                    <td style={hl(orbPrice)}>{sourceCell(orb, true)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p style={{ padding: '0.75rem 1.5rem', margin: 0, color: 'var(--text-secondary)', fontSize: '0.75rem', borderTop: '1px solid var(--border)' }}>
          {t('market.live.footnote', { fetchedAt: market?.fetchedAt ? new Date(market.fetchedAt).toLocaleString() : '—' })}
        </p>
      </div>
    </div>
  );
}

export default MarketplaceCompare;
