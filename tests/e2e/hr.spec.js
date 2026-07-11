// Heart-rate monitor subsystem E2E: primary nav entry, device management
// screen, simulated monitor streaming, workout HR recording, summary + zones,
// strict verification flow at login, and the PWA manifest.
import { test, expect } from '@playwright/test';
import { englishState } from './state.js';

const BASE = 'http://localhost:4381';
test.describe.configure({ mode: 'serial' });

async function signupApi(request, email) {
  await request.post(`${BASE}/api/auth/signup`, {
    data: { email, password: 'password123', displayName: email.split('@')[0], accountType: 'rower', birthYear: 1995 },
  });
  const ob = await (await request.get(`${BASE}/api/dev/outbox?to=${email}`)).json();
  const code = ob.emails[0].body.match(/code is: (\d{6})/)[1];
  const v = await request.post(`${BASE}/api/auth/verify`, { data: { email, code } });
  return v.json();
}

async function loginUI(page, email) {
  await page.goto(`${BASE}/#/login`);
  await page.fill('#email', email);
  await page.fill('#password', 'password123');
  await page.click('#loginBtn');
  await expect(page.locator('h1')).toContainText('Hi,');
}

let ctx;

test('unverified login routes to the verification screen — no session, no skip', async ({ browser, request }) => {
  await request.post(`${BASE}/api/auth/signup`, {
    data: { email: 'strict@hr.com', password: 'password123', displayName: 'Strict', accountType: 'rower' },
  });
  const page = await browser.newPage({ storageState: englishState });
  await page.goto(`${BASE}/#/login`);
  await page.fill('#email', 'strict@hr.com');
  await page.fill('#password', 'password123');
  await page.click('#loginBtn');
  await expect(page.locator('h2')).toContainText('Verify your email');
  await expect(page.getByText(/take me in|verify later/i)).toHaveCount(0);
  // the surfaced dev code completes verification and only THEN enters the app
  const shown = (await page.locator('.notice').textContent()).match(/(\d{6})/)[1];
  await page.fill('#code', shown);
  await page.click('#verifyBtn');
  await expect(page.locator('h1')).toContainText('Hi,');
  await page.close();
});

test('Heart Rate Monitors is a primary nav section with full device management', async ({ browser, request }) => {
  await signupApi(request, 'pulse@hr.com');
  ctx = await browser.newContext({ storageState: englishState });
  const page = await ctx.newPage();
  await loginUI(page, 'pulse@hr.com');

  // primary navigation entry
  await expect(page.locator('nav.tabs a', { hasText: 'Heart Rate' })).toBeVisible();
  await page.click('nav.tabs a[href="#/hr"]');
  await expect(page.locator('h1')).toContainText('Heart Rate Monitors');
  // status line reflects real capability: "Disconnected" on BLE-capable
  // browsers, "Bluetooth unavailable" in headless test runs — both are
  // honest states, never a crash.
  await expect(page.locator('#hrState')).toHaveText(/Disconnected|Bluetooth unavailable/);
  await expect(page.locator('#hrConnect')).toBeVisible(); // large connect button

  // connect the simulated monitor → live BPM within seconds
  await page.click('#hrSim');
  await expect(page.locator('#hrBpm')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#hrBpm')).not.toHaveText('–', { timeout: 8000 });
  await expect(page.getByText('Simulated HRM').first()).toBeVisible();
  await expect(page.locator('#hrBatt')).toContainText('%');       // battery level
  await expect(page.locator('#hrZoneLbl')).toContainText('% of max'); // zone display
  await expect(page.locator('#hrLiveChart')).toBeVisible();

  // saved-devices management: rename + prefer
  page.on('dialog', d => d.accept('My Chest Strap'));
  await page.locator('[data-rename]').first().click();
  await expect(page.getByText('My Chest Strap').first()).toBeVisible();
  await page.screenshot({ path: 'shots/14-hr-monitor.png', fullPage: true });
  await page.close();
});

test('HR is recorded through a workout and lands in the summary with zones', async () => {
  const page = await ctx.newPage();
  // monitor persists app-wide (hrManager singleton survives navigation)
  await page.goto(`${BASE}/#/hr`);
  await page.click('#hrSim');
  await expect(page.locator('#hrBpm')).not.toHaveText('–', { timeout: 8000 });

  await page.goto(`${BASE}/#/row?sim_speed=45&sim_pace=125`);
  await page.click('#simBtn');
  await page.click('[data-prof="even"]');
  await page.click('#simStart');
  await expect(page.locator('#mDist')).not.toHaveText('0', { timeout: 10000 });
  // the erg simulator relays HR itself; the strap fallback also feeds the tile
  await expect(page.locator('#mHr')).not.toHaveText('–');
  await page.waitForTimeout(4000); // row long enough for the 1 Hz strap to log several samples
  await page.click('#finishBtn');
  await expect(page.locator('#afterArea')).toContainText('AI-generated feedback', { timeout: 20000 });

  // workout detail shows the heart-rate section: stats, chart, zone bars
  await page.goto(`${BASE}/#/history`);
  await page.click('.card.list-item');
  await expect(page.locator('h3', { hasText: 'Heart rate' })).toBeVisible();
  await expect(page.locator('#hrChart')).toBeVisible();
  await expect(page.getByText('Z1 · Recovery')).toBeVisible();
  await page.screenshot({ path: 'shots/15-hr-summary.png', fullPage: true });

  // history & analysis tab aggregates it
  await page.goto(`${BASE}/#/hr`);
  await page.click('[data-tab="history"]');
  await expect(page.getByText('workouts with HR')).toBeVisible();
  await expect(page.getByText('Time in zone')).toBeVisible();
  await page.screenshot({ path: 'shots/16-hr-history.png', fullPage: true });
  await page.close();
});

test('PWA: manifest, icons, and service worker are served', async ({ request }) => {
  const man = await request.get(`${BASE}/manifest.webmanifest`);
  expect(man.ok()).toBeTruthy();
  const m = await man.json();
  expect(m.display).toBe('standalone');
  expect((await request.get(`${BASE}${m.icons[0].src}`)).ok()).toBeTruthy();
  expect((await request.get(`${BASE}/sw.js`)).ok()).toBeTruthy();
});
