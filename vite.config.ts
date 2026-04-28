import { defineConfig } from 'vite';
import { resolve } from 'path';

// Multi-page build: landing + 3 apps. GitHub Pages serves the dist/ output.
// The base path can be overridden at build time for repo subpaths.
export default defineConfig(({ mode }) => ({
  base: process.env.VITE_BASE ?? '/',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        gatherer: resolve(__dirname, 'apps/gatherer/index.html'),
        harness: resolve(__dirname, 'apps/harness/index.html'),
        playground: resolve(__dirname, 'apps/playground/index.html'),
      },
    },
    sourcemap: mode !== 'production',
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    open: '/',
  },
}));
