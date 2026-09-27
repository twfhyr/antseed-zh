import React from 'react'
import ReactDOM from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit'
import '@rainbow-me/rainbowkit/styles.css'
import App from './App.jsx'
import { config } from './wagmi-config.js'
import { I18nProvider, useI18n } from './i18n/index.jsx'
import './index.css'

const queryClient = new QueryClient()

// RainbowKitProvider has no way to know this app's own language choice --
// left unset, it auto-detects the browser's locale instead, which can show
// the wallet-connect button/modal in a different language than the rest of
// the page renders in (e.g. a Chinese-locale browser sees a Chinese wallet
// modal even while this app is rendering in English, its default since
// 2026-09-21). Sync it to the same `lang` src/i18n/index.jsx already
// tracks (default 'en', or 'zh' for a returning visitor with that stored)
// instead of leaving it to guess from the browser.
function RainbowKit({ children }) {
  const { lang } = useI18n();
  return (
    <RainbowKitProvider
      locale={lang === 'zh' ? 'zh-CN' : 'en-US'}
      theme={darkTheme({
        accentColor: '#10b981',
        accentColorForeground: 'white',
        borderRadius: 'medium',
      })}
    >
      {children}
    </RainbowKitProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <I18nProvider>
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <RainbowKit>
            <App />
          </RainbowKit>
        </QueryClientProvider>
      </WagmiProvider>
    </I18nProvider>
  </React.StrictMode>,
)