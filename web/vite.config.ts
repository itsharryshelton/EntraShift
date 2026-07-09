import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// EntraShift web UI build config.
// Output goes to web/dist, which the Cloudflare Worker serves as static assets
// (see worker/wrangler.jsonc `assets.directory: "../web/dist"`).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Import the shared Worker↔UI wire contract directly (single source of truth).
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // During local dev, proxy API/auth to a locally running Worker (`wrangler dev`).
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/auth': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
