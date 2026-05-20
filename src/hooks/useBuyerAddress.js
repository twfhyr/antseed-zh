import { useQuery } from '@tanstack/react-query';
import { fetchDepositsBalance, fetchDepositsConfig } from '../api';

async function fetchBuyerAddress(address) {
  if (!address) return null;

  try {
    const config = await fetchDepositsConfig();
    if (config.evmAddress) {
      return config.evmAddress;
    }
  } catch {}

  try {
    const balance = await fetchDepositsBalance(address);
    return balance.evmAddress ?? null;
  } catch {
    return null;
  }
}

export function useBuyerAddress(address) {
  return useQuery({
    queryKey: ['buyer-address', address],
    queryFn: () => fetchBuyerAddress(address),
    enabled: !!address,
    staleTime: 60 * 1000,
  });
}
