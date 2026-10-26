import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  // Relative base so the build works under https://<user>.github.io/<repo>/
  // and anywhere else (Cloudflare Pages, local preview) without changes.
  base: './',
  plugins: [wasm()],
  resolve: {
    // Code imports the -compat build (it runs in Node for scripts/sim-car.ts).
    // In the browser, swap in the regular build: same API, but the physics
    // WASM ships as its own compressed file instead of inlined base64, which
    // roughly halves the download.
    alias: { '@dimforge/rapier3d-compat': '@dimforge/rapier3d' },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
