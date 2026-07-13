import fs from 'node:fs';
import { defineConfig } from '@playwright/test';
import { englishState } from './tests/e2e/state.js';

// CI images pin a system chromium; everywhere else Playwright resolves its
// own installed browser (npx playwright install chromium). This keeps one
// config runnable on Linux CI, macOS, and Windows dev machines alike.
const pinnedChromium = '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: './tests/e2e',
  // These are heavy full-journey tests: the simulator-rowing scenarios legitimately
  // run ~45-55s (accelerated 2k row + live WebSocket sync + AI feedback + chart
  // render), so a 60s budget tipped over under any CPU variance. 120s gives real
  // headroom; retries absorb the occasional timing wobble on a loaded machine
  // (a test that only passes on retry was slow, not broken).
  timeout: 120000,
  retries: process.env.CI ? 2 : 1,
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
