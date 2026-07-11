import fs from 'node:fs';
import { defineConfig } from '@playwright/test';
import { englishState } from './tests/e2e/state.js';

// CI images pin a system chromium; everywhere else Playwright resolves its
// own installed browser (npx playwright install chromium). This keeps one
// config runnable on Linux CI, macOS, and Windows dev machines alike.
const pinnedChromium = '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  retries: 0,
  workers: 1, // scenarios share one server + database, keep them ordered
  use: {
    baseURL: 'http://localhost:4381',
    screenshot: 'only-on-failure',
    storageState: englishState, // skip the first-run language chooser (see tests/e2e/state.js)
    ...(fs.existsSync(pinnedChromium) ? { launchOptions: { executablePath: pinnedChromium } } : {}),
  },
  webServer: {
    command: 'node tests/e2e/serve.js', // cross-platform: cleans the e2e data dir itself
    url: 'http://localhost:4381/api/status',
    reuseExistingServer: false,
    timeout: 15000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
