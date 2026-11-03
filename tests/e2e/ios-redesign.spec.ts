import type { Page } from '@playwright/test';
import { test, expect, SESSION_A, SESSION_B } from './fixture';

declare const process: { env: Record<string, string | undefined> };

const isPhone = (name: string) => name === 'mobile-webkit';

async function rememberLastChat(page: Page) {
  await page.addInitScript(id => { localStorage.setItem('lastSession', id); localStorage.setItem('lastSessionMode', 'session'); }, SESSION_A);
}

async function setVisibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate(value => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

async function expectBlankChat(page: Page) {
  await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Response' })).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
}

async function openChats(page: Page) {
  await page.getByRole('button', { name: 'Open conversations' }).click();
  await expect(page.getByRole('heading', { name: 'Chats', level: 1 })).toBeVisible();
}

test.describe('smoke', () => {
  test('launch opens a blank chat even when a previous chat was remembered', async ({ page }) => {
    await rememberLastChat(page);
    await page.goto('/');
    await expectBlankChat(page);
    await expect(page.getByRole('group', { name: 'Starter prompts' }).getByRole('button')).toHaveCount(4);
  });

  test('a chat link still opens that chat', async ({ page }) => {
    await page.goto(`/c/${SESSION_A}`);
    await expect(page.getByRole('article', { name: 'Response' })).toContainText('Hello from the assistant.');
    await expect(page.getByRole('heading', { name: 'What can I help with?' })).toHaveCount(0);
  });

  test('a starter prompt fills the composer without sending', async ({ page, mockAside }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Summarise a page/ }).click();
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Summarise the page in my current tab.');
    expect(mockAside.socketMessages.filter(message => message.op === 'run')).toHaveLength(0);
  });

  test('the header title is the model and opens the model picker', async ({ page }, testInfo) => {
    await page.goto(`/c/${SESSION_A}`);
    const title = page.locator('#header').getByRole('button', { name: /Choose model, GPT-6\.1 Sol/ });
    await expect(title).toBeVisible();
    await title.click();
    const dialog = page.locator('[data-app-dialog]');
    await expect(dialog.getByRole('heading', { name: 'Models' })).toBeVisible();
    await expect(dialog).toHaveAttribute('data-dialog-variant', isPhone(testInfo.project.name) ? 'sheet' : 'card');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('phone tabs move between Chats, Settings and Browser', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo.project.name), 'The tab bar only exists on phones.');
    await page.goto('/');
    await openChats(page);
    const tabs = page.getByRole('navigation', { name: 'Sections' });
    await expect(tabs.getByRole('button', { name: 'Chats' })).toHaveAttribute('aria-current', 'page');

    await tabs.getByRole('button', { name: 'Settings' }).click();
    const settings = page.locator('[data-app-dialog][data-dialog-variant="page"]');
    await expect(settings.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');

    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Browser' }).click();
    await expect(page.getByRole('dialog', { name: 'Browser' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Browser' }).getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Browser' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('navigation', { name: 'Sections' })).toHaveCount(1);

    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Chats' }).click();
    await expect(page.getByRole('heading', { name: 'Chats', level: 1 })).toBeVisible();
    await page.getByRole('complementary', { name: 'Conversations' }).getByRole('button', { name: /^Alpha conversation/ }).first().click();
    await expect(page.getByRole('article', { name: 'Response' })).toContainText('Hello from the assistant.');
    await expect(page.getByRole('navigation', { name: 'Sections' })).toHaveCount(0);
  });
});

test.describe('edge cases', () => {
  test('returning after 30 minutes away starts a blank chat', async ({ page }) => {
    await page.clock.install();
    await page.goto(`/c/${SESSION_A}`);
    await expect(page.getByRole('article', { name: 'Response' })).toContainText('Hello from the assistant.');
    await setVisibility(page, 'hidden');
    await page.clock.fastForward('31:00');
    await setVisibility(page, 'visible');
    await expectBlankChat(page);
  });

  test('a short trip away keeps the open chat', async ({ page }) => {
    await page.clock.install();
    await page.goto(`/c/${SESSION_A}`);
    await expect(page.getByRole('article', { name: 'Response' })).toContainText('Hello from the assistant.');
    await setVisibility(page, 'hidden');
    await page.clock.fastForward('05:00');
    await setVisibility(page, 'visible');
    await expect(page).toHaveURL(new RegExp(`/c/${SESSION_A}$`));
    await expect(page.getByRole('article', { name: 'Response' })).toContainText('Hello from the assistant.');
  });

  test('an unsent draft keeps the chat open after a long time away', async ({ page }) => {
    await page.clock.install();
    await page.goto(`/c/${SESSION_A}`);
    await expect(page.getByRole('article', { name: 'Response' })).toContainText('Hello from the assistant.');
    await page.getByRole('textbox', { name: 'Message' }).fill('Half-written thought');
    await setVisibility(page, 'hidden');
    await page.clock.fastForward('45:00');
    await setVisibility(page, 'visible');
    await expect(page).toHaveURL(new RegExp(`/c/${SESSION_A}$`));
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Half-written thought');
  });

  test('a notification tap after a long time away opens its chat, not a blank one', async ({ page }) => {
    await page.clock.install();
    await page.goto(`/c/${SESSION_A}`);
    await expect(page.getByRole('article', { name: 'Response' })).toContainText('Hello from the assistant.');
    await setVisibility(page, 'hidden');
    await page.clock.fastForward('40:00');
    await page.evaluate(id => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'open-conversation', url: `/c/${id}` } })), SESSION_B);
    await setVisibility(page, 'visible');
    await expect(page).toHaveURL(new RegExp(`/c/${SESSION_B}$`));
    await expect(page.getByRole('article', { name: 'Response' })).toContainText('I am waiting for approval.');
  });

  test('a blank chat reached by the back button stays blank', async ({ page }) => {
    await page.goto(`/c/${SESSION_A}`);
    await expect(page.getByRole('article', { name: 'Response' })).toContainText('Hello from the assistant.');
    await page.locator('#header').getByRole('button', { name: 'New chat' }).click();
    await expectBlankChat(page);
    await page.goBack();
    await expect(page.getByRole('article', { name: 'Response' })).toContainText('Hello from the assistant.');
    await page.goForward();
    await expectBlankChat(page);
  });

  test('phone controls are at least 44 points and nothing scrolls sideways at 320 px', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo.project.name), 'Touch sizing applies to phones.');
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(`/c/${SESSION_A}`);
    await expect(page.getByRole('article', { name: 'Response' })).toContainText('Hello from the assistant.');
    const tooSmall = async () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#header button, #composer button, nav[aria-label="Sections"] button')]
      .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
      .map(element => ({ label: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '', box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.width < 44 || box.height < 44)
      .map(({ label, box }) => `${label} ${Math.round(box.width)}x${Math.round(box.height)}`));
    const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(await tooSmall()).toEqual([]);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await openChats(page);
    expect(await tooSmall()).toEqual([]);
    expect(await overflow()).toBeLessThanOrEqual(0);
  });
});

test.describe('visual capture', () => {
  test.skip(!process.env.REDESIGN_SHOTS, 'Set REDESIGN_SHOTS=<folder> to save review screenshots.');
  for (const theme of ['light', 'dark'] as const) {
    test(`phone screens in ${theme} mode`, async ({ page, mockAside }, testInfo) => {
      test.skip(!isPhone(testInfo.project.name), 'Captured on the phone project only.');
      const folder = process.env.REDESIGN_SHOTS ?? '';
      const shot = (name: string) => page.screenshot({ path: `${folder}/${theme}-${name}.png` });
      await page.addInitScript(value => localStorage.setItem('asideTheme', value), theme);
      mockAside.workspace = { status: 'running', summary: 'Checking the release.', agents: [{ id: 'sessionagent001', title: 'Check accessibility', status: 'running' }, { id: 'sessionagent002', title: 'Read the release notes', status: 'completed' }], todos: [{ id: 't1', content: 'Review mobile layout', status: 'completed' }, { id: 't2', content: 'Check browser controls', status: 'in_progress' }], outputs: [] };
      await page.goto('/');
      await expectBlankChat(page);
      await shot('01-start');
      await page.goto(`/c/${SESSION_A}`);
      await expect(page.getByRole('article', { name: 'Response' })).toContainText('Hello from the assistant.');
      await shot('02-chat');
      await page.locator('#header').getByRole('button', { name: /Choose model/ }).click();
      await expect(page.locator('[data-app-dialog]').getByRole('heading', { name: 'Models' })).toBeVisible();
      await page.waitForTimeout(400);
      await shot('03-model-sheet');
      await page.keyboard.press('Escape');
      await openChats(page);
      await page.waitForTimeout(400);
      await shot('04-chats');
      await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Settings' }).click();
      await expect(page.locator('[data-app-dialog][data-dialog-variant="page"]').getByRole('heading', { name: 'Settings' })).toBeVisible();
      await page.waitForTimeout(400);
      await shot('05-settings');
      await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Browser' }).click();
      await expect(page.getByRole('dialog', { name: 'Browser' })).toBeVisible();
      await page.waitForTimeout(600);
      await shot('07-browser');
      await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Chats' }).click();
      await page.getByRole('complementary', { name: 'Conversations' }).getByRole('button', { name: /^Bravo conversation/ }).first().click();
      await expect(page.getByRole('article', { name: 'Response' })).toContainText('I am waiting for approval.');
      await page.waitForTimeout(400);
      await shot('08-run-status');
      await page.getByRole('textbox', { name: 'Message' }).fill('/');
      await page.waitForTimeout(300);
      await shot('09-slash');
    });
  }
});
