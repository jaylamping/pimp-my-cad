import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// bench.html is the GPU print-check spike (gpu.js vs three WebGPU/TSL). It is a separate page so
// the viewer app stays untouched.
//
// COOP/COEP make the page cross-origin isolated, which gpu.js needs for SharedArrayBuffer (its
// threaded WebAssembly backend). Everything the app loads is same-origin, so this costs nothing.
//
// Phones only expose WebGPU (and crypto.subtle) on secure origins, so `npm run bench:https`
// serves over HTTPS with a self-signed certificate for testing on a LAN IP.
export default defineConfig(async ({ mode }) => ({
  plugins: mode === 'https' ? [(await import('@vitejs/plugin-basic-ssl')).default()] : [],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'es2022',
    rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), bench: resolve(import.meta.dirname, 'bench.html') } },
  },
}));
