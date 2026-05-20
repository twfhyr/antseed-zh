import { useQuery } from '@tanstack/react-query';
import { fetchSpending } from '../api';

export function useSpendingData(buyerAddress, days = 7) {
  return useQuery({
    queryKey: ['spending', buyerAddress, days],
    queryFn: () => fetchSpending(buyerAddress, days),
    enabled: !!buyerAddress,
    staleTime: 5 * 60 * 1000,
  });
}
