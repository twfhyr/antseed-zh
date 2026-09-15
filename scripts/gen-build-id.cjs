// Writes public/build-id.json with an identifier unique to this build.
// Run as part of `npm run build` (see package.json) — the frontend
// compares this against a value baked into the running JS bundle
// (see vite.config.js's `define`) to detect that a newer build is live
// and reload automatically, instead of requiring a manual hard refresh.
// See src/hooks/useBuildFreshness.js for the client-side half of this.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function gitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return 'unknown';
  }
}

const buildId = `${gitCommit()}-${Date.now()}`;
const outPath = path.join(__dirname, '..', 'public', 'build-id.json');
fs.writeFileSync(outPath, JSON.stringify({ buildId }));
console.log(`[gen-build-id] ${buildId}`);
