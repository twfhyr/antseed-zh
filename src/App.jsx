import React, { useState, useEffect } from 'react';
import SellersList from './components/SellersList';
import ServicesList from './components/ServicesList';
import BuyersList from './components/BuyersList';
import TokenomicsTab from './components/TokenomicsTab';
import ANTSInfo from './components/ANTSInfo';
import StakeANTS from './components/StakeANTS';
import Overview from './components/Overview';
import About from './components/About';
import Header from './components/Header';
import DepositModal from './components/DepositModal';
import WithdrawModal from './components/WithdrawModal';
import { AuthorizedWalletProvider } from './context/AuthorizedWalletContext';
import { useAccount } from 'wagmi';
import { useI18n } from './i18n/index.jsx';
import { useTabRouter, tabHref } from './hooks/useTabRouter';
import { useBuildFreshness } from './hooks/useBuildFreshness';
import { fetchStats, fetchBuyers, fetchSellers, fetchServices, fetchDepositsBalance, fetchDepositsConfig } from './api';

function AppInner() {
const { address } = useAccount();
const { t } = useI18n();
// Auto-reloads this tab when a newer build is live (checked on tab
// refocus + a 5min fallback) — see src/hooks/useBuildFreshness.js. Added
// so testing a deployed change doesn't require a manual hard refresh.
useBuildFreshness();
// URL-driven instead of plain useState: gives every tab a shareable,
// bookmarkable link (e.g. antseed-zh.com/buyers) and makes browser
// back/forward switch tabs. See src/hooks/useTabRouter.js.
const [activeTab, setActiveTab] = useTabRouter();
const [depositOpen, setDepositOpen] = useState(false);
const [withdrawOpen, setWithdrawOpen] = useState(false);
const [withdrawBalance, setWithdrawBalance] = useState(null);
const [buyerAddress, setBuyerAddress] = useState(null);
const [buyers, setBuyers] = useState([]);
const [sellers, setSellers] = useState([]);
const [services, setServices] = useState([]);
const [loading, setLoading] = useState(true);
const [error, setError] = useState(null);

useEffect(() => {
async function loadData() {
try {
setLoading(true);
const [, buyersData, sellersData, servicesData] = await Promise.all([
fetchStats(),
fetchBuyers(),
fetchSellers(),
fetchServices(),
]);
setBuyers(buyersData);
setSellers(sellersData);
setServices(servicesData);
setError(null);
} catch (err) {
setError(err.message);
} finally {
setLoading(false);
}
}

loadData();
}, []);

useEffect(() => {
if (!address) { setBuyerAddress(null); return; }
let cancelled = false;
(async () => {
try {
const config = await fetchDepositsConfig();
if (!cancelled && config.evmAddress) { setBuyerAddress(config.evmAddress); return; }
} catch {}
try {
const bal = await fetchDepositsBalance(address);
if (!cancelled && bal.evmAddress) setBuyerAddress(bal.evmAddress);
} catch {}
})();
return () => { cancelled = true; };
}, [address]);

  const handleWithdrawClick = async () => {
    if (buyerAddress) {
      try {
        const bal = await fetchDepositsBalance(buyerAddress);
        setWithdrawBalance(bal);
      } catch {
        setWithdrawBalance(null);
      }
    }
    setWithdrawOpen(true);
  };

if (loading) {
return (
<div className="dashboard" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
<div className="loading">Loading...</div>
</div>
);
}

if (error) {
return (
<div className="dashboard" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: '1rem' }}>
<div className="error">Error: {error}</div>
<p style={{ color: 'var(--text-secondary)' }}>
Make sure the API server is running on <code>http://localhost:3001</code>.
</p>
</div>
);
}

return (
    <div className="dashboard">
      <Header />
      <main className="container" style={{ paddingTop: '1.5rem' }}>
        {/* Single flat nav — all sections at the same level, per the
            approved rewrite plan (curation over completeness). */}
        <div className="tabs">
          <a
            href={tabHref('overview')}
            className={`tab ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={(e) => { e.preventDefault(); setActiveTab('overview'); }}
          >
            {t('nav.overview')}
          </a>
          <a
            href={tabHref('buyers')}
            className={`tab ${activeTab === 'buyers' ? 'active' : ''}`}
            onClick={(e) => { e.preventDefault(); setActiveTab('buyers'); }}
          >
            {t('nav.buyers')}
          </a>
          <a
            href={tabHref('sellers')}
            className={`tab ${activeTab === 'sellers' ? 'active' : ''}`}
            onClick={(e) => { e.preventDefault(); setActiveTab('sellers'); }}
          >
            {t('nav.sellers')}
          </a>
          <a
            href={tabHref('services')}
            className={`tab ${activeTab === 'services' ? 'active' : ''}`}
            onClick={(e) => { e.preventDefault(); setActiveTab('services'); }}
          >
            {t('nav.services')}
          </a>
          <a
            href={tabHref('tokenomics')}
            className={`tab ${activeTab === 'tokenomics' ? 'active' : ''}`}
            onClick={(e) => { e.preventDefault(); setActiveTab('tokenomics'); }}
          >
            {t('nav.tokenomics')}
          </a>
          <a
            href={tabHref('ants-info')}
            className={`tab ${activeTab === 'ants-info' ? 'active' : ''}`}
            onClick={(e) => { e.preventDefault(); setActiveTab('ants-info'); }}
          >
            {t('nav.antsInfo')}
          </a>
          {/* Stake ANTS deliberately reverses the earlier "no wallet-connect
              UI by default" decision (see notes/dev-plan.md) — explicit call
              by the site owner 2026-09-18, not a default. ClaimANTS.jsx /
              ChannelsView.jsx (the other 3 reward buckets: staker, legacy,
              locked) stay hidden — StakeANTS.jsx only covers the epoch-22+
              recognized-usage buckets (buyer/seller usage), which is all
              this tab was asked to surface. */}
          <a
            href={tabHref('stake')}
            className={`tab ${activeTab === 'stake' ? 'active' : ''}`}
            onClick={(e) => { e.preventDefault(); setActiveTab('stake'); }}
          >
            {t('nav.stake')}
          </a>
          <a
            href={tabHref('about')}
            className={`tab ${activeTab === 'about' ? 'active' : ''}`}
            onClick={(e) => { e.preventDefault(); setActiveTab('about'); }}
          >
            {t('nav.about')}
          </a>
        </div>

        {activeTab === 'overview' && <Overview />}
        {activeTab === 'buyers' && <BuyersList />}
        {activeTab === 'sellers' && <SellersList sellers={sellers} />}
        {activeTab === 'services' && <ServicesList services={services} />}
        {activeTab === 'tokenomics' && <TokenomicsTab />}
        {activeTab === 'ants-info' && <ANTSInfo />}
        {activeTab === 'stake' && <StakeANTS />}
        {activeTab === 'about' && <About />}
      </main>
      <DepositModal isOpen={depositOpen} onClose={() => setDepositOpen(false)} buyerAddress={buyerAddress} />
      <WithdrawModal isOpen={withdrawOpen} onClose={() => setWithdrawOpen(false)} balance={withdrawBalance} buyerAddress={buyerAddress} />
    </div>
  );
}

function App() {
const { address } = useAccount();
return (
<AuthorizedWalletProvider operatorAddress={address}>
<AppInner />
</AuthorizedWalletProvider>
);
}

export default App;
