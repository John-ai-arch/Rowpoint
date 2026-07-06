import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  retries: 0,
  workers: 1, // scenarios share one server + database, keep them ordered
  use: {
    baseURL: 'http://localhost:4381',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: '/opt/pw-browsers/chromium' },
  },
  webServer: {
    command: 'rm -rf /tmp/rowpoint-e2e && ROWPOINT_DATA_DIR=/tmp/rowpoint-e2e PORT=4381 node server/index.js',
    url: 'http://localhost:4381/api/status',
    reuseExistingServer: false,
    timeout: 15000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
