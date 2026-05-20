import React, { useState, lazy, Suspense } from 'react';
import Header from './components/Header';
import DepositModal from './components/DepositModal';
import WithdrawModal from './components/WithdrawModal';
import WelcomeTab from './components/WelcomeTab';
import SellersList from './components/SellersList';
import ServicesList from './components/ServicesList';
import { AuthorizedWalletProvider } from './context/AuthorizedWalletContext';
import { useAccount } from 'wagmi';
import { fetchDepositsBalance } from './api';
import { useDashboardData } from './hooks/useDashboardData';
import { useBuyerAddress } from './hooks/useBuyerAddress';

const ClaimANTS = lazy(() => import('./components/ClaimANTS'));
const ChannelsView = lazy(() => import('./components/ChannelsView'));
const SpendingView = lazy(() => import('./components/SpendingView'));
const ANTSInfo = lazy(() => import('./components/ANTSInfo'));

function TabLoader() {
  return (
    <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
      Loading...
    </div>
  );
}

function AppInner() {
const { address } = useAccount();
const { data, isLoading, error } = useDashboardData();
const { data: buyerAddress = null } = useBuyerAddress(address);
const [activeTab, setActiveTab] = useState('welcome');
const [depositOpen, setDepositOpen] = useState(false);
const [withdrawOpen, setWithdrawOpen] = useState(false);
const [withdrawBalance, setWithdrawBalance] = useState(null);
const buyers = data?.buyers ?? [];
const sellers = data?.sellers ?? [];
const services = data?.services ?? [];

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

if (isLoading) {
return (
<div className="dashboard" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
<div className="loading">Loading...</div>
</div>
);
}

if (error) {
return (
<div className="dashboard" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: '1rem' }}>
<div className="error">Error: {error.message}</div>
<p style={{ color: 'var(--text-secondary)' }}>
Make sure the API server is running on <code>http://localhost:3001</code>.
</p>
</div>
);
}

return (
<div className="dashboard">
<Header onDepositClick={() => setDepositOpen(true)} onWithdrawClick={handleWithdrawClick} buyerAddress={buyerAddress} />
<main className="container" style={{ paddingTop: '1.5rem' }}>
<div className="tabs">
<button
className={`tab ${activeTab === 'welcome' ? 'active' : ''}`}
onClick={() => setActiveTab('welcome')}
>
Home
</button>
<button
className={`tab ${activeTab === 'claim' ? 'active' : ''}`}
onClick={() => setActiveTab('claim')}
>
Claim ANTS
</button>
          <button
            className={`tab ${activeTab === 'spending' ? 'active' : ''}`}
            onClick={() => setActiveTab('spending')}
          >
            Spending
          </button>
          <button
            className={`tab ${activeTab === 'channels' ? 'active' : ''}`}
            onClick={() => setActiveTab('channels')}
          >
            Channels
          </button>
<button
className={`tab ${activeTab === 'sellers' ? 'active' : ''}`}
onClick={() => setActiveTab('sellers')}
>
Sellers ({sellers.length})
</button>
<button
className={`tab ${activeTab === 'services' ? 'active' : ''}`}
onClick={() => setActiveTab('services')}
>
Services ({services.length})
</button>
<button
className={`tab ${activeTab === 'ants' ? 'active' : ''}`}
onClick={() => setActiveTab('ants')}
>
$ANTS
</button>
</div>

{activeTab === 'claim' && <Suspense fallback={<TabLoader />}><ClaimANTS /></Suspense>}
{activeTab === 'welcome' && <WelcomeTab />}
{activeTab === 'channels' && <Suspense fallback={<TabLoader />}><ChannelsView /></Suspense>}
{activeTab === 'spending' && <Suspense fallback={<TabLoader />}><SpendingView buyerAddress={buyerAddress} /></Suspense>}
{activeTab === 'sellers' && <SellersList sellers={sellers} />}
{activeTab === 'services' && <ServicesList services={services} />}
{activeTab === 'ants' && <Suspense fallback={<TabLoader />}><ANTSInfo /></Suspense>}
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
