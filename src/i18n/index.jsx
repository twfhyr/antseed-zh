import React, { createContext, useContext, useState, useMemo, useCallback } from 'react';
import en from './en.js';
import zh from './zh.js';

const DICTS = { en, zh };
const STORAGE_KEY = 'antseed-zh:lang';

const I18nContext = createContext({ lang: 'zh', t: (k) => k, setLang: () => {} });

function getInitialLang() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'zh') return stored;
  } catch {}
  return 'zh'; // zh default, per project decision
}

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(getInitialLang);

  const setLang = useCallback((next) => {
    setLangState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch {}
  }, []);

  const t = useCallback((key, vars) => {
    const dict = DICTS[lang] || DICTS.zh;
    let str = dict[key] ?? DICTS.en[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replaceAll(`{${k}}`, v);
      }
    }
    return str;
  }, [lang]);

  const value = useMemo(() => ({ lang, t, setLang }), [lang, t, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
