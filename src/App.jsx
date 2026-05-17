import React, { useState, useEffect } from 'react';
import ClaimANTS from './components/ClaimANTS';
import SellersList from './components/SellersList';
import ServicesList from './components/ServicesList';
import ANTSInfo from './components/ANTSInfo';
import WelcomeTab from './components/WelcomeTab';
import Header from './components/Header';
import DepositModal from './components/DepositModal';
import WithdrawModal from './components/WithdrawModal';
import ChannelsView from './components/ChannelsView';
import { AuthorizedWalletProvider } from './context/AuthorizedWalletContext';
import { useAccount } from 'wagmi';
import { fetchStats, fetchBuyers, fetchSellers, fetchServices } from './api';

function AppInner() {
const { address } = useAccount();
const [activeTab, setActiveTab] = useState('welcome');
const [depositOpen, setDepositOpen] = useState(false);
const [withdrawOpen, setWithdrawOpen] = useState(false);
const [withdrawBalance, setWithdrawBalance] = useState(null);
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

const handleWithdrawClick = async () => {
if (address) {
try {
const { fetchDepositsBalance } = await import('./api');
const bal = await fetchDepositsBalance(address);
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
<Header onDepositClick={() => setDepositOpen(true)} onWithdrawClick={handleWithdrawClick} />
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

{activeTab === 'claim' && <ClaimANTS />}
{activeTab === 'welcome' && <WelcomeTab />}
{activeTab === 'channels' && <ChannelsView />}
{activeTab === 'sellers' && <SellersList sellers={sellers} />}
{activeTab === 'services' && <ServicesList services={services} />}
{activeTab === 'ants' && <ANTSInfo />}
</main>
<DepositModal isOpen={depositOpen} onClose={() => setDepositOpen(false)} />
<WithdrawModal isOpen={withdrawOpen} onClose={() => setWithdrawOpen(false)} balance={withdrawBalance} />
</div>
);
}

function App() {
const { address } = useAccount();
return (
<AuthorizedWalletProvider buyerAddress={address}>
<AppInner />
</AuthorizedWalletProvider>
);
}

export default App;
