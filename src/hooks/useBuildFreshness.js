import { useEffect } from 'react';

// __BUILD_ID__ is injected at build time by vite.config.js's `define`,
// sourced from public/build-id.json (written by scripts/gen-build-id.cjs,
// run as part of `npm run build`) — a value fixed to whatever was built,
// baked into the JS bundle itself.
/* global __BUILD_ID__ */

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // fallback for a tab that's never unfocused

/** Detects that a newer build has been deployed and reloads automatically,
 *  so testing a change doesn't require a manual hard refresh every time.
 *  Checks build-id.json (a plain static file, not the cached index.html —
 *  fetched with cache: 'no-store' so this check itself is never stale)
 *  whenever the tab regains focus, plus a periodic fallback for a tab that
 *  stays focused/open across a deploy. Does nothing if the check fails
 *  (offline, 404 on a dev server that never ran the build script) — a
 *  version check is a nice-to-have, not something that should ever surface
 *  an error to a visitor. */
export function useBuildFreshness() {
  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}build-id.json`, { cache: 'no-store' });
        if (!res.ok) return;
        const { buildId } = await res.json();
        if (!cancelled && buildId && buildId !== __BUILD_ID__) {
          window.location.reload();
        }
      } catch { /* offline, or no build-id.json (dev server) — ignore */ }
    }

    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    const interval = setInterval(check, CHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(interval);
    };
  }, []);
}
