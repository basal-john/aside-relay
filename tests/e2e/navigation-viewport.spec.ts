import { test, expect, SESSION_A, SESSION_B } from './fixture';

test('notification navigation keeps the shell and loads inside the conversation', async ({ page }) => {
  let release: () => void = () => {};
  const waiting = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/sessions/${SESSION_B}/messages**`, async route => {
    await waiting;
    await route.fallback();
  });
  await page.goto(`/c/${SESSION_A}`);
  await expect(page.getByRole('article', { name: 'Response' })).toBeVisible();
  await page.evaluate(id => {
    navigator.serviceWorker.dispatchEvent(new MessageEvent('message', {
      data: { type: 'open-conversation', url: `${location.origin}/c/${id}` },
    }));
  }, SESSION_B);
  await expect(page).toHaveURL(new RegExp(`/c/${SESSION_B}$`));
  await expect(page.locator('main').getByRole('status').filter({ hasText: 'Loading messages' })).toBeVisible();
  await expect(page.locator('header')).toBeVisible();
  await expect(page.locator('#composer')).toBeVisible();
  release();
  await expect(page.getByRole('article', { name: 'Response' })).toContainText('I am waiting for approval.');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lastSession'))).toBe(SESSION_B);
});

test('conversation remains at the bottom through composer focus and viewport resize', async ({ page, mockAside }) => {
  const messages = mockAside.messages.get(SESSION_A)!;
  for (let seq = 2; seq < 80; seq += 1) {
    messages.push({ seq, role: seq % 2 ? 'assistant' : 'user', ts: Date.now() + seq,
      responseId: seq % 2 ? `viewport-response-${seq}` : undefined,
      blocks: [{ type: 'text', text: `Viewport message ${seq}\nSecond line of message ${seq}.` }] });
  }
  await page.goto(`/c/${SESSION_A}`);
  const last = page.getByRole('article', { name: 'Response' }).last();
  await expect(last).toContainText('Viewport message 79');
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('A fixed viewport is required for this scenario.');
  const bottomGap = () => page.locator('#chatScroll').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
  await expect.poll(bottomGap).toBeLessThanOrEqual(4);
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Multiline draft\nSecond draft line');
  await page.setViewportSize({ width: viewport.width, height: Math.max(400, viewport.height - 300) });
  await expect.poll(bottomGap).toBeLessThanOrEqual(4);
  await composer.blur();
  await page.setViewportSize(viewport);
  await expect.poll(bottomGap).toBeLessThanOrEqual(4);
  await expect(composer).toHaveValue('Multiline draft\nSecond draft line');
  await expect(last).toBeVisible();
  const header = await page.locator('header').boundingBox();
  expect(header?.y).toBe(0);
});
