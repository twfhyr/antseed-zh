import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  useAccount,
  useWalletClient,
} from 'wagmi';
import {
  Layers,
  Loader2,
  AlertCircle,
  ExternalLink,
  X,
} from 'lucide-react';
import { fetchSellers, fetchLantsMarket, fetchLantsOffers, postLantsTrade, fetchLantsTrades } from '../api';
import { useI18n } from '../i18n/index.jsx';
import { useMarketTabRouter, marketTabHref } from '../hooks/useTabRouter';
import {
  createAndPostListing, fulfillListing, cancelListing, makeOffer, cancelOffer, acceptOffer,
  splitPosition, isProviderActivationStake,
} from '../lib/listLants';

const truncateAddress = (addr) => (addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '');
const formatAnts = (n) => {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
};
const formatUsd = (n) => {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (abs >= 0.01) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  return `$${n.toPrecision(3)}`;
};
// Implied MC/FDV are always large (supply * a per-ANT price), so they need
// M/B suffixes rather than formatUsd's full-precision output.
const formatUsdCompact = (n) => {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return formatUsd(n);
};
// Listings are paid in native ETH (Seaport's consideration for every
// listing this site creates), so the listed price itself should read in
// ETH, not the USD conversion -- USD only makes sense for the per-ANT
// reference price below, where it's comparable across listings priced at
// different ETH amounts.
const formatListing = (listing) => {
  if (!listing) return '—';
  if (listing.unit != null && listing.symbol) {
    return `${listing.unit.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${listing.symbol}`;
  }
  if (listing.usd != null) return formatUsd(listing.usd);
  return '—';
};

function sellerForAgent(sellers, agentId) {
  if (agentId == null) return null;
  const id = String(agentId);
  return sellers.find((s) => s.agentId != null && String(s.agentId) === id) || null;
}

function positionState(p, currentEpoch) {
  if (p.withdrawn) return 'withdrawn';
  if (p.closedAtEpoch) return 'closed';
  if (currentEpoch == null) return null;
  if (currentEpoch < p.stakeStartEpoch) return 'pending';
  if (currentEpoch < p.stakeEndEpoch) return 'active';
  return 'matured';
}

function StakeANTS() {
  const { t, lang } = useI18n();
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();

  const [sellers, setSellers] = useState([]);
  const [market, setMarket] = useState(null);
  const [marketLoading, setMarketLoading] = useState(true);
  const [marketError, setMarketError] = useState(false);
  const [marketTab, setMarketTab] = useMarketTabRouter(); // 'listed' | 'all' | 'mine' -- URL-driven, see /stake/sales|iants|mine
  const [marketPage, setMarketPage] = useState(1);
  const [marketSort, setMarketSort] = useState('id');
  const [marketFilters, setMarketFilters] = useState({ agentId: '', minAmount: '', maxAmount: '', minLockDays: '', maxLockDays: '' });
  const [filterDraft, setFilterDraft] = useState(marketFilters);
  const MARKET_PAGE_SIZE = 10;
  const [listForm, setListForm] = useState(null); // { id, price, days, phase, message }
  const [buyState, setBuyState] = useState(null); // { id, phase, message }
  const [cancelState, setCancelState] = useState(null); // { id, phase, message }
  const [offerForm, setOfferForm] = useState(null); // { id, price, days, phase, message }
  const [offersOpenFor, setOffersOpenFor] = useState(null); // tokenId whose offers panel is expanded
  const [offersById, setOffersById] = useState({}); // tokenId -> { loading, items, error }
  const [offerActionState, setOfferActionState] = useState(null); // { offerId, phase, message }
  const [splitForm, setSplitForm] = useState(null); // { id, amount, phase, message, result }
  const [trades, setTrades] = useState(null);
  const [tradesLoading, setTradesLoading] = useState(false);
  const [tradesError, setTradesError] = useState(false);

  // Seller names for the per-card fallback (market items already carry
  // their own sellerName server-side; this only fills the rare gap) and the
  // "filter by seller" dropdown. Unconditional -- unlike the old rewards
  // fetch, browsing the market never required a connected wallet.
  useEffect(() => {
    fetchSellers().then((data) => setSellers(data.filter((s) => s.agentId))).catch(() => {});
  }, []);

  const marketQuery = useMemo(() => ({
    page: marketPage,
    pageSize: MARKET_PAGE_SIZE,
    sort: marketSort,
    listed: marketTab === 'listed' ? '1' : undefined,
    owner: marketTab === 'mine' ? address : undefined,
    agentId: marketFilters.agentId || undefined,
    minAmount: marketFilters.minAmount || undefined,
    maxAmount: marketFilters.maxAmount || undefined,
    minLockDays: marketFilters.minLockDays || undefined,
    maxLockDays: marketFilters.maxLockDays || undefined,
  }), [marketPage, marketSort, marketTab, address, marketFilters]);

  // Only steer away from an empty "For sale" tab once, on the very first
  // load -- otherwise this effect (which reruns on every marketTab change)
  // would immediately bounce the user straight back to "All NFTs" the
  // moment they clicked "For sale" while nothing happens to be listed.
  const autoTabAppliedRef = useRef(false);

  useEffect(() => {
    if (marketTab === 'history') return;
    if (marketTab === 'mine' && !address) return;
    let cancelled = false;
    setMarketLoading(true);
    setMarketError(false);
    fetchLantsMarket(marketQuery)
      .then((data) => {
        if (cancelled) return;
        setMarket(data);
        if (!autoTabAppliedRef.current) {
          autoTabAppliedRef.current = true;
          if (marketTab === 'listed' && (data?.listedCount || 0) === 0) setMarketTab('all');
        }
      })
      .catch((e) => {
        console.error('Failed to load lANTS market:', e);
        if (!cancelled) {
          setMarket(null);
          setMarketError(true);
        }
      })
      .finally(() => { if (!cancelled) setMarketLoading(false); });
    return () => { cancelled = true; };
  }, [marketQuery, marketTab, address]);

  // Trade history -- separate from the market fetch above, only loaded on
  // the History tab. Reuses marketPage for pagination since the two views
  // are mutually exclusive (never shown together).
  useEffect(() => {
    if (marketTab !== 'history') return;
    let cancelled = false;
    setTradesLoading(true);
    setTradesError(false);
    fetchLantsTrades({ page: marketPage, pageSize: MARKET_PAGE_SIZE })
      .then((data) => { if (!cancelled) setTrades(data); })
      .catch((e) => {
        console.error('Failed to load lANTS trade history:', e);
        if (!cancelled) { setTrades(null); setTradesError(true); }
      })
      .finally(() => { if (!cancelled) setTradesLoading(false); });
    return () => { cancelled = true; };
  }, [marketTab, marketPage]);

  // Any filter/tab/sort change should snap back to page 1 -- otherwise a
  // narrower result set can leave the view on a now-empty page.
  const resetToFirstPage = (fn) => (...args) => { setMarketPage(1); fn(...args); };
  const setMarketTabAndReset = resetToFirstPage(setMarketTab);
  const setMarketSortAndReset = resetToFirstPage(setMarketSort);
  const setMarketFiltersAndReset = resetToFirstPage(setMarketFilters);

  // Filtering, sorting, pagination, and activation-stake exclusion all
  // happen server-side now (backend/server.js paginateMarketItems) -- this
  // is already exactly the page to show.
  const marketItems = market?.items || [];

  const doList = async (position) => {
    const contract = market?.contract;
    if (!walletClient || !address || !contract) {
      setListForm((f) => ({ ...(f || { position, price: '', days: 30 }), phase: 'error', message: t('stake.listNeedWallet') }));
      return;
    }
    const price = Number(listForm?.price);
    if (!(price > 0)) {
      setListForm((f) => ({ ...f, phase: 'error', message: t('stake.listPrice') }));
      return;
    }
    try {
      setListForm((f) => ({ ...f, phase: 'listing', message: t('stake.listing') }));
      await createAndPostListing({
        walletClient,
        account: address,
        contract,
        tokenId: position.id,
        priceEth: price,
        durationDays: listForm?.days || 30,
      });
      setListForm({ position, price: String(price), days: listForm?.days || 30, phase: 'done', message: t('stake.listedOk') });
      fetchLantsMarket({ ...marketQuery, wait: '1' }).then(setMarket).catch(() => {});
    } catch (e) {
      setListForm((f) => ({ ...f, phase: 'error', message: e.shortMessage || e.message }));
    }
  };

  const doBuy = async (position) => {
    if (!walletClient || !address) {
      setBuyState({ id: position.id, phase: 'error', message: t('stake.buyNeedWallet') });
      return;
    }
    try {
      setBuyState({ id: position.id, phase: 'buying', message: t('stake.buying') });
      const result = await fulfillListing({ walletClient, account: address, tokenId: position.id });
      setBuyState({ id: position.id, phase: 'done', message: t('stake.boughtOk') });
      if (result?.seller && result?.priceWei) {
        postLantsTrade({
          tokenId: position.id, seller: result.seller, buyer: address,
          priceWei: result.priceWei, currency: 'ETH', txHash: result.hash,
        }).catch(() => {});
      }
      // A direct Seaport fulfillment never touches this backend, so the
      // cached (Antscan-sourced) owner can still say "seller" for a while
      // after a real sale -- force a real on-chain read of this id right
      // now instead of leaving it to show as for-sale until Antscan reindexes.
      fetchLantsMarket({ ...marketQuery, wait: '1', ensureIds: String(position.id) }).then(setMarket).catch(() => {});
    } catch (e) {
      setBuyState({ id: position.id, phase: 'error', message: e.shortMessage || e.message });
    }
  };

  const doCancel = async (position) => {
    if (!walletClient || !address) {
      setCancelState({ id: position.id, phase: 'error', message: t('stake.buyNeedWallet') });
      return;
    }
    try {
      setCancelState({ id: position.id, phase: 'cancelling', message: t('stake.cancelling') });
      await cancelListing({ walletClient, account: address, tokenId: position.id });
      setCancelState({ id: position.id, phase: 'done', message: t('stake.cancelledOk') });
      fetchLantsMarket({ ...marketQuery, wait: '1' }).then(setMarket).catch(() => {});
    } catch (e) {
      setCancelState({ id: position.id, phase: 'error', message: e.shortMessage || e.message });
    }
  };

  const doSplit = async (position) => {
    const poolsAddr = market?.contract;
    if (!walletClient || !address || !poolsAddr) {
      setSplitForm((f) => ({ ...(f || { position, amount: '' }), phase: 'error', message: t('stake.buyNeedWallet') }));
      return;
    }
    const amount = Number(splitForm?.amount);
    if (!(amount > 0) || amount >= position.amount) {
      setSplitForm((f) => ({ ...f, phase: 'error', message: t('stake.splitAmountInvalid') }));
      return;
    }
    try {
      setSplitForm((f) => ({ ...f, phase: 'splitting', message: t('stake.splitting') }));
      const result = await splitPosition({
        walletClient, account: address, poolsAddress: poolsAddr,
        positionId: position.id, splitAmountAnts: amount,
      });
      setSplitForm({ position, amount: String(amount), phase: 'done', message: t('stake.splitOk'), result });
      // The two new position ids won't be in Antscan's cache yet -- pass
      // them explicitly so the backend fetches them on-chain right now
      // instead of waiting for Antscan to catch up (see /api/lants-market's
      // ensureIds handling).
      const ensureIds = [result.firstPositionId, result.secondPositionId].filter((x) => x != null).join(',');
      fetchLantsMarket({ ...marketQuery, wait: '1', ensureIds }).then(setMarket).catch(() => {});
    } catch (e) {
      setSplitForm((f) => ({ ...f, phase: 'error', message: e.shortMessage || e.message }));
    }
  };

  const doMakeOffer = async (position) => {
    const contract = market?.contract;
    if (!walletClient || !address || !contract) {
      setOfferForm((f) => ({ ...(f || { position, price: '', days: 30 }), phase: 'error', message: t('stake.buyNeedWallet') }));
      return;
    }
    const price = Number(offerForm?.price);
    if (!(price > 0)) {
      setOfferForm((f) => ({ ...f, phase: 'error', message: t('stake.listPrice') }));
      return;
    }
    try {
      setOfferForm((f) => ({ ...f, phase: 'offering', message: t('stake.offering') }));
      await makeOffer({
        walletClient, account: address, contract, tokenId: position.id,
        priceEth: price, durationDays: offerForm?.days || 30,
      });
      setOfferForm({ position, price: String(price), days: offerForm?.days || 30, phase: 'done', message: t('stake.offeredOk') });
      // Both needed: loadOffers refreshes the expandable list (if open),
      // but the closed "Offers (N)" button's count comes from the market
      // item's own offerCount field -- only a market refetch updates that.
      loadOffers(position.id, true);
      fetchLantsMarket({ ...marketQuery, wait: '1' }).then(setMarket).catch(() => {});
    } catch (e) {
      setOfferForm((f) => ({ ...f, phase: 'error', message: e.shortMessage || e.message }));
    }
  };

  const loadOffers = useCallback(async (tokenId, force = false) => {
    if (!force && offersById[tokenId] && !offersById[tokenId].error) return;
    setOffersById((m) => ({ ...m, [tokenId]: { ...(m[tokenId] || {}), loading: true } }));
    try {
      const { offers } = await fetchLantsOffers(tokenId);
      setOffersById((m) => ({ ...m, [tokenId]: { loading: false, items: offers, error: null } }));
    } catch (e) {
      setOffersById((m) => ({ ...m, [tokenId]: { loading: false, items: [], error: e.message } }));
    }
  }, [offersById]);

  const toggleOffers = (tokenId) => {
    const next = offersOpenFor === tokenId ? null : tokenId;
    setOffersOpenFor(next);
    if (next != null) loadOffers(next);
  };

  // Background refresh so a page left passively open -- e.g. a seller
  // waiting to see whether an offer comes in -- picks up new activity on
  // its own, without needing a hard reload or even a tab switch. Plain
  // fetch (no wait=1), same stale-while-revalidate path the initial load
  // already uses: this never forces a synchronous full recompute, it just
  // nudges the server's own background refresh along and reads back
  // whatever it already has.
  useEffect(() => {
    if (marketTab === 'history') return;
    if (marketTab === 'mine' && !address) return;
    const interval = setInterval(() => {
      fetchLantsMarket(marketQuery).then(setMarket).catch(() => {});
      if (offersOpenFor != null) loadOffers(offersOpenFor, true);
    }, 30_000);
    return () => clearInterval(interval);
  }, [marketQuery, marketTab, address, offersOpenFor, loadOffers]);

  const doAcceptOffer = async (offer) => {
    if (!walletClient || !address) return;
    try {
      setOfferActionState({ offerId: offer.id, phase: 'accepting', message: t('stake.accepting') });
      await acceptOffer({ walletClient, account: address, offerId: offer.id });
      setOfferActionState({ offerId: offer.id, phase: 'done', message: t('stake.acceptedOk') });
      loadOffers(offer.tokenId, true);
      fetchLantsMarket({ ...marketQuery, wait: '1' }).then(setMarket).catch(() => {});
    } catch (e) {
      setOfferActionState({ offerId: offer.id, phase: 'error', message: e.shortMessage || e.message });
    }
  };

  const doCancelOffer = async (offer) => {
    if (!walletClient || !address) return;
    try {
      setOfferActionState({ offerId: offer.id, phase: 'cancelling', message: t('stake.cancelling') });
      await cancelOffer({ walletClient, account: address, offerId: offer.id });
      setOfferActionState({ offerId: offer.id, phase: 'done', message: t('stake.cancelledOk') });
      loadOffers(offer.tokenId, true);
      fetchLantsMarket({ ...marketQuery, wait: '1' }).then(setMarket).catch(() => {});
    } catch (e) {
      setOfferActionState({ offerId: offer.id, phase: 'error', message: e.shortMessage || e.message });
    }
  };

  const poolsAddress = market?.contract;

  return (
    <div className="table-container" style={{ padding: '2rem' }}>
      <div style={{ maxWidth: '960px' }}>
        <div style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Layers size={24} style={{ color: 'var(--accent)' }} />
            {t('stake.title')}
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
            {t('stake.blurb')}
          </p>
        </div>

        <div style={{ marginBottom: '2.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
            <h3 style={{ fontSize: '1.125rem', fontWeight: 600 }}>{t('stake.marketTitle')}</h3>
            {market?.collectionUrl && (
              <a href={market.collectionUrl} target="_blank" rel="noopener noreferrer"
                style={{ color: 'var(--info)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.8125rem' }}>
                {t('stake.collectionLink')}
                <ExternalLink size={12} />
              </a>
            )}
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1rem' }}>
            {t('stake.marketBlurb')}
          </p>

          {marketLoading && (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
              <Loader2 size={24} className="spin" />
              <p style={{ marginTop: '0.75rem', fontSize: '0.875rem' }}>{t('stake.marketLoading')}</p>
            </div>
          )}
          {marketError && !marketLoading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--warning)', fontSize: '0.875rem' }}>
              <AlertCircle size={14} />
              <span>{t('stake.marketError')}</span>
            </div>
          )}
          {!marketLoading && market && (
            <>
              {marketTab !== 'history' && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginBottom: '1rem' }}>
                    <StatCard
                      label={t('stake.floorPerAnt')}
                      value={formatUsd(market.floorPerAntUsd)}
                      sub={market.floorTokenId != null ? `#${market.floorTokenId}` : ''}
                      accent="var(--clay)"
                    />
                    <StatCard label={t('stake.listed')} value={market.listedCount ?? '—'} sub="" />
                    <StatCard label={t('stake.collectionNfts')} value={market.totalNfts ?? '—'} sub="" />
                  </div>
                  {market.listedCount === 0 && (
                    <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
                      {t('stake.noneListed')}
                    </div>
                  )}
                </>
              )}
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                <FilterChip active={marketTab === 'listed'} href={marketTabHref('listed')} onClick={() => setMarketTabAndReset('listed')} label={t('stake.filterListed')} />
                <FilterChip active={marketTab === 'all'} href={marketTabHref('all')} onClick={() => setMarketTabAndReset('all')} label={t('stake.filterAll')} />
                {isConnected && address && (
                  <FilterChip active={marketTab === 'mine'} href={marketTabHref('mine')} onClick={() => setMarketTabAndReset('mine')} label={t('stake.filterMine')} />
                )}
                <FilterChip active={marketTab === 'history'} href={marketTabHref('history')} onClick={() => setMarketTabAndReset('history')} label={t('stake.filterHistory')} />
              </div>

              {marketTab === 'history' ? (
                <TradeHistoryPanel
                  trades={trades} loading={tradesLoading} error={tradesError}
                  page={marketPage} pageSize={MARKET_PAGE_SIZE} onPageChange={setMarketPage}
                  t={t} lang={lang}
                />
              ) : (
              <>
              <div className="lants-filters">
                <label>
                  {t('stake.filterSeller')}
                  <select
                    value={filterDraft.agentId}
                    onChange={(e) => setFilterDraft({ ...filterDraft, agentId: e.target.value })}
                  >
                    <option value="">{t('stake.filterAnySeller')}</option>
                    {(market.sellers || []).map((s) => (
                      <option key={s.agentId} value={s.agentId}>{s.name || t('stake.agent', { id: s.agentId })}</option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('stake.filterAmount')}
                  <div className="lants-filters__range">
                    <input type="number" min="0" placeholder={t('stake.min')} value={filterDraft.minAmount}
                      onChange={(e) => setFilterDraft({ ...filterDraft, minAmount: e.target.value })} />
                    <input type="number" min="0" placeholder={t('stake.max')} value={filterDraft.maxAmount}
                      onChange={(e) => setFilterDraft({ ...filterDraft, maxAmount: e.target.value })} />
                  </div>
                </label>
                <label>
                  {t('stake.filterLockDays')}
                  <div className="lants-filters__range">
                    <input type="number" min="0" placeholder={t('stake.min')} value={filterDraft.minLockDays}
                      onChange={(e) => setFilterDraft({ ...filterDraft, minLockDays: e.target.value })} />
                    <input type="number" min="0" placeholder={t('stake.max')} value={filterDraft.maxLockDays}
                      onChange={(e) => setFilterDraft({ ...filterDraft, maxLockDays: e.target.value })} />
                  </div>
                </label>
                <label>
                  {t('stake.sortBy')}
                  <select value={marketSort} onChange={(e) => setMarketSortAndReset(e.target.value)}>
                    <option value="id">{t('stake.sortId')}</option>
                    <option value="amount">{t('stake.sortAmount')}</option>
                    <option value="lockDays">{t('stake.sortLockDays')}</option>
                    <option value="daysRemaining">{t('stake.sortRemaining')}</option>
                    <option value="price">{t('stake.sortPrice')}</option>
                  </select>
                </label>
                <button type="button" className="lants-filters__apply" onClick={() => setMarketFiltersAndReset(filterDraft)}>
                  {t('stake.filterApply')}
                </button>
              </div>

              {marketItems.length === 0 && (
                <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', margin: '1rem 0' }}>
                  {marketTab === 'mine' ? t('stake.mineEmpty') : t('stake.noneMatch')}
                </div>
              )}
              {marketItems.length > 0 && (
                <div className="lants-nft-grid">
                  {marketItems.map((p) => (
                    <LantsNftCard
                      key={`m-${p.id}`}
                      position={p}
                      seller={p.sellerName ? { name: p.sellerName } : sellerForAgent(sellers, p.agentId)}
                      currentEpoch={market?.currentEpoch}
                      genesis={market.genesis}
                      epochDuration={market.epochDuration}
                      poolsAddress={poolsAddress}
                      t={t}
                      lang={lang}
                      listing={p.listing}
                      setListForm={setListForm}
                      canList={!!(isConnected && address && p.owner && address.toLowerCase() === p.owner.toLowerCase() && !p.listed && !isProviderActivationStake(p.amount))}
                      onBuy={() => doBuy(p)}
                      canBuy={!!(isConnected && address && p.owner && address.toLowerCase() !== p.owner.toLowerCase() && p.listed && p.fulfillableHere)}
                      buyState={buyState?.id === p.id ? buyState : null}
                      isOwner={!!(isConnected && address && p.owner && address.toLowerCase() === p.owner.toLowerCase())}
                      address={address}
                      onCancel={doCancel}
                      cancelState={cancelState?.id === p.id ? cancelState : null}
                      setOfferForm={setOfferForm}
                      canOffer={marketTab !== 'mine' && !!(isConnected && address && p.owner && address.toLowerCase() !== p.owner.toLowerCase() && !isProviderActivationStake(p.amount))}
                      offersOpen={offersOpenFor === p.id}
                      offers={offersById[p.id]}
                      onToggleOffers={toggleOffers}
                      onAcceptOffer={doAcceptOffer}
                      onCancelOffer={doCancelOffer}
                      offerActionState={offerActionState}
                      setSplitForm={setSplitForm}
                      canSplit={!!(isConnected && address && p.owner && address.toLowerCase() === p.owner.toLowerCase() && !p.listed && !isProviderActivationStake(p.amount) && p.amount > 1)}
                    />
                  ))}
                </div>
              )}
              {market.total > MARKET_PAGE_SIZE && (
                <MarketPager
                  page={marketPage}
                  pageSize={MARKET_PAGE_SIZE}
                  total={market.total}
                  onChange={setMarketPage}
                  t={t}
                />
              )}
              </>
              )}
            </>
          )}
        </div>

      </div>
      <ListModal form={listForm} setForm={setListForm} onConfirm={doList} t={t} />
      <OfferModal form={offerForm} setForm={setOfferForm} onConfirm={doMakeOffer} t={t} />
      <SplitModal form={splitForm} setForm={setSplitForm} onConfirm={doSplit} t={t} />
    </div>
  );
}

function LantsNftCard({
  position: p, seller, currentEpoch, genesis, epochDuration, t, lang, listing, setListForm, canList, onBuy, canBuy, buyState,
  activation, isOwner, address, onCancel, cancelState, setOfferForm, canOffer,
  offersOpen, offers, onToggleOffers, onAcceptOffer, onCancelOffer, offerActionState,
  setSplitForm, canSplit,
}) {
  const sellerName = seller?.name || (p.agentId != null ? t('stake.agent', { id: p.agentId }) : '—');
  const state = (p.stakeStartEpoch != null && p.stakeEndEpoch != null) ? positionState(p, currentEpoch) : null;
  const dates = epochDates(p.stakeStartEpoch, p.stakeEndEpoch, genesis, epochDuration);
  const lockDays = p.lockDays ?? dates.lockDays;
  const daysRemaining = p.daysRemaining ?? dates.daysRemaining;
  const startDate = p.startDate ?? dates.startDate;
  const endDate = p.endDate ?? dates.endDate;
  const perAnt = listing?.perAntUsd != null
    ? t('stake.perAnt', { price: formatUsd(listing.perAntUsd) })
    : null;
  const cancelBusy = cancelState?.id === p.id && cancelState?.phase === 'cancelling';
  const canCancel = isOwner && p.listed && p.fulfillableHere;

  return (
    <figure className="lants-nft">
      <LantsNftArt
        position={p}
        sellerName={sellerName}
        state={state}
        lockDays={lockDays}
        daysRemaining={daysRemaining}
        startDate={startDate}
        endDate={endDate}
        t={t}
        lang={lang}
        listingLabel={listing ? formatListing(listing) : null}
      />
      <figcaption className="lants-nft__caption">
        {listing && (
          <div className="lants-nft__price">
            <span>{t('stake.listedPrice')}: {formatListing(listing)}</span>
            {perAnt && <span>{perAnt}</span>}
            {listing.mcUsd != null && (
              <span style={{ color: 'var(--text-secondary)', fontWeight: 500, fontSize: '0.8125rem' }}>
                {t('stake.impliedMc')}: {formatUsdCompact(listing.mcUsd)}
              </span>
            )}
            {listing.fdvUsd != null && (
              <span style={{ color: 'var(--text-secondary)', fontWeight: 500, fontSize: '0.8125rem' }}>
                {t('stake.impliedFdv')}: {formatUsdCompact(listing.fdvUsd)}
              </span>
            )}
          </div>
        )}
        {activation && (
          <div style={{ color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>{t('stake.activationStake')}</div>
        )}
        {p.owner && (
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', fontFamily: 'monospace', marginBottom: '0.5rem' }}>
            {t('stake.owner')}: {truncateAddress(p.owner)}
          </div>
        )}
        <div className="lants-nft__links">
          {canList && setListForm && (
            <button
              type="button"
              className="lants-nft__listbtn"
              onClick={() => setListForm({ position: p, price: '', days: 30, phase: null, message: null })}
            >
              {t('stake.listOnSite')}
            </button>
          )}
          {canCancel && onCancel && (
            <button
              type="button"
              className="lants-nft__listbtn lants-nft__listbtn--danger"
              onClick={() => onCancel(p)}
              disabled={cancelBusy}
            >
              {cancelBusy ? <Loader2 size={12} className="spin" /> : null}
              {t('stake.cancelListing')}
            </button>
          )}
          {canBuy && onBuy && (
            <button
              type="button"
              className="lants-nft__listbtn"
              onClick={onBuy}
              disabled={buyState?.phase === 'buying'}
            >
              {buyState?.phase === 'buying' ? <Loader2 size={12} className="spin" /> : null}
              {t('stake.buyOnSite')}
            </button>
          )}
          {canOffer && setOfferForm && (
            <button
              type="button"
              className="lants-nft__listbtn"
              onClick={() => setOfferForm({ position: p, price: '', days: 30, phase: null, message: null })}
            >
              {t('stake.makeOffer')}
            </button>
          )}
          {onToggleOffers && (
            <button type="button" className="lants-nft__listbtn" onClick={() => onToggleOffers(p.id)}>
              {t('stake.viewOffers', { n: p.offerCount || 0 })}
            </button>
          )}
          {canSplit && setSplitForm && (
            <button
              type="button"
              className="lants-nft__listbtn"
              onClick={() => setSplitForm({ position: p, amount: '', phase: null, message: null, result: null })}
            >
              {t('stake.splitPosition')}
            </button>
          )}
        </div>
        {cancelState?.id === p.id && cancelState.message && (
          <div style={{ color: cancelState.phase === 'error' ? 'var(--danger)' : 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.25rem' }}>
            {cancelState.message}
          </div>
        )}
        {buyState?.message && (
          <div style={{ color: buyState.phase === 'error' ? 'var(--danger)' : 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.25rem' }}>
            {buyState.message}
          </div>
        )}
        {offersOpen && (
          <div className="lants-nft__offers">
            {offers?.loading && <div className="lants-nft__offers-empty">{t('stake.loadingOffers')}</div>}
            {offers?.error && <div className="lants-nft__offers-empty">{offers.error}</div>}
            {!offers?.loading && offers?.items?.length === 0 && (
              <div className="lants-nft__offers-empty">{t('stake.noOffers')}</div>
            )}
            {(offers?.items || []).map((o) => {
              const mine = address && o.offerer.toLowerCase() === address.toLowerCase();
              const busy = offerActionState?.offerId === o.id && ['accepting', 'cancelling'].includes(offerActionState.phase);
              return (
                <div key={o.id} className="lants-nft__offer-row">
                  <span>{(Number(o.priceWei) / 1e18).toFixed(4)} WETH</span>
                  <span className="lants-nft__offer-addr">{truncateAddress(o.offerer)}</span>
                  {isOwner && (
                    <button type="button" onClick={() => onAcceptOffer(o)} disabled={busy}>
                      {busy ? <Loader2 size={11} className="spin" /> : null}{t('stake.acceptOffer')}
                    </button>
                  )}
                  {mine && !isOwner && (
                    <button type="button" onClick={() => onCancelOffer(o)} disabled={busy}>
                      {busy ? <Loader2 size={11} className="spin" /> : null}{t('stake.cancelOffer')}
                    </button>
                  )}
                  {offerActionState?.offerId === o.id && offerActionState.message && (
                    <div className="lants-nft__offer-msg" style={{ color: offerActionState.phase === 'error' ? 'var(--danger)' : 'var(--text-secondary)' }}>
                      {offerActionState.message}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </figcaption>
    </figure>
  );
}

function ActionModal({ titleKey, position, onClose, children, t }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t(titleKey)} — #{position.id}</h2>
          <button type="button" className="modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          {children}
        </div>
      </div>
    </div>
  );
}

function ListModal({ form, setForm, onConfirm, t }) {
  if (!form) return null;
  const busy = form.phase === 'listing';
  return (
    <ActionModal titleKey="stake.listOnSite" position={form.position} onClose={() => setForm(null)} t={t}>
      <div className="lants-nft__listform">
        <label>
          {t('stake.listPrice')}
          <input
            type="number" min="0" step="0.0001"
            value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value, phase: null })}
          />
        </label>
        <label>
          {t('stake.listDays')}
          <input
            type="number" min="1" max="365"
            value={form.days}
            onChange={(e) => setForm({ ...form, days: Number(e.target.value) || 30, phase: null })}
          />
        </label>
        <button type="button" onClick={() => onConfirm(form.position)} disabled={busy}>
          {busy ? <Loader2 size={12} className="spin" /> : null}
          {t('stake.listConfirm')}
        </button>
        <button type="button" onClick={() => setForm(null)}>{t('stake.listCancel')}</button>
        {form.message && (
          <div style={{ color: form.phase === 'error' ? 'var(--danger)' : 'var(--text-secondary)', gridColumn: '1 / -1' }}>
            {form.message}
          </div>
        )}
      </div>
    </ActionModal>
  );
}

function OfferModal({ form, setForm, onConfirm, t }) {
  if (!form) return null;
  const busy = form.phase === 'offering';
  return (
    <ActionModal titleKey="stake.makeOffer" position={form.position} onClose={() => setForm(null)} t={t}>
      <div className="lants-nft__listform">
        <label>
          {t('stake.offerPrice')}
          <input
            type="number" min="0" step="0.0001"
            value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value, phase: null })}
          />
        </label>
        <label>
          {t('stake.listDays')}
          <input
            type="number" min="1" max="365"
            value={form.days}
            onChange={(e) => setForm({ ...form, days: Number(e.target.value) || 30, phase: null })}
          />
        </label>
        <button type="button" onClick={() => onConfirm(form.position)} disabled={busy}>
          {busy ? <Loader2 size={12} className="spin" /> : null}
          {t('stake.offerConfirm')}
        </button>
        <button type="button" onClick={() => setForm(null)}>{t('stake.listCancel')}</button>
        {form.message && (
          <div style={{ color: form.phase === 'error' ? 'var(--danger)' : 'var(--text-secondary)', gridColumn: '1 / -1' }}>
            {form.message}
          </div>
        )}
      </div>
    </ActionModal>
  );
}

function SplitModal({ form, setForm, onConfirm, t }) {
  if (!form) return null;
  const busy = form.phase === 'splitting';
  const p = form.position;
  const splitAmountNum = Number(form.amount);
  // Either resulting half landing on exactly 1 ANT can't be listed here --
  // the market view hides 1-ANT positions as provider-activation stakes,
  // and there's no on-chain way to tell those apart from a deliberate split.
  const splitWouldMakeUnlistable = splitAmountNum > 0 && splitAmountNum < p.amount
    && (isProviderActivationStake(splitAmountNum) || isProviderActivationStake(p.amount - splitAmountNum));
  return (
    <ActionModal titleKey="stake.splitPosition" position={p} onClose={() => setForm(null)} t={t}>
      <div className="lants-nft__listform">
        <label>
          {t('stake.splitAmount')}
          <input
            type="number" min="0" step="0.000001" max={p.amount}
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value, phase: null })}
          />
        </label>
        <button type="button" onClick={() => onConfirm(p)} disabled={busy}>
          {busy ? <Loader2 size={12} className="spin" /> : null}
          {t('stake.splitConfirm')}
        </button>
        <button type="button" onClick={() => setForm(null)}>{t('stake.listCancel')}</button>
        <div style={{ gridColumn: '1 / -1', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          {t('stake.splitHint', { remaining: formatAnts((p.amount || 0) - splitAmountNum) })}
        </div>
        {splitWouldMakeUnlistable && (
          <div style={{ gridColumn: '1 / -1', fontSize: '0.75rem', color: 'var(--warning)' }}>
            {t('stake.splitUnlistableWarning')}
          </div>
        )}
        {form.message && (
          <div style={{ color: form.phase === 'error' ? 'var(--danger)' : 'var(--text-secondary)', gridColumn: '1 / -1' }}>
            {form.message}
          </div>
        )}
        {form.result?.firstPositionId != null && (
          <div style={{ gridColumn: '1 / -1', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
            {t('stake.splitResult', { first: form.result.firstPositionId, second: form.result.secondPositionId })}
          </div>
        )}
      </div>
    </ActionModal>
  );
}

const localeForLang = (lang) => (lang === 'en' ? 'en-US' : 'zh-CN');
const dateFmt = (d, lang) => (d ? new Date(d).toLocaleDateString(localeForLang(lang), { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

/** Uniswap-V3-style position NFT: unique blobs per id, items printed on the card. */
function LantsNftArt({ position: p, sellerName, state, lockDays, daysRemaining, startDate, endDate, t, lang, listingLabel }) {
  const uid = `lants-${p.id}`;
  const palette = nftPalette(p.agentId, p.id);
  const name = fitName(sellerName, 18);
  const stateLabel = state ? t(`stake.state.${state}`) : '—';
  const remainingLabel = daysRemaining == null
    ? '—'
    : daysRemaining === 0
      ? t('stake.unlocked')
      : t('stake.daysLeft', { n: daysRemaining });

  return (
    <svg
      className="lants-nft__svg"
      viewBox="0 0 290 470"
      role="img"
      aria-label={t('stake.nftAlt', { id: p.id })}
    >
      <defs>
        <clipPath id={`${uid}-clip`}>
          <rect width="290" height="470" rx="42" ry="42" />
        </clipPath>
        <filter id={`${uid}-blur`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="36" />
        </filter>
        <linearGradient id={`${uid}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={palette.bg} />
          <stop offset="100%" stopColor="#0a0a0c" />
        </linearGradient>
      </defs>
      <g clipPath={`url(#${uid}-clip)`}>
        <rect width="290" height="470" fill={`url(#${uid}-bg)`} />
        <circle cx="90" cy="120" r="120" fill={palette.a} filter={`url(#${uid}-blur)`} opacity="0.85" />
        <circle cx="200" cy="150" r="100" fill={palette.b} filter={`url(#${uid}-blur)`} opacity="0.75" />
        <circle cx="150" cy="210" r="90" fill={palette.c} filter={`url(#${uid}-blur)`} opacity="0.7" />
        <rect width="290" height="470" fill="rgba(0,0,0,0.18)" />
      </g>
      <text x="28" y="42" fill="rgba(255,255,255,0.7)" fontSize="13" fontFamily="Geist, system-ui, sans-serif" letterSpacing="0.18em">
        lANTS
      </text>
      <text x="262" y="42" fill="rgba(255,255,255,0.7)" fontSize="13" fontFamily="Geist Mono, ui-monospace, monospace" textAnchor="end">
        {`#${p.id}`}
      </text>
      {/* Uniswap-LP-style: a curve from the start-date pole (top-left) to
          the end-date pole (bottom-right), on a faint x/y axis -- fills
          the card's previously-blank middle, sitting above the name. */}
      <g>
        <line x1="30" y1="86" x2="30" y2="254" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
        <line x1="30" y1="254" x2="260" y2="254" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
        <path
          d="M 34 118 C 110 150, 180 200, 256 238"
          fill="none"
          stroke="rgba(255,255,255,0.6)"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <circle cx="34" cy="118" r="6" fill={palette.a} stroke="#0a0a0c" strokeWidth="2" />
        <circle cx="256" cy="238" r="6" fill={palette.b} stroke="#0a0a0c" strokeWidth="2" />
        <text x="34" y="100" fill="rgba(255,255,255,0.5)" fontSize="8" fontFamily="Geist, system-ui, sans-serif" letterSpacing="0.08em">{t('stake.calStart').toUpperCase()}</text>
        <text x="34" y="112" fill="#ffffff" fontSize="10.5" fontFamily="Geist Mono, ui-monospace, monospace">{dateFmt(startDate, lang)}</text>
        <text x="256" y="260" fill="rgba(255,255,255,0.5)" fontSize="8" fontFamily="Geist, system-ui, sans-serif" letterSpacing="0.08em" textAnchor="end">{t('stake.calEnd').toUpperCase()}</text>
        <text x="256" y="272" fill="#ffffff" fontSize="10.5" fontFamily="Geist Mono, ui-monospace, monospace" textAnchor="end">{dateFmt(endDate, lang)}</text>
      </g>
      <text x="28" y="300" fill="#ffffff" fontSize={name.length > 14 ? 20 : 24} fontWeight="700" fontFamily="Geist, system-ui, sans-serif">
        {name}
      </text>
      <text x="28" y="322" fill="rgba(255,255,255,0.55)" fontSize="12" fontFamily="Geist Mono, ui-monospace, monospace">
        {t('stake.agent', { id: p.agentId })}
      </text>
      <text x="28" y="358" fill="#D79627" fontSize="22" fontWeight="700" fontFamily="Geist, system-ui, sans-serif">
        {`${formatAnts(p.amount)} ANTS`}
      </text>
      <text x="28" y="400" fill="rgba(255,255,255,0.75)" fontSize="13" fontFamily="Geist, system-ui, sans-serif">
        {lockDays != null
          ? `${t('stake.lockedForDays', { n: lockDays })}, ${remainingLabel}`
          : (listingLabel || '—')}
      </text>
      <text x="262" y="448" fill={stateColor(state)} fontSize="12" fontWeight="600" fontFamily="Geist, system-ui, sans-serif" textAnchor="end">
        {stateLabel.toUpperCase()}
      </text>
    </svg>
  );
}

function nftPalette(agentId, positionId) {
  const h1 = ((agentId * 47) + (positionId * 13)) % 360;
  const h2 = (h1 + 38) % 360;
  const h3 = (h1 + 196) % 360;
  return {
    bg: `hsl(${h1}, 42%, 10%)`,
    a: `hsl(${h1}, 78%, 54%)`,
    b: `hsl(${h2}, 82%, 48%)`,
    c: `hsl(${h3}, 70%, 46%)`,
  };
}

/** epoch N starts at genesis + N*epochDuration (seconds) -- mirrors backend/server.js's epochToDate. */
function epochDates(startEpoch, endEpoch, genesis, epochDuration) {
  if (genesis == null || !epochDuration) return { startDate: null, endDate: null, lockDays: null, daysRemaining: null };
  const startDate = startEpoch != null ? new Date((Number(genesis) + startEpoch * epochDuration) * 1000).toISOString() : null;
  const endDate = endEpoch != null ? new Date((Number(genesis) + endEpoch * epochDuration) * 1000).toISOString() : null;
  const lockDays = (startEpoch != null && endEpoch != null) ? Math.round((endEpoch - startEpoch) * epochDuration / 86400) : null;
  const daysRemaining = endDate != null ? Math.max(0, Math.ceil((new Date(endDate).getTime() - Date.now()) / 86400000)) : null;
  return { startDate, endDate, lockDays, daysRemaining };
}

function fitName(name, max) {
  if (!name) return '';
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

function stateColor(state) {
  if (state === 'active') return '#10B981';
  if (state === 'pending') return '#D79627';
  if (state === 'matured') return '#24CD95';
  return 'rgba(255,255,255,0.55)';
}

function FilterChip({ active, onClick, label, href }) {
  return (
    <a
      href={href}
      onClick={(e) => { e.preventDefault(); onClick(); }}
      style={{
        padding: '0.35rem 0.85rem',
        borderRadius: '999px',
        border: active ? '1px solid var(--accent)' : '1px solid var(--border)',
        background: active ? 'var(--accent-dim)' : 'var(--bg-secondary)',
        color: active ? 'var(--accent)' : 'var(--text-secondary)',
        fontSize: '0.8125rem',
        fontWeight: 600,
        cursor: 'pointer',
        textDecoration: 'none',
        display: 'inline-block',
      }}
    >
      {label}
    </a>
  );
}

function TradeHistoryPanel({ trades, loading, error, page, pageSize, onPageChange, t, lang }) {
  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
        <Loader2 size={24} className="spin" />
        <p style={{ marginTop: '0.75rem', fontSize: '0.875rem' }}>{t('stake.historyLoading')}</p>
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--warning)', fontSize: '0.875rem' }}>
        <AlertCircle size={14} />
        <span>{t('stake.historyError')}</span>
      </div>
    );
  }
  const rows = trades?.trades || [];
  if (rows.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
        {t('stake.noTrades')}
      </div>
    );
  }
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table className="table" style={{ minWidth: '720px' }}>
          <thead>
            <tr>
              <th>#</th>
              <th>{t('stake.tradeType')}</th>
              <th>{t('stake.tradeSeller')}</th>
              <th>{t('stake.tradeBuyer')}</th>
              <th>{t('stake.tradePrice')}</th>
              <th>{t('stake.tradeAmount')}</th>
              <th>{t('stake.tradeDate')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((tr) => (
              <tr key={tr.id}>
                <td>#{tr.tokenId}</td>
                <td>{tr.tradeType === 'offer' ? t('stake.tradeOffer') : t('stake.tradeListing')}</td>
                <td style={{ fontFamily: 'monospace' }}>{truncateAddress(tr.seller)}</td>
                <td style={{ fontFamily: 'monospace' }}>{truncateAddress(tr.buyer)}</td>
                <td>{(Number(tr.priceWei) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 6 })} {tr.currency}</td>
                <td>{tr.amount != null ? formatAnts(tr.amount) : '—'}</td>
                <td>{dateFmt(tr.createdAt, lang)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(trades?.total || 0) > pageSize && (
        <MarketPager page={page} pageSize={pageSize} total={trades.total} onChange={onPageChange} t={t} />
      )}
    </>
  );
}

function MarketPager({ page, pageSize, total, onChange, t }) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="lants-pager">
      <button type="button" onClick={() => onChange(Math.max(1, page - 1))} disabled={page <= 1}>
        {t('stake.pagePrev')}
      </button>
      <span>{t('stake.pageOf', { page, count: pageCount })}</span>
      <button type="button" onClick={() => onChange(Math.min(pageCount, page + 1))} disabled={page >= pageCount}>
        {t('stake.pageNext')}
      </button>
    </div>
  );
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>{label}</div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: accent || 'var(--text-primary)' }}>{value}</div>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>{sub}</div>
    </div>
  );
}

export default StakeANTS;
