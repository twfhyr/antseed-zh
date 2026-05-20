import { useQuery } from '@tanstack/react-query';
import { fetchStats, fetchBuyers, fetchSellers, fetchServices } from '../api';

async function fetchDashboardData() {
  const [stats, buyers, sellers, services] = await Promise.all([
    fetchStats(),
    fetchBuyers(),
    fetchSellers(),
    fetchServices(),
  ]);

  return { stats, buyers, sellers, services };
}

export function useDashboardData() {
  return useQuery({
    queryKey: ['dashboard-data'],
    queryFn: fetchDashboardData,
    staleTime: 60 * 1000,
  });
}
