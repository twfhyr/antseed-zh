import { useCallback, useEffect, useState } from 'react';

// Tabs <-> URL path segments, e.g. /buyers, /zh/sellers. 'overview' is the
// default and maps to the bare base path so the root URL still works.
const TAB_PATHS = {
  overview: '',
  buyers: 'buyers',
  sellers: 'sellers',
  services: 'services',
  tokenomics: 'tokenomics',
  'ants-info': 'ants-info',
  stake: 'iants',
  stakers: 'stakers',
  rewards: 'rewards',
  about: 'about',
};
const PATH_TABS = Object.fromEntries(
  Object.entries(TAB_PATHS).filter(([, p]) => p).map(([tab, p]) => [p, tab])
);
const VALID_TABS = new Set(Object.keys(TAB_PATHS));

// import.meta.env.BASE_URL is '/' on the root domain build and '/zh/' on the
// legacy path-prefixed build (see vite.config.js) — stripping/re-adding it
// here is what lets the exact same router code produce antseed-zh.com/buyers
// and 5.223.54.56:8088/zh/buyers.
const BASE = import.meta.env.BASE_URL.endsWith('/')
  ? import.meta.env.BASE_URL
  : `${import.meta.env.BASE_URL}/`;

function tabFromLocation() {
  const path = window.location.pathname;
  const rel = path.startsWith(BASE) ? path.slice(BASE.length) : path.replace(/^\//, '');
  const segment = rel.split('/')[0] || '';
  const tab = PATH_TABS[segment];
  return tab && VALID_TABS.has(tab) ? tab : 'overview';
}

function urlForTab(tab) {
  const segment = TAB_PATHS[tab] ?? '';
  return `${BASE}${segment}`;
}

// Exported so nav links can render real `href`s (right-click "copy link",
// middle-click to open in a new tab, hover preview in the status bar all
// need an actual URL, not just an onClick handler).
export const tabHref = urlForTab;

/**
 * Drives the active tab from the URL path instead of purely in-memory state,
 * so every section has a shareable, bookmarkable, reload-safe link:
 *   antseed-zh.com/buyers, antseed-zh.com/tokenomics, .../zh/sellers, etc.
 * Falls back to 'overview' for any unknown path (the server's catch-all
 * already serves index.html for these — see backend/server.js — so a fresh
 * load of an unrecognized deep link still renders the app instead of 404s).
 */
export function useTabRouter() {
  const [activeTab, setActiveTabState] = useState(tabFromLocation);

  useEffect(() => {
    const onPopState = () => setActiveTabState(tabFromLocation());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const setActiveTab = useCallback((tab) => {
    if (!VALID_TABS.has(tab)) return;
    setActiveTabState(tab);
    const url = urlForTab(tab);
    if (window.location.pathname !== url) {
      window.history.pushState(null, '', url);
    }
  }, []);

  return [activeTab, setActiveTab];
}

// ─── lANTS tab's market sub-tab (/iants/sales, /iants/all, /iants/mine) ───
// A second path segment under 'iants' only, so a filtered view of the lANTS
// market is itself a shareable/bookmarkable link. Bare /iants (no second
// segment) stays a valid alias for the default sub-tab, same pattern as
// 'ants-info' above for the top-level tabs.
//
// The tab's own URL segment is 'iants' (2026-09-21, was 'stake') -- lowercase
// L reading as a capital i, matching how "iants" was already used here for
// the "All NFTs" sub-tab before the rename. That sub-tab's own segment was
// renamed sales/'iants'/mine/history -> sales/all/mine/history so it no
// longer collides with the parent (a literal /iants/iants would otherwise
// result); the tab key ('all') is unchanged, only its own URL segment moved.
const MARKET_TAB_PATHS = { listed: 'sales', all: 'all', mine: 'mine', history: 'history' };
const MARKET_PATH_TABS = Object.fromEntries(
  Object.entries(MARKET_TAB_PATHS).map(([tab, p]) => [p, tab])
);
const MARKET_DEFAULT_TAB = 'listed';

function marketTabFromLocation() {
  const path = window.location.pathname;
  const rel = path.startsWith(BASE) ? path.slice(BASE.length) : path.replace(/^\//, '');
  const [first, second] = rel.split('/');
  if (first !== 'iants') return null;
  return MARKET_PATH_TABS[second] || null;
}

export function marketTabHref(tab) {
  const segment = MARKET_TAB_PATHS[tab] || MARKET_TAB_PATHS[MARKET_DEFAULT_TAB];
  return `${BASE}iants/${segment}`;
}

/**
 * Drives the lANTS market's tab (For sale / All NFTs / Mine) from the URL's
 * second path segment, same shareable-link rationale as useTabRouter. Only
 * meaningful while the lANTS tab itself is mounted -- StakeANTS.jsx only
 * exists in the tree when activeTab === 'stake' (internal key unchanged;
 * only its URL segment and nav label changed), so every call here is
 * implicitly scoped to that.
 */
export function useMarketTabRouter() {
  const [marketTab, setMarketTabState] = useState(() => marketTabFromLocation() || MARKET_DEFAULT_TAB);

  useEffect(() => {
    const onPopState = () => setMarketTabState(marketTabFromLocation() || MARKET_DEFAULT_TAB);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const setMarketTab = useCallback((tab) => {
    if (!MARKET_TAB_PATHS[tab]) return;
    setMarketTabState(tab);
    const url = marketTabHref(tab);
    if (window.location.pathname !== url) {
      window.history.pushState(null, '', url);
    }
  }, []);

  return [marketTab, setMarketTab];
}
