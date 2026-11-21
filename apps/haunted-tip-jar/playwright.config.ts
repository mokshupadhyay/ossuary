import { defineConfig, devices } from '@playwright/test';

// Runs against the production build served by `vite preview` (Requirement 10.3).
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:4174', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: 'http://localhost:4174',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
