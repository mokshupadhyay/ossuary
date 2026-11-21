import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/*
 * Core imports `node:crypto` and `node:url`; the page gets browser adapters
 * instead (design T1). Vitest loads this same file, so every App test runs
 * Core through the adapters too. Core's own suite is unaffected.
 */
const adapter = (file: string) => fileURLToPath(new URL(`./src/platform/${file}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: [
      { find: /^node:crypto$/, replacement: adapter('nodeCrypto.ts') },
      { find: /^node:url$/, replacement: adapter('nodeUrl.ts') },
    ],
  },
  // PGlite loads its WASM and data bundle by URL; pre-bundling breaks that.
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'tests/**/*.property.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ['./tests/setup.ts'],
  },
});
