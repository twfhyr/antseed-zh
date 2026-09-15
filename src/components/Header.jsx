import React from 'react';
import { Github } from 'lucide-react';
import { useI18n } from '../i18n/index.jsx';

// Wallet connect / deposit / withdraw UI is intentionally not rendered here.
// This is a public read-only network dashboard aimed at first-time visitors;
// a "Connect Wallet" button up top reads as "this site wants access to my
// funds" and scares people off before they've even looked at the data. The
// underlying wagmi/RainbowKit wiring (and the deposit/withdraw modals it
// drove, plus the Claim ANTS / Channels tabs it would gate — see App.jsx) is
// left in place for now — just not surfaced — in case buyer-facing wallet
// actions come back later. See notes/dev-plan.md.
function Header() {
const { lang, setLang, t } = useI18n();

return (
<header className="app-header">
<div className="app-header__brand">
{/* Same icon as the favicon (official AntSeed ant + 蚁 badge).
    BASE_URL keeps it correct under both the "/" and "/zh/" builds. */}
<img
  className="app-header__logo-img"
  src={`${import.meta.env.BASE_URL}antseed-zh-icon.svg`}
  alt="antseed-zh"
  width={28}
  height={28}
/>
<span className="app-header__title">antseed-zh</span>
</div>

  <div className="app-header__actions">
    <button
      className="deposit-btn"
      onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
      title="Switch language / 切换语言"
      style={{ minWidth: '2.5rem' }}
    >
      {lang === 'zh' ? 'EN' : '中文'}
    </button>
    <a
    href="https://t.me/antseed_zh"
    target="_blank"
    rel="noopener noreferrer"
    className="deposit-btn"
    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0.5rem', textDecoration: 'none' }}
    title={t('header.telegram')}
    >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
    </svg>
    </a>
    <a
    href="https://github.com/twfhyr/antseed-zh"
    target="_blank"
    rel="noopener noreferrer"
    className="deposit-btn"
    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0.5rem', textDecoration: 'none' }}
    title={t('header.github')}
    >
    <Github size={16} />
    </a>
  </div>
</header>
);
}

export default Header;
