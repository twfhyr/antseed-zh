import { useQuery } from '@tanstack/react-query';
import { fetchChannels } from '../api';

export function useChannelsData() {
  return useQuery({
    queryKey: ['channels'],
    queryFn: async () => {
      const data = await fetchChannels();
      return data.channels ?? [];
    },
    staleTime: 60 * 1000,
  });
}
