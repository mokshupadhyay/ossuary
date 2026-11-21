import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const shim = (name: string) => fileURLToPath(new URL(`./src/shims/${name}`, import.meta.url));

// Browser build: core's Node built-ins are replaced by the app's shims (design D2).
// Vitest uses vitest.config.ts, which has no aliases, so tests run on real Node modules.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^node:crypto$/, replacement: shim('node-crypto.ts') },
      { find: /^node:(url|fs)$/, replacement: shim('node-stubs.ts') },
    ],
  },
  optimizeDeps: {
    exclude: ['@electric-sql/pglite'],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
  worker: { format: 'es' },
});
