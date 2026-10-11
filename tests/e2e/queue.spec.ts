import { test, expect, SESSION_A } from './fixture';

test.beforeEach(async ({ page, mockAside }) => {
  mockAside.running.add(SESSION_A);
  mockAside.sessions[0].status = 'running';
  await page.goto(`/c/${SESSION_A}`);
  await expect(page.getByRole('status', { name: 'Working' })).toBeVisible();
});

test('queued follow-up can be edited and steered without losing optimistic state', async ({ page, mockAside }) => {
  const releaseEnqueue = mockAside.holdNextRequest('POST', `/api/sessions/${SESSION_A}/followups`);
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Queued follow-up');
  await page.getByRole('button', { name: 'Queue message' }).click();
  const queued = page.getByRole('article', { name: 'Queued message 1' });
  try { await expect(queued).toContainText('Queued follow-up'); }
  finally { releaseEnqueue(); }
  await page.getByRole('button', { name: 'Minimize browser preview' }).click();

  await queued.getByRole('button', { name: 'Options for queued message 1' }).click();
  await page.getByRole('menuitem', { name: 'Edit message' }).click();
  const editor = page.getByRole('textbox', { name: 'Edit queued message 1' });
  await editor.fill('Edited follow-up');
  await queued.getByRole('button', { name: 'Save' }).click();
  await expect(queued).toContainText('Edited follow-up');

  const releaseSteer = mockAside.holdNextRequest('POST', /\/api\/sessions\/[^/]+\/followups\/[^/]+\/steer$/);
  await queued.getByRole('button', { name: 'Options for queued message 1' }).click();
  await page.getByRole('menuitem', { name: 'Steer instead' }).click();
  try { await expect(queued).toContainText('Sending…'); }
  finally { releaseSteer(); }
  await expect(queued).toHaveCount(0);
  expect(mockAside.calls.some(call => call.method === 'POST' && /\/followups\/[^/]+\/steer$/.test(call.path))).toBe(true);
});

test('steer preference changes submission delivery and queued messages can be canceled', async ({ page, mockAside }) => {
  mockAside.preferences.followUpBehavior = 'steer';
  await page.reload();
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Steer by default');
  await page.getByRole('button', { name: 'Steer message' }).click();
  await expect.poll(() => mockAside.calls.some(call => call.method === 'POST' && call.path === `/api/sessions/${SESSION_A}/followups` && Reflect.get(call.body as object, 'delivery') === 'steer')).toBe(true);

  const queued = page.getByRole('article', { name: 'Queued message 1' });
  await page.getByRole('button', { name: 'Minimize browser preview' }).click();
  const releaseCancel = mockAside.holdNextRequest('DELETE', /\/api\/sessions\/[^/]+\/followups\/[^/]+$/);
  await queued.getByRole('button', { name: 'Options for queued message 1' }).click();
  await page.getByRole('menuitem', { name: 'Cancel message' }).click();
  try { await expect(queued).toHaveCount(0); }
  finally { releaseCancel(); }
});

test('paused queue resumes before the request completes', async ({ page, mockAside }) => {
  mockAside.queuePaused = true;
  await page.reload();
  const paused = page.getByRole('status').filter({ hasText: 'Queue paused' });
  await expect(paused).toBeVisible();
  await page.getByRole('button', { name: 'Minimize browser preview' }).click();
  const releaseResume = mockAside.holdNextRequest('POST', `/api/sessions/${SESSION_A}/followups/resume`);
  await paused.getByRole('button', { name: 'Resume' }).click();
  try { await expect(paused).toHaveCount(0); }
  finally { releaseResume(); }
});
