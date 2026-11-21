import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Tests run on Node with its real built-ins (no aliases): core is exercised exactly as in its own suite.
// Component tests opt into jsdom with a `// @vitest-environment jsdom` docblock.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.{ts,tsx}', 'tests/**/*.property.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
