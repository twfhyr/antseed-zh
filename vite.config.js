import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// BUILD_TARGET=root builds for the dedicated domain (antseed-zh.com, served
// at /); default builds for the /zh subpath proxy (5.223.54.56:8088/zh/).
const isRoot = process.env.BUILD_TARGET === 'root'

export default defineConfig({
  base: isRoot ? '/' : '/zh/',
  build: {
    outDir: isRoot ? 'dist-root' : 'dist',
  },
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
  },
})