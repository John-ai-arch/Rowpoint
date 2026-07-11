// End-to-end browser tests: full coach + rower + admin journeys through the
// real UI, using the built-in erg simulator (accelerated) for workouts.
import { test, expect } from '@playwright/test';
import { englishState } from './state.js';

const BASE = 'http://localhost:4381';
test.describe.configure({ mode: 'serial' });

async function getCode(request, email) {
  const r = await request.get(`${BASE}/api/dev/outbox?to=${email}`);
  const { emails } = await r.json();
  return emails[0].body.match(/code is: (\d{6})/)[1];
}

async function signupUI(page, request, { email, name, type, teamCode }) {
  await page.goto(`${BASE}/#/login`);
  await page.click('#swap');
  if (type === 'coach') await page.click('[data-type="coach"]');
  await page.fill('#displayName', name);
  await page.fill('#email', email);
  await page.fill('#password', 'password123');
  if (teamCode) await page.fill('#teamCode', teamCode);
  await page.click('#next1');
  await page.click('#next2'); // accept profile defaults
  await expect(page.locator('h2')).toContainText('research');
  await expect(page.locator('#research')).toBeChecked(); // §5.1 opt-out default, shown plainly
  await page.click('#createBtn');
  // Mandatory verification screen — no skip button exists anymore.
  await expect(page.locator('h2')).toContainText('Verify your email');
  await expect(page.getByText(/take me in|verify later/i)).toHaveCount(0);
  // Dev mode surfaces the code right on the screen; use it like a user would.
  const notice = await page.locator('.notice').textContent();
  const shown = notice.match(/(\d{6})/)?.[1] || await getCode(request, email);
  await page.fill('#code', shown);
  await page.click('#verifyBtn');
  await expect(page.locator('h1')).toContainText('Hi,');
}

let teamCode = '';
let coachCtx, rowerCtx;

test('coach signs up through the 3-step flow and gets a team code', async ({ browser, request }) => {
  coachCtx = await browser.newContext({ storageState: englishState });
  const page = await coachCtx.newPage();
  await signupUI(page, request, { email: 'coach@e2e.com', name: 'Coach Carla', type: 'coach' });
  await page.goto(`${BASE}/#/teams`);
  await expect(page.locator('.badge.blue').first()).toBeVisible();
  teamCode = (await page.locator('.badge.blue').first().textContent()).trim();
  expect(teamCode).toMatch(/^[A-Z2-9]{7}$/);
  await page.screenshot({ path: 'shots/01-coach-teams.png', fullPage: true });
});

test('rower signs up with the team code and lands on the dashboard', async ({ browser, request }) => {
  rowerCtx = await browser.newContext({ storageState: englishState });
  const page = await rowerCtx.newPage();
  await signupUI(page, request, { email: 'ann@e2e.com', name: 'Ann Rower', type: 'rower', teamCode });
  await page.goto(`${BASE}/#/teams`);
  await expect(page.getByText("Coach Carla's Team")).toBeVisible();
});

let assignmentHref = '';

test('coach assigns a workout to the whole team', async () => {
  const page = await coachCtx.newPage();
  await page.goto(`${BASE}/#/teams`);
  await page.getByRole('link', { name: 'Open', exact: true }).first().click();
  await expect(page.locator('#assignBtn')).toBeVisible();
  await page.fill('#aName', 'E2E 2k test');
  await page.selectOption('#aType', 'distance');
  await page.fill('#aV1', '2000');
  await page.click('#assignBtn');
  await expect(page.getByText('Assigned to the whole team.')).toBeVisible();
  await expect(page.getByText('E2E 2k test')).toBeVisible();
  await expect(page.locator('.badge.gray', { hasText: 'Ann Rower' })).toBeVisible(); // not completed yet
  assignmentHref = await page.locator('a', { hasText: 'Watch live' }).first().getAttribute('href');
  await page.screenshot({ path: 'shots/02-coach-team.png', fullPage: true });
});

test('rower rows the assignment on the simulator; coach watches live; AI feedback appears', async () => {
  const coachPage = await coachCtx.newPage();
  await coachPage.goto(`${BASE}/${assignmentHref}`);
  await expect(coachPage.locator('h1')).toContainText('E2E 2k test');

  const page = await rowerCtx.newPage();
  await page.goto(`${BASE}/#/`);
  const rowLink = page.locator('a', { hasText: 'Row it' }).first();
  await expect(rowLink).toBeVisible();
  const href = await rowLink.getAttribute('href');
  await page.goto(`${BASE}/${href}&sim_speed=45&sim_pace=125`);
  await expect(page.getByText('E2E 2k test')).toBeVisible();

  await page.click('#simBtn');
  await page.click('[data-prof="fly_and_die"]'); // §11.4 started_too_hard demo
  await page.click('#simStart');

  // live metrics tick
  await expect(page.locator('#mDist')).not.toHaveText('0', { timeout: 10000 });
  await expect(page.locator('#mPace')).not.toHaveText('–:––');

  // coach's live grid shows Ann's tile with data (§2.3)
  await expect(coachPage.locator('.rower-tile', { hasText: 'Ann Rower' })).toBeVisible({ timeout: 15000 });
  await expect(coachPage.locator('.rower-tile .big').first()).not.toHaveText('–:––');
  await coachPage.screenshot({ path: 'shots/03-coach-live.png', fullPage: true });

  // simulator finishes (2000m at ~2:05 pace, 45x speed ≈ 12s) → auto-save + AI feedback
  await expect(page.locator('#afterArea')).toContainText('AI-generated feedback', { timeout: 30000 });
  await expect(page.locator('#afterArea')).toContainText('went out hard');
  await page.screenshot({ path: 'shots/04-rower-feedback.png', fullPage: true });

  // coach leaderboard now shows a finished entry (§2.4 persists post-workout)
  await expect(coachPage.locator('#lb .lb-row', { hasText: 'Ann Rower' })).toBeVisible({ timeout: 10000 });
  await expect(coachPage.locator('#lb')).toContainText('finished');
  await coachPage.close();

  // history + detail with splits, force curves, stored AI feedback
  await page.goto(`${BASE}/#/history`);
  await expect(page.locator('.badge.amber', { hasText: 'started too hard' })).toBeVisible();
  await page.click('.card.list-item');
  await expect(page.locator('h3', { hasText: 'Pacing feedback' })).toBeVisible();
  await expect(page.locator('#splitChart')).toBeVisible();
  await expect(page.locator('#forceChart')).toBeVisible();
  await page.screenshot({ path: 'shots/05-workout-detail.png', fullPage: true });
  await page.close();
});

test('completion shows on the coach roster view', async () => {
  const page = await coachCtx.newPage();
  await page.goto(`${BASE}/#/teams`);
  await page.getByRole('link', { name: 'Open', exact: true }).first().click();
  await expect(page.locator('.badge.green', { hasText: 'Ann Rower' })).toBeVisible();
  await page.close();
});

test('rower does the daily wellness check-in and sees trends', async () => {
  const page = await rowerCtx.newPage();
  await page.goto(`${BASE}/#/wellness`);
  await page.locator('#soreness [data-v="4"]').click();
  await page.locator('#quality [data-v="4"]').click();
  await page.click('#save');
  await expect(page.getByText(/Checked in|updated/)).toBeVisible();
  // same-day → edit mode, not a duplicate
  await page.reload();
  await expect(page.getByText('editing updates the same entry')).toBeVisible();
  await page.screenshot({ path: 'shots/06-wellness.png', fullPage: true });
  await page.close();
});

test('AI coach recommendation appears on the dashboard with disclosure — and no raw identifiers', async () => {
  const page = await rowerCtx.newPage();
  await page.goto(`${BASE}/#/`);
  await expect(page.getByText("Today's coach recommendation")).toBeVisible();
  await expect(page.getByText('AI-generated').first()).toBeVisible(); // machine-generated disclosure
  // The card must never leak internal enum values (e.g. "steady_state"):
  // every visible word is human language, not a snake_case identifier.
  const cardText = await page.locator('.ai-card').first().innerText();
  expect(cardText).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
  await page.screenshot({ path: 'shots/07-dashboard.png', fullPage: true });
  await page.close();
});

test('research toggle flips off in settings; CSV export works', async () => {
  const page = await rowerCtx.newPage();
  await page.goto(`${BASE}/#/settings`);
  await expect(page.locator('#researchOptIn')).toBeChecked();
  await page.locator('#researchOptIn + .sl').click(); // visible switch face
  // Target the toast specifically — the settings blurb also contains the
  // words "opted out", which trips strict-mode locators.
  await expect(page.locator('.toast', { hasText: 'Opted out' })).toBeVisible();
  const dl = page.waitForEvent('download');
  await page.click('#exportBtn');
  expect((await dl).suggestedFilename()).toBe('rowpoint-export.csv');
  await page.screenshot({ path: 'shots/08-settings.png', fullPage: true });
  await page.close();
});

test('admin dashboard: owner email gets stats, others are blocked', async ({ browser, request }) => {
  const ctx = await browser.newContext({ storageState: englishState });
  const page = await ctx.newPage();
  await signupUI(page, request, { email: 'lambert.venema2027@gmail.com', name: 'Lambert', type: 'coach' });
  await page.goto(`${BASE}/#/admin`);
  await expect(page.locator('.stat-tile', { hasText: 'total users' })).toBeVisible();
  await page.click('[data-tab="audit"]');
  await expect(page.locator('code', { hasText: 'stats.view' }).first()).toBeVisible(); // audit logged
  await page.click('[data-tab="research"]');
  await expect(page.getByText('baseline-2026').first()).toBeVisible();
  await page.click('#rQuery');
  await expect(page.locator('#rOut')).toContainText('pseudonymous', { timeout: 5000 });
  await page.screenshot({ path: 'shots/09-admin.png', fullPage: true });

  // a normal account is blocked from the admin page
  const rowerPage = await rowerCtx.newPage();
  await rowerPage.goto(`${BASE}/#/admin`);
  await expect(rowerPage.getByText('Admin access requires the Admin role')).toBeVisible();
  await rowerPage.close();
  await ctx.close();
});
