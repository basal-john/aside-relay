import { test, expect, SESSION_A } from './fixture';

test.beforeEach(async ({ page }) => {
  await page.clock.install();
  await page.goto(`/c/${SESSION_A}`);
  await expect(page.getByRole('article', { name: 'Response' })).toContainText('Hello from the assistant.');
});

const returnToForeground = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

test('a socket that stops sending heartbeats is replaced', async ({ page, mockAside }) => {
  await expect.poll(() => mockAside.socketConnections).toBe(1);

  await page.clock.runFor(45_000);
  expect(mockAside.socketConnections).toBe(1);

  await page.clock.runFor(20_000);
  await expect.poll(() => mockAside.socketConnections).toBe(2);
});

test('returning to the foreground replaces a socket that does not answer a ping', async ({ page, mockAside }) => {
  await expect.poll(() => mockAside.socketConnections).toBe(1);
  mockAside.answerPings = false;

  await returnToForeground(page);
  await expect.poll(() => mockAside.socketMessages.filter(message => message.op === 'ping').length).toBe(1);
  await page.clock.runFor(7_000);

  await expect.poll(() => mockAside.socketConnections).toBe(2);
});

test('returning to the foreground keeps a socket that answers a ping', async ({ page, mockAside }) => {
  await expect.poll(() => mockAside.socketConnections).toBe(1);

  await returnToForeground(page);
  await expect.poll(() => mockAside.socketMessages.filter(message => message.op === 'ping').length).toBe(1);
  await page.clock.runFor(7_000);

  expect(mockAside.socketConnections).toBe(1);
});
