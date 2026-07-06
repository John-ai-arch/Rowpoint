// Visual smoke pass over screens the main flow spec doesn't screenshot:
// builder validation, live row screen mid-workout, social, group feed.
import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:4381';
test.describe.configure({ mode: 'serial' });

async function makeUserApi(request, email, accountType = 'rower', extra = {}) {
  const su = await request.post(`${BASE}/api/auth/signup`, {
    data: { email, password: 'password123', displayName: extra.displayName || email.split('@')[0], accountType, ...extra },
  });
  const { token } = await su.json();
  const ob = await (await request.get(`${BASE}/api/dev/outbox?to=${email}`)).json();
  const code = ob.emails[0].body.match(/code is: (\d{6})/)[1];
  const v = await request.post(`${BASE}/api/auth/verify`, { data: { email, code } });
  return (await v.json());
}

async function loginUI(page, email) {
  await page.goto(`${BASE}/#/login`);
  await page.fill('#email', email);
  await page.fill('#password', 'password123');
  await page.click('#loginBtn');
  await expect(page.locator('h1')).toContainText('Hi,');
}

test('builder: instant validation feedback, both valid and invalid', async ({ page, request }) => {
  await makeUserApi(request, 'viz1@e2e.com');
  await loginUI(page, 'viz1@e2e.com');
  await page.goto(`${BASE}/#/builder`);
  await page.click('[data-t="intervals"]');
  await page.click('#addIv');
  await page.click('#dupIv');
  await expect(page.locator('#valMsg')).toContainText('Valid');
  // now make it invalid: distance below the PM5 minimum
  await page.locator('[data-f="workValue"]').first().fill('50');
  await expect(page.locator('#valMsg')).toContainText('≥ 100');
  await expect(page.locator('#rowNow')).toBeDisabled();
  await page.screenshot({ path: 'shots/10-builder.png', fullPage: true });
  // back to valid → row now hands the plan to the Row screen
  await page.locator('[data-f="workValue"]').first().fill('500');
  await expect(page.locator('#rowNow')).toBeEnabled();
  await page.click('#rowNow');
  await expect(page).toHaveURL(/#\/row/);
  await expect(page.getByText('3 × 500m / 60s rest')).toBeVisible();
});

test('live row screen mid-workout: big metrics, force curve, live values', async ({ page, request }) => {
  await makeUserApi(request, 'viz2@e2e.com');
  await loginUI(page, 'viz2@e2e.com');
  await page.goto(`${BASE}/#/row?sim_speed=3`);
  await page.click('#simBtn');
  await page.click('[data-prof="even"]');
  await page.click('#simStart');
  await expect(page.locator('#mDist')).not.toHaveText('0', { timeout: 10000 });
  await expect(page.locator('#mHr')).not.toHaveText('–', { timeout: 10000 });
  await page.waitForTimeout(2500); // let force curves render
  await page.screenshot({ path: 'shots/11-live-row.png', fullPage: true });
  // finish manually and confirm save + feedback path works from the button too
  await page.click('#finishBtn');
  await expect(page.locator('#afterArea')).toContainText('AI-generated feedback', { timeout: 15000 });
});

test('social + group: connect two users, group feed shows a completed workout', async ({ browser, request }) => {
  const a = await makeUserApi(request, 'viz3@e2e.com', 'rower', { displayName: 'Vera' });
  const b = await makeUserApi(request, 'viz4@e2e.com', 'rower', { displayName: 'Wim' });

  // Vera searches Wim, sends request
  const ctxA = await browser.newContext();
  const pA = await ctxA.newPage();
  await loginUI(pA, 'viz3@e2e.com');
  await pA.goto(`${BASE}/#/social`);
  await pA.fill('#q', 'viz4@e2e.com');
  await pA.click('#searchBtn');
  await pA.click('#reqBtn');
  await expect(pA.locator('.badge.amber', { hasText: 'request sent' })).toBeVisible();

  // Wim accepts in his own session
  const ctxB = await browser.newContext();
  const pB = await ctxB.newPage();
  await loginUI(pB, 'viz4@e2e.com');
  await pB.goto(`${BASE}/#/social`);
  await pB.click('[data-acc]');
  await expect(pB.getByText('Connected!')).toBeVisible();

  // Vera creates a group with Wim via API (prompt() is awkward in tests), then views it
  const g = await request.post(`${BASE}/api/social/groups`, {
    data: { name: 'Weekend ergs', memberIds: [b.user.id] },
    headers: { Authorization: `Bearer ${a.token}` },
  });
  const { groupId } = await g.json();

  // Wim completes a workout → feed event
  await request.post(`${BASE}/api/workouts/sync`, {
    data: {
      id: crypto.randomUUID(), totalDistanceM: 5000, totalTimeS: 1250, machineType: 'rower',
      splits: [500, 500, 500].map(() => ({ distanceM: 500, timeS: 125, avgPaceSPer500m: 125, avgStrokeRate: 22 })),
    },
    headers: { Authorization: `Bearer ${b.token}` },
  });

  await pA.goto(`${BASE}/#/group/${groupId}`);
  await expect(pA.getByText('Wim').first()).toBeVisible();
  await expect(pA.locator('.list-item', { hasText: 'completed' }).first()).toBeVisible();
  await pA.screenshot({ path: 'shots/12-group.png', fullPage: true });
  await pA.goto(`${BASE}/#/social`);
  await pA.screenshot({ path: 'shots/13-social.png', fullPage: true });
  await ctxA.close(); await ctxB.close();
});
