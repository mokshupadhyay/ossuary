import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 120_000,
    // createTestDb() boots pglite in beforeEach; under load (many files at once) it can exceed the 10s default.
    hookTimeout: 60_000,
    include: ['tests/**/*.test.ts', 'tests/**/*.property.ts'],
  },
});
