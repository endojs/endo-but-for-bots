/* global process */
// eslint-disable-next-line import/no-extraneous-dependencies
import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for the daemon-free e2e suites, which mount real
 * components against a synthetic EndoHost on the harness pages under
 * test/e2e/harness/ (see test/e2e/README.md). Unlike playwright.config.ts, no
 * Endo daemon is started.
 *
 *   yarn test:e2e:harness
 */
const port = Number(process.env.HARNESS_PORT || 5210);

export default defineConfig({
  testDir: './test/e2e',
  testMatch: ['formula-inspector.spec.ts'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'node test/e2e/harness/serve.mjs',
    url: `http://localhost:${port}/test/e2e/harness/formula-inspector.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
