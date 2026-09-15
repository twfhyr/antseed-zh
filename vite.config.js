import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// BUILD_TARGET=root builds for the dedicated domain (antseed-zh.com, served
// at /); default builds for the /zh subpath proxy (5.223.54.56:8088/zh/).
const isRoot = process.env.BUILD_TARGET === 'root'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Written by scripts/gen-build-id.cjs (see package.json's `build` script,
// which runs it before `vite build`) — baked into the bundle so the client
// can detect a newer build is live and reload on its own. See
// src/hooks/useBuildFreshness.js. Falls back to a dev-only ID if the build
// script hasn't run (e.g. `vite dev`), so local dev never breaks on this.
let buildId = `dev-${Date.now()}`
try {
  buildId = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'build-id.json'), 'utf8')).buildId
} catch { /* dev server, or first build before the file exists */ }

export default defineConfig({
  base: isRoot ? '/' : '/zh/',
  build: {
    outDir: isRoot ? 'dist-root' : 'dist',
  },
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
  },
})