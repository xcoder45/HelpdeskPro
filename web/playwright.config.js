import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const requestedChannel = process.env.E2E_BROWSER_CHANNEL ?? 'chrome';
const channel = requestedChannel === 'bundled' ? undefined : requestedChannel;
const devCommand = process.platform === 'win32'
  ? 'cmd /c npm --prefix .. run dev'
  : 'npm --prefix .. run dev';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'browser',
      use: {
        ...devices['Desktop Chrome'],
        ...(channel ? { channel } : {})
      }
    }
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
      command: devCommand,
      url: 'http://127.0.0.1:3000/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000
    }
});
