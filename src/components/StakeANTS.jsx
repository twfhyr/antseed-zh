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
  splitPosition, mergePositions, movePosition, isProviderActivationStake,
  USDC_BASE, WETH_BASE,
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
// Implied MC/FDV are always large (supply * a per-ANTS price), so they need
// M/B suffixes rather than formatUsd's full-precision output.
const formatUsdCompact = (n) => {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return formatUsd(n);
};
// Every new offer/listing/trade is USDC (6 decimals) as of 2026-09-21, but
// a handful of offers/trades made before that switch are still WETH
// (18 decimals) -- they're still perfectly fulfillable (fulfillOrder()
// doesn't care what token an old signed order names), so old rows are kept
// rather than hidden, just formatted using their own recorded decimals
// instead of assuming everything is 6.
const CURRENCY_DECIMALS = { USDC: 6, WETH: 18, ETH: 18 };
const formatTradeAmount = (priceWei, currency) => {
  const decimals = CURRENCY_DECIMALS[currency] ?? 18;
  const n = Number(priceWei) / 10 ** decimals;
  return `${n.toLocaleString(undefined, { maximumFractionDigits: decimals === 6 ? 2 : 6 })} ${currency || ''}`.trim();
};
// An offer row's `weth` field is really just "whatever ERC20 token address
// this offer's payment item names" (the DB column predates the USDC
// switch) -- map it back to a symbol for display instead of assuming USDC.
const currencyForToken = (addr) => {
  if (!addr) return '';
  const a = addr.toLowerCase();
  if (a === USDC_BASE.toLowerCase()) return 'USDC';
  if (a === WETH_BASE.toLowerCase()) return 'WETH';
  return '';
};

// Listings/offers created on this site are USDC-denominated (see
// src/lib/listLants.js), so the total is already a real USD amount, not a
// converted one -- just show it directly. Deliberately never renders a raw
// ETH amount: a listing scraped from OpenSea (backend/opensea-lants.js) can
// still carry an ETH `unit`/`symbol`, but this site shows every price as a
// USD total everywhere, including those, per the no-ETH-anywhere rule.
const formatListing = (listing) => (listing?.usd != null ? formatUsd(listing.usd) : '—');

function sellerForAgent(sellers, agentId) {
  if (agentId == null) return null;
  const id = String(agentId);
  return sellers.find((s) => s.agentId != null && String(s.agentId) === id) || null;
}

// mergeStakes() on-chain requires every source position to land on the exact
// same restructured start/end epoch after closing, which in practice only
// happens for positions that already share both epochs (same agent, same
// lock window) -- this mirrors the Stakers page's own "same locked time"
// grouping rather than trying to replicate the contract's restructure math
// client-side. Positions that are listed or are 1-ANTS provider-activation
// stakes can't be merged (same rule as split/list) so they never get a key.
function mergeGroupKey(p) {
  if (p.listed || isProviderActivationStake(p.amount)) return null;
  if (p.agentId == null || p.stakeStartEpoch == null || p.stakeEndEpoch == null) return null;
  return `${p.agentId}|${p.stakeStartEpoch}|${p.stakeEndEpoch}`;
}

// Groups the caller's own positions by mergeGroupKey -- a group of 2+ is
// shown as one mergeable cluster on the Mine tab; anything left alone
// (unique lock window, listed, or a 1-ANTS activation stake) renders as a
// plain standalone card with no merge affordance at all. Moving a position
// away (new agentId) or merging it (new lock window/epoch) naturally drops
// it out of its old group and, if that leaves a former partner alone, that
// partner just stops appearing in any group next render -- there's no
// separate "undo the group" step needed, the grouping is recomputed fresh
// from myPositions every time.
function groupMyPositions(myPositions) {
  const groups = new Map();
  for (const p of myPositions) {
    const key = mergeGroupKey(p);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const grouped = new Set();
  const blocks = [];
  for (const [key, items] of groups) {
    if (items.length < 2) continue;
    const sorted = [...items].sort((a, b) => a.id - b.id);
    sorted.forEach((p) => grouped.add(p.id));
    blocks.push({ type: 'group', key, items: sorted });
  }
  for (const p of myPositions) {
    if (!grouped.has(p.id)) blocks.push({ type: 'single', item: p });
  }
  const minId = (b) => (b.type === 'group' ? b.items[0].id : b.item.id);
  blocks.sort((a, b) => minId(a) - minId(b));
  return blocks;
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
  const [marketTab, setMarketTab] = useMarketTabRouter(); // 'listed' | 'all' | 'mine' -- URL-driven, see /lants/sales|all|mine
  const [marketPage, setMarketPage] = useState(1);
  // Defaults to per-ANTS price (cheapest first) rather than id -- the same
  // "rank by unit price, not by total" convention a BRC-20 marketplace
  // uses, and the one this page's own sort already implements server-side
  // (paginateMarketItems's 'price' sorter keys off listing.perAntUsd, never
  // the total listed price -- see docs/ARCHITECTURE.md).
  const [marketSort, setMarketSort] = useState('price');
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
  const [mergeSelected, setMergeSelected] = useState(() => new Set()); // position ids checked for merging, across all groups
  const [mergeState, setMergeState] = useState(null); // { ids, phase, message, result } -- last merge action's status
  const [moveForm, setMoveForm] = useState(null); // { position, toAgentId, phase, message, result }
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

  // The caller's full position list (uncapped by the active tab/page/filters)
  // -- this drives the whole Mine tab now (grouping needs every position,
  // not just whatever page happens to be open). Refetched whenever the
  // wallet changes or a merge/move actually completes (see doMergeSelected/
  // doMove). `force` asks the backend for a synchronous on-chain refresh
  // instead of its normal 90s cache -- only needed as a fallback when the
  // action's own market refresh failed outright (see below).
  //
  // Real bug found while building this: doMergeSelected/doMove used to
  // fire this alongside their own `wait=1` market refresh (not after it),
  // so this request could win the race and return first with the OLD
  // data -- a position that had just moved/merged away could keep showing
  // as a live merge candidate for a few seconds. Fixed by chaining this
  // call in a `.then()` after that refresh resolves instead: no `force`
  // needed there either, since the other call's `wait=1` already forced a
  // full recompute into the shared (not owner-scoped) server-side cache,
  // and that write completes before its response is even sent -- so by
  // the time this fires, a plain cached read is already current. `force`
  // is reserved for the `.catch()` path, where that recompute may not
  // have happened at all.
  const [myPositions, setMyPositions] = useState([]);
  const refreshMyPositions = useCallback(({ force = false } = {}) => {
    if (!address) { setMyPositions([]); return Promise.resolve(); }
    return fetchLantsMarket({ owner: address, pageSize: 100, sort: 'id', wait: force ? '1' : undefined })
      .then((data) => setMyPositions(data?.items || []))
      .catch(() => {});
  }, [address]);
  useEffect(() => { refreshMyPositions(); }, [refreshMyPositions]);

  // Mine tab's own render list: myPositions clustered into mergeable groups
  // (2+ positions, same seller, same lock window) plus everything else as
  // standalone cards -- see groupMyPositions' own comment. Recomputed fresh
  // on every myPositions change, so a group dissolves/reforms automatically
  // the moment a member is split/merged/moved away, without any extra state.
  const mineBlocks = useMemo(() => groupMyPositions(myPositions), [myPositions]);

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
    // The form collects a per-ANTS price (like a BRC-20 marketplace) -- the
    // actual Seaport order still needs one flat total, computed here rather
    // than asking the user to do the multiplication themselves.
    const perAnt = Number(listForm?.price);
    if (!(perAnt > 0)) {
      setListForm((f) => ({ ...f, phase: 'error', message: t('stake.listPriceInvalid') }));
      return;
    }
    const totalUsdc = perAnt * position.amount;
    try {
      setListForm((f) => ({ ...f, phase: 'listing', message: t('stake.listing') }));
      await createAndPostListing({
        walletClient,
        account: address,
        contract,
        tokenId: position.id,
        priceUsdc: totalUsdc,
        durationDays: listForm?.days || 30,
      });
      // Real bug reported live: the modal used to stay open on a 'done'
      // phase forever (needing a manual close) AND the Mine tab kept
      // showing "List here" afterward, because this never refreshed
      // myPositions -- Mine renders from that list (see groupMyPositions),
      // not from the `market` state this was already updating. Closing
      // the form here is the confirmation (the card itself now shows
      // "Cancel listing" and the price once myPositions lands) instead of
      // a popup the user has to notice and dismiss themselves.
      setListForm(null);
      fetchLantsMarket({ ...marketQuery, wait: '1' })
        .then((data) => { setMarket(data); return refreshMyPositions(); })
        .catch(() => refreshMyPositions({ force: true }));
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
          priceWei: result.priceWei, currency: 'USDC', txHash: result.hash,
        }).catch(() => {});
      }
      // A direct Seaport fulfillment never touches this backend, so the
      // cached (Antscan-sourced) owner can still say "seller" for a while
      // after a real sale -- force a real on-chain read of this id right
      // now instead of leaving it to show as for-sale until Antscan reindexes.
      // Also refreshes myPositions: the buyer just gained a new position,
      // which needs to show up if they go check the Mine tab.
      fetchLantsMarket({ ...marketQuery, wait: '1', ensureIds: String(position.id) })
        .then((data) => { setMarket(data); return refreshMyPositions(); })
        .catch(() => refreshMyPositions({ force: true }));
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
      // Same staleness bug as doList: Mine renders from myPositions, not
      // from `market`, so cancelling a listing needs this too or the card
      // keeps showing "Cancel listing" / the old price after it's gone.
      fetchLantsMarket({ ...marketQuery, wait: '1' })
        .then((data) => { setMarket(data); return refreshMyPositions(); })
        .catch(() => refreshMyPositions({ force: true }));
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
      // ensureIds handling). Also refreshes myPositions -- same staleness
      // bug as doList/doCancel, Mine renders from that list, not `market`.
      const ensureIds = [result.firstPositionId, result.secondPositionId].filter((x) => x != null).join(',');
      fetchLantsMarket({ ...marketQuery, wait: '1', ensureIds })
        .then((data) => { setMarket(data); return refreshMyPositions(); })
        .catch(() => refreshMyPositions({ force: true }));
    } catch (e) {
      setSplitForm((f) => ({ ...f, phase: 'error', message: e.shortMessage || e.message }));
    }
  };

  const toggleMergeSelect = (id) => {
    setMergeSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // No modal here on purpose: unlike List/Offer/Move, a merge needs no extra
  // input beyond "which ones" -- that's exactly what the group's checkboxes
  // already capture, so checking 2+ boxes and pressing the group's own
  // "Merge selected" button (see MergeGroup below) is the whole flow.
  const doMergeSelected = async (ids) => {
    const poolsAddr = market?.contract;
    if (!walletClient || !address || !poolsAddr) {
      setMergeState({ ids, phase: 'error', message: t('stake.buyNeedWallet') });
      return;
    }
    if (ids.length < 2) return;
    try {
      setMergeState({ ids, phase: 'merging', message: t('stake.merging') });
      const result = await mergePositions({ walletClient, account: address, poolsAddress: poolsAddr, positionIds: ids });
      setMergeState({ ids, phase: 'done', message: t('stake.mergeOk'), result });
      setMergeSelected((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
      // Same reason as doSplit's ensureIds: the new position won't be in
      // Antscan's cache yet, and neither should the merged-away sources
      // still show as open -- force a real on-chain read of all of them.
      // refreshMyPositions is chained AFTER this resolves (not fired
      // alongside it) so the Mine grid's grouping can't read a stale
      // myPositions snapshot that still shows an already-merged-away
      // source as a live candidate -- see refreshMyPositions's own comment.
      const ensureIds = [...ids, result.newPositionId].filter((x) => x != null).join(',');
      // The .then() case doesn't need force:true on the follow-up read --
      // fetchLantsMarket's wait=1 above already forced a full recompute and
      // that (shared, not owner-scoped) cache write completes before this
      // response is even sent, so the very next request lands well inside
      // its 90s freshness window regardless. force:true is only for the
      // .catch() fallback, where that recompute may not have happened at
      // all and this read is the only chance to get current data.
      fetchLantsMarket({ ...marketQuery, wait: '1', ensureIds })
        .then((data) => { setMarket(data); return refreshMyPositions(); })
        .catch(() => refreshMyPositions({ force: true }));
    } catch (e) {
      setMergeState({ ids, phase: 'error', message: e.shortMessage || e.message });
    }
  };

  const doMove = async (position) => {
    const poolsAddr = market?.contract;
    const toAgentId = moveForm?.toAgentId;
    if (!walletClient || !address || !poolsAddr) {
      setMoveForm((f) => ({ ...(f || { position, toAgentId: null }), phase: 'error', message: t('stake.buyNeedWallet') }));
      return;
    }
    if (!toAgentId) {
      setMoveForm((f) => ({ ...f, phase: 'error', message: t('stake.movePickProvider') }));
      return;
    }
    try {
      setMoveForm((f) => ({ ...f, phase: 'moving', message: t('stake.moving') }));
      const result = await movePosition({
        walletClient, account: address, poolsAddress: poolsAddr,
        positionId: position.id, toAgentId,
      });
      setMoveForm({ position, toAgentId, phase: 'done', message: t('stake.moveOk'), result });
      const ensureIds = [position.id, result.newPositionId].filter((x) => x != null).join(',');
      // See doMergeSelected's comment: refreshMyPositions is chained after
      // this resolves, not fired in parallel with it, so a sibling position
      // still sharing this one's old lock window can't briefly keep showing
      // "eligible to merge" against a position that just moved away.
      fetchLantsMarket({ ...marketQuery, wait: '1', ensureIds })
        .then((data) => { setMarket(data); return refreshMyPositions(); })
        .catch(() => refreshMyPositions({ force: true }));
    } catch (e) {
      setMoveForm((f) => ({ ...f, phase: 'error', message: e.shortMessage || e.message }));
    }
  };

  const doMakeOffer = async (position) => {
    const contract = market?.contract;
    if (!walletClient || !address || !contract) {
      setOfferForm((f) => ({ ...(f || { position, price: '', days: 30 }), phase: 'error', message: t('stake.buyNeedWallet') }));
      return;
    }
    if (offerForm?.blocked) return; // already has an open offer -- see openOfferModal
    const perAnt = Number(offerForm?.price);
    if (!(perAnt > 0)) {
      setOfferForm((f) => ({ ...f, phase: 'error', message: t('stake.offerPriceInvalid') }));
      return;
    }
    const totalUsdc = perAnt * position.amount;
    try {
      setOfferForm((f) => ({ ...f, phase: 'offering', message: t('stake.offering') }));
      await makeOffer({
        walletClient, account: address, contract, tokenId: position.id,
        priceUsdc: totalUsdc, durationDays: offerForm?.days || 30,
      });
      // Same fix as doList: close on success instead of lingering on a
      // 'done' phase -- the "Offers (N)" count updating on the card is the
      // confirmation.
      setOfferForm(null);
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

  // "Make offer" doesn't open the form directly -- it checks first whether
  // the connected address already has an open offer on this token (the
  // backend also rejects a second one at submit time, see /api/lants/offer,
  // but checking here means the person sees why immediately instead of
  // after filling out the whole form). Fails open on a network hiccup: a
  // failed check shouldn't block a legitimate first offer.
  const openOfferModal = async (p) => {
    setOfferForm({ position: p, price: '', days: 30, phase: 'checking', message: t('stake.offerChecking'), blocked: false });
    let existing = [];
    try {
      const { offers } = await fetchLantsOffers(p.id);
      existing = offers || [];
      setOffersById((m) => ({ ...m, [p.id]: { loading: false, items: existing, error: null } }));
    } catch { /* fail open -- see comment above */ }
    const mine = address && existing.find((o) => o.offerer.toLowerCase() === address.toLowerCase());
    if (mine) {
      setOfferForm({ position: p, price: '', days: 30, phase: 'error', message: t('stake.offerAlreadyExists'), blocked: true });
      return;
    }
    setOfferForm({ position: p, price: '', days: 30, phase: null, message: null, blocked: false });
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
      // The accepting side just sold the position away -- refresh
      // myPositions too, or it keeps showing up as theirs on the Mine tab.
      fetchLantsMarket({ ...marketQuery, wait: '1' })
        .then((data) => { setMarket(data); return refreshMyPositions(); })
        .catch(() => refreshMyPositions({ force: true }));
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

  // Shared by both the listed/all grid (below) and the Mine tab's grouped/
  // standalone cards -- one place for the ownership/listing/activation-stake
  // checks every action's gating already depended on, instead of three
  // near-identical copies. `market` must exist by the time this is called
  // (both render paths already guard on it).
  const commonCardProps = (p) => ({
    seller: p.sellerName ? { name: p.sellerName } : sellerForAgent(sellers, p.agentId),
    currentEpoch: market?.currentEpoch,
    genesis: market.genesis,
    epochDuration: market.epochDuration,
    poolsAddress,
    t, lang,
    listing: p.listing,
    setListForm,
    canList: !!(isConnected && address && p.owner && address.toLowerCase() === p.owner.toLowerCase() && !p.listed && !isProviderActivationStake(p.amount)),
    onBuy: () => doBuy(p),
    canBuy: !!(isConnected && address && p.owner && address.toLowerCase() !== p.owner.toLowerCase() && p.listed && p.fulfillableHere),
    buyState: buyState?.id === p.id ? buyState : null,
    isOwner: !!(isConnected && address && p.owner && address.toLowerCase() === p.owner.toLowerCase()),
    address,
    onCancel: doCancel,
    cancelState: cancelState?.id === p.id ? cancelState : null,
    onOpenOffer: openOfferModal,
    canOffer: marketTab !== 'mine' && !!(isConnected && address && p.owner && address.toLowerCase() !== p.owner.toLowerCase() && !isProviderActivationStake(p.amount)),
    offersOpen: offersOpenFor === p.id,
    offers: offersById[p.id],
    onToggleOffers: toggleOffers,
    onAcceptOffer: doAcceptOffer,
    onCancelOffer: doCancelOffer,
    offerActionState,
    setSplitForm,
    canSplit: !!(isConnected && address && p.owner && address.toLowerCase() === p.owner.toLowerCase() && !p.listed && !isProviderActivationStake(p.amount) && p.amount > 1),
    setMoveForm,
    canMove: !!(isConnected && address && p.owner && address.toLowerCase() === p.owner.toLowerCase() && !p.listed && !isProviderActivationStake(p.amount)),
  });

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
                    <StatCard label={t('stake.impliedMc')} value={formatUsdCompact(market.floorImpliedMcUsd)} sub="" />
                    <StatCard label={t('stake.impliedFdv')} value={formatUsdCompact(market.floorImpliedFdvUsd)} sub="" />
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
              ) : marketTab === 'mine' ? (
              <>
              {/* Kept here (outside any one group) rather than inside
                  MergeGroup, since a successful merge removes its own
                  source positions from myPositions on refresh -- the group
                  that triggered it can vanish or reshuffle a moment later,
                  which would otherwise take a same-scoped status message
                  down with it before anyone could read it. */}
              {mergeState?.message && (
                <div style={{ fontSize: '0.8125rem', color: mergeState.phase === 'error' ? 'var(--danger)' : 'var(--text-secondary)', margin: '0 0 1rem' }}>
                  {mergeState.message}
                  {mergeState.phase === 'done' && mergeState.result?.newPositionId != null
                    && ` — ${t('stake.mergeResult', { id: mergeState.result.newPositionId })}`}
                </div>
              )}
              {mineBlocks.length === 0 && (
                <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', margin: '1rem 0' }}>
                  {t('stake.mineEmpty')}
                </div>
              )}
              {mineBlocks.length > 0 && (
                <div className="lants-nft-grid">
                  {mineBlocks.map((block) => block.type === 'single' ? (
                    <LantsNftCard key={`m-${block.item.id}`} position={block.item} {...commonCardProps(block.item)} />
                  ) : (
                    <MergeGroup
                      key={`g-${block.key}`}
                      items={block.items}
                      selected={mergeSelected}
                      onToggle={toggleMergeSelect}
                      mergeState={mergeState}
                      onMerge={doMergeSelected}
                      cardProps={commonCardProps}
                      t={t}
                    />
                  ))}
                </div>
              )}
              </>
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
                  {t('stake.noneMatch')}
                </div>
              )}
              {marketItems.length > 0 && (
                <div className="lants-nft-grid">
                  {marketItems.map((p) => (
                    <LantsNftCard key={`m-${p.id}`} position={p} {...commonCardProps(p)} />
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
      <MoveModal form={moveForm} setForm={setMoveForm} onConfirm={doMove} sellers={sellers} t={t} />
    </div>
  );
}

function LantsNftCard({
  position: p, seller, currentEpoch, genesis, epochDuration, t, lang, listing, setListForm, canList, onBuy, canBuy, buyState,
  activation, isOwner, address, onCancel, cancelState, onOpenOffer, canOffer,
  offersOpen, offers, onToggleOffers, onAcceptOffer, onCancelOffer, offerActionState,
  setSplitForm, canSplit, setMoveForm, canMove, mergeCheckbox,
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
        {mergeCheckbox && (
          <label className="lants-nft__mergecheck">
            <input type="checkbox" checked={mergeCheckbox.checked} onChange={mergeCheckbox.onToggle} />
            {t('stake.mergeSelect')}
          </label>
        )}
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
          {canOffer && onOpenOffer && (
            <button
              type="button"
              className="lants-nft__listbtn"
              onClick={() => onOpenOffer(p)}
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
          {canMove && setMoveForm && (
            <button
              type="button"
              className="lants-nft__listbtn"
              onClick={() => setMoveForm({ position: p, toAgentId: '', phase: null, message: null, result: null })}
            >
              {t('stake.movePosition')}
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
                  <span>{formatTradeAmount(o.priceWei, currencyForToken(o.weth))}</span>
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
  const perAnt = Number(form.price);
  const total = perAnt > 0 ? perAnt * (form.position.amount || 0) : null;
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
        {total != null && (
          <div style={{ gridColumn: '1 / -1', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
            {t('stake.totalPrice', { total: formatUsd(total), amount: formatAnts(form.position.amount) })}
          </div>
        )}
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
  const busy = form.phase === 'offering' || form.phase === 'checking';
  const perAnt = Number(form.price);
  const total = perAnt > 0 ? perAnt * (form.position.amount || 0) : null;
  return (
    <ActionModal titleKey="stake.makeOffer" position={form.position} onClose={() => setForm(null)} t={t}>
      <div className="lants-nft__listform">
        <label>
          {t('stake.offerPrice')}
          <input
            type="number" min="0" step="0.0001"
            value={form.price}
            disabled={form.blocked}
            onChange={(e) => setForm({ ...form, price: e.target.value, phase: null })}
          />
        </label>
        <label>
          {t('stake.listDays')}
          <input
            type="number" min="1" max="365"
            value={form.days}
            disabled={form.blocked}
            onChange={(e) => setForm({ ...form, days: Number(e.target.value) || 30, phase: null })}
          />
        </label>
        {total != null && (
          <div style={{ gridColumn: '1 / -1', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
            {t('stake.totalPrice', { total: formatUsd(total), amount: formatAnts(form.position.amount) })}
          </div>
        )}
        <button type="button" onClick={() => onConfirm(form.position)} disabled={busy || form.blocked}>
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
  // Either resulting half landing on exactly 1 ANTS can't be listed here --
  // the market view hides 1-ANTS positions as provider-activation stakes,
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

// One mergeable cluster on the Mine tab: every position sharing the same
// seller + lock window, rendered together with a checkbox per card instead
// of each card getting its own "Merge" button (see groupMyPositions). Any
// 2+ checked here can be merged directly -- there's no fixed "base"
// position the way the old per-card modal anchored on one -- so this has
// no modal step of its own, just an inline "Merge selected" action, the
// same directness as Cancel/Buy elsewhere on this page.
function MergeGroup({ items, selected, onToggle, mergeState, onMerge, cardProps, t }) {
  const selectedIds = items.map((p) => p.id).filter((id) => selected.has(id));
  const totalAmount = items.reduce((sum, p) => sum + (p.amount || 0), 0);
  const selectedTotal = items.filter((p) => selected.has(p.id)).reduce((sum, p) => sum + (p.amount || 0), 0);
  const busy = mergeState?.phase === 'merging' && selectedIds.some((id) => mergeState.ids.includes(id));
  const seller = items[0].sellerName ? { name: items[0].sellerName } : null;
  const sellerLabel = seller?.name || t('stake.agent', { id: items[0].agentId });
  return (
    <div className="lants-merge-group">
      <div className="lants-merge-group__header">
        <span>{t('stake.mergeGroupLabel', { n: items.length })} — <strong>{sellerLabel}</strong></span>
        <span>{t('stake.mergeGroupTotal', { total: formatAnts(totalAmount) })}</span>
      </div>
      <div className="lants-nft-grid">
        {items.map((p) => (
          <LantsNftCard
            key={`m-${p.id}`}
            position={p}
            {...cardProps(p)}
            mergeCheckbox={{ checked: selected.has(p.id), onToggle: () => onToggle(p.id) }}
          />
        ))}
      </div>
      <div className="lants-merge-group__actions">
        <button type="button" onClick={() => onMerge(selectedIds)} disabled={selectedIds.length < 2 || busy}>
          {busy ? <Loader2 size={12} className="spin" /> : null}
          {t('stake.mergeSelectedConfirm', { n: selectedIds.length })}
        </button>
        {selectedIds.length >= 2 && (
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            {t('stake.mergeHint', { total: formatAnts(selectedTotal) })}
          </span>
        )}
      </div>
    </div>
  );
}

function MoveModal({ form, setForm, onConfirm, sellers, t }) {
  if (!form) return null;
  const busy = form.phase === 'moving';
  const p = form.position;
  const targets = sellers.filter((s) => String(s.agentId) !== String(p.agentId));
  return (
    <ActionModal titleKey="stake.movePosition" position={p} onClose={() => setForm(null)} t={t}>
      <div className="lants-nft__listform">
        <label>
          {t('stake.moveTarget')}
          <select
            value={form.toAgentId}
            onChange={(e) => setForm({ ...form, toAgentId: e.target.value, phase: null })}
          >
            <option value="">{t('stake.moveChooseProvider')}</option>
            {targets.map((s) => (
              <option key={s.agentId} value={s.agentId}>{s.name || t('stake.agent', { id: s.agentId })}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => onConfirm(p)} disabled={busy}>
          {busy ? <Loader2 size={12} className="spin" /> : null}
          {t('stake.moveConfirm')}
        </button>
        <button type="button" onClick={() => setForm(null)}>{t('stake.listCancel')}</button>
        <div style={{ gridColumn: '1 / -1', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          {t('stake.moveHint')}
        </div>
        {form.message && (
          <div style={{ color: form.phase === 'error' ? 'var(--danger)' : 'var(--text-secondary)', gridColumn: '1 / -1' }}>
            {form.message}
          </div>
        )}
        {form.result?.newPositionId != null && (
          <div style={{ gridColumn: '1 / -1', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
            {t('stake.moveResult', { id: form.result.newPositionId })}
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
                <td>{formatTradeAmount(tr.priceWei, tr.currency)}</td>
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
