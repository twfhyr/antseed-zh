import React, { useState, useEffect } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';
import { PlusCircle, ArrowUpCircle, Wallet } from 'lucide-react';
import { fetchDepositsBalance } from '../api';

const DEPOSITS_CONTRACT = '0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2';

function Header({ onDepositClick, onWithdrawClick }) {
const { isConnected, address } = useAccount();
const [balance, setBalance] = useState(null);

useEffect(() => {
if (!isConnected || !address) { setBalance(null); return; }
let cancelled = false;
fetchDepositsBalance(address)
.then(data => { if (!cancelled) setBalance(data); })
.catch(() => {});
return () => { cancelled = true; };
}, [isConnected, address]);

return (
<header className="app-header">
<div className="app-header__brand">
<div className="app-header__logo">A</div>
<span className="app-header__title">AntSeed</span>
{balance && (
<span className="header-balance">
<Wallet size={14} />
${parseFloat(balance.available).toFixed(2)} USDC
</span>
)}
</div>

<div className="app-header__actions">
{isConnected && (
<>
<button className="deposit-btn" onClick={onWithdrawClick}>
<ArrowUpCircle size={16} />
Withdraw
</button>
<button className="deposit-btn" onClick={onDepositClick}>
<PlusCircle size={16} />
Deposit
</button>
</>
)}
<ConnectButton
showBalance={false}
accountStatus="address"
chainStatus="icon"
/>
</div>
</header>
);
}

export default Header;
