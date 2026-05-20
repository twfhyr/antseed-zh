import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function manualChunks(id) {
  if (!id.includes('node_modules')) return undefined
  if (id.includes('@tanstack/react-query')) return 'react-query'
  if (id.includes('@rainbow-me')) return 'rainbowkit'
  if (id.includes('wagmi') || id.includes('viem')) return 'web3-core'
  if (id.includes('@walletconnect')) return 'walletconnect'
  if (id.includes('@reown')) return 'reown'
  if (id.includes('@coinbase') || id.includes('@base-org')) return 'coinbase'
  if (id.includes('react') || id.includes('react-dom')) return 'react-vendor'
  return 'vendor'
}

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
})
