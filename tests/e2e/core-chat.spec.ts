import { test, expect, NEW_SESSION, SESSION_A } from './fixture';

test.beforeEach(async ({ page }) => {
  await page.goto(`/c/${SESSION_A}`);
  await expect(page.getByRole('article', { name: 'Response' })).toContainText('Hello from the assistant.');
});

test('send clears and blurs immediately, uses one action button, then streams', async ({ page, mockAside }, testInfo) => {
  mockAside.pauseRuns = true;
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('A touch-safe message');
  const send = page.getByRole('button', { name: 'Send message' });
  if (testInfo.project.name === 'mobile-webkit') await send.tap();
  else await send.click();

  await expect(composer).toHaveValue('');
  await expect(composer).not.toBeFocused();
  await expect(page.locator('#composer').getByRole('button', { name: /Stop response/ })).toHaveCount(1);
  await expect(page.locator('#composer button:is(#send, [aria-label="Stop response"])')).toHaveCount(1);

  mockAside.releaseRun();
  await expect(page.getByRole('article', { name: 'Response' }).last()).toContainText('Streamed assistant reply.');
  await expect(page.getByRole('status', { name: 'Working' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
  expect(mockAside.socketMessages.filter(message => message.op === 'continue')).toHaveLength(1);
});

test('new chat first send becomes the selected routable session', async ({ page, mockAside }) => {
  const drawerButton = page.getByRole('button', { name: 'Open conversations' });
  if (await drawerButton.isVisible()) await drawerButton.click();
  await page.getByRole('complementary', { name: 'Conversations' }).getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);

  mockAside.pauseRuns = true;
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Create a real conversation');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(composer).toHaveValue('');
  mockAside.releaseRun();

  await expect(page).toHaveURL(new RegExp(`/c/${NEW_SESSION}$`));
  await expect(page.getByRole('article', { name: 'Response' }).last()).toContainText('Streamed assistant reply.');
  await expect.poll(() => page.evaluate(() => ({ id: localStorage.getItem('lastSession'), mode: localStorage.getItem('lastSessionMode') }))).toEqual({ id: NEW_SESSION, mode: 'session' });
  expect(mockAside.socketMessages.some(message => message.op === 'run' && message.sessionId === undefined)).toBe(true);
});

test('failed delivery restores the exact multiline draft', async ({ page, mockAside }) => {
  mockAside.failNextSend = true;
  const composer = page.getByRole('textbox', { name: 'Message' });
  const draft = 'first line\nsecond line';
  await composer.fill(draft);
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect(composer).toHaveValue(draft);
  await expect(page.getByRole('alert')).toContainText('Something went wrong. Please try again.');
});

test('model choice is persisted through the session model API', async ({ page, mockAside }) => {
  await page.locator('#composer').getByRole('button', { name: 'Add to message' }).click();
  await page.getByRole('dialog', { name: 'Add to message' }).getByRole('button', { name: 'Model, GPT-6.1 Sol · High' }).click();
  const dialog = page.getByRole('dialog', { name: 'Models' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'GPT-6 Luna, openai-codex' }).click();
  await expect(dialog).toHaveCount(0);

  await page.locator('#composer').getByRole('button', { name: 'Add to message' }).click();
  await expect(page.getByRole('dialog', { name: 'Add to message' }).getByRole('button', { name: 'Model, GPT-6 Luna · Low' })).toBeVisible();
  expect(mockAside.calls.some(call => call.method === 'PUT' && call.path === `/api/sessions/${SESSION_A}/model` && Reflect.get(call.body as object, 'modelId') === 'gpt-6-luna')).toBe(true);
});
