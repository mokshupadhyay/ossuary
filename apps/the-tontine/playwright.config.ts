import { defineConfig, devices } from '@playwright/test';

/** E2E_PORT moves the preview off 4173 when that port is busy (for example a preview left open by hand). */
const port = Number(process.env['E2E_PORT'] ?? 4173);

/** The full demo path against the built app: `pnpm build` first, then `pnpm e2e` serves dist/ with vite preview. */
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: `pnpm exec vite preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
