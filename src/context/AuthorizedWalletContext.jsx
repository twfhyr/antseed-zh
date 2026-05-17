import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { fetchDepositsOperator } from '../api';

const AuthorizedWalletContext = createContext(null);

export function useAuthorizedWallet() {
const ctx = useContext(AuthorizedWalletContext);
if (!ctx) throw new Error('useAuthorizedWallet must be used inside <AuthorizedWalletProvider>');
return ctx;
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

export function AuthorizedWalletProvider({ buyerAddress, children }) {
const [operator, setOperator] = useState(null);
const [operatorSet, setOperatorSet] = useState(null);

const refetch = useCallback(async () => {
if (!buyerAddress) return;
try {
const data = await fetchDepositsOperator(buyerAddress);
setOperator(data.operator);
setOperatorSet(data.operator !== ZERO_ADDR);
} catch {
// keep previous state
}
}, [buyerAddress]);

useEffect(() => { refetch(); }, [refetch]);

const value = useMemo(() => ({
operator,
operatorSet,
refetch,
}), [operator, operatorSet, refetch]);

return (
<AuthorizedWalletContext.Provider value={value}>
{children}
</AuthorizedWalletContext.Provider>
);
}
