import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// Renderer only. Main and preload are bundled by esbuild (scripts/esbuild.mjs).
export default defineConfig({
  root: here('./src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: here('./dist-renderer'),
    emptyOutDir: true,
    // Loaded from disk, not the network: one bundle is fine.
    chunkSizeWarningLimit: 2000,
  },
  server: { port: 5173 },
})
