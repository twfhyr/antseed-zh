import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { fetchDepositsOperator, fetchDepositsConfig, fetchDepositsBalance } from '../api';

const AuthorizedWalletContext = createContext(null);

export function useAuthorizedWallet() {
const ctx = useContext(AuthorizedWalletContext);
if (!ctx) throw new Error('useAuthorizedWallet must be used inside <AuthorizedWalletProvider>');
return ctx;
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

export function AuthorizedWalletProvider({ operatorAddress, children }) {
const { address } = useAccount();
const [operator, setOperator] = useState(null);
const [operatorSet, setOperatorSet] = useState(null);
const [buyerAddress, setBuyerAddress] = useState(null);

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

useEffect(() => {
if (!buyerAddress) return;
let cancelled = false;
fetchDepositsOperator(buyerAddress)
.then(data => {
if (!cancelled) {
setOperator(data.operator);
setOperatorSet(data.operator !== ZERO_ADDR);
}
})
.catch(() => {});
return () => { cancelled = true; };
}, [buyerAddress]);

const refetch = useCallback(async () => {
if (!buyerAddress) return;
try {
const data = await fetchDepositsOperator(buyerAddress);
setOperator(data.operator);
setOperatorSet(data.operator !== ZERO_ADDR);
} catch {}
}, [buyerAddress]);

const value = useMemo(() => ({
operator,
operatorSet,
buyerAddress,
refetch,
}), [operator, operatorSet, buyerAddress, refetch]);

return (
<AuthorizedWalletContext.Provider value={value}>
{children}
</AuthorizedWalletContext.Provider>
);
}
