import { http } from 'wagmi';
import { base } from 'wagmi/chains';
import { getDefaultConfig } from '@rainbow-me/rainbowkit';

export const config = getDefaultConfig({
  appName: 'AntSeed Dashboard',
  projectId: 'antseed-dashboard-public',
  chains: [base],
  transports: {
    [base.id]: http('https://base.publicnode.com'),
  },
});
