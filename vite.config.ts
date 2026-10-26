import { defineConfig } from 'vite';

// Relative base so the build works under https://<user>.github.io/<repo>/
// and anywhere else (Cloudflare Pages, local preview) without changes.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
  },
});
