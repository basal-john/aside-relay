import { test, expect, SESSION_A } from './fixture';

const SWITCH = '#aside-relay-haptics-switch';
const isPhone = (name: string) => name === 'mobile-webkit';

test.describe('haptics', () => {
  test('desktop gets no overlays', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo.project.name), 'desktop only');
    await page.goto('/');
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
    await expect(page.locator('[data-haptic-trigger]')).toHaveCount(0);
    await expect(page.locator(SWITCH)).toHaveCount(0);
  });

  test('a tap lands on the overlay, toggles the switch and still opens the control', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo.project.name), 'phone only');
    await page.goto('/');
    const conversations = page.getByRole('button', { name: 'Open conversations' });
    const overlay = conversations.locator(`:scope > label[data-haptic-trigger][for="aside-relay-haptics-switch"]`);
    await expect(overlay).toHaveCount(1);
    const box = (await conversations.boundingBox())!;
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.hasAttribute('data-haptic-trigger'), { x: box.x + box.width / 2, y: box.y + box.height / 2 })).toBe(true);
    const before = await page.locator(SWITCH).isChecked();
    await conversations.tap();
    await expect(page.getByRole('heading', { name: 'Chats', level: 1 })).toBeVisible();
    expect(await page.locator(SWITCH).isChecked()).toBe(!before);
  });

  test('a tapped Send toggles the switch and sends exactly once', async ({ page, mockAside }, testInfo) => {
    test.skip(!isPhone(testInfo.project.name), 'phone only');
    await page.goto(`/c/${SESSION_A}`);
    await expect(page.getByRole('article', { name: 'Response' })).toContainText('Hello from the assistant.');
    mockAside.pauseRuns = true;
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('Haptic send');
    const send = page.getByRole('button', { name: 'Send message' });
    await expect(send.locator(':scope > label[data-haptic-trigger]')).toHaveCount(1);
    const before = await page.locator(SWITCH).isChecked();
    await send.tap();
    await expect(composer).toHaveValue('');
    expect(await page.locator(SWITCH).isChecked()).toBe(!before);
    await page.waitForTimeout(600);
    expect(mockAside.socketMessages.filter(message => message.op === 'continue')).toHaveLength(1);
    mockAside.releaseRun();
  });

  test('disabled controls get no overlay', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo.project.name), 'phone only');
    await page.goto(`/c/${SESSION_A}`);
    const send = page.getByRole('button', { name: 'Send message' });
    await expect(send).toBeDisabled();
    await page.waitForTimeout(300);
    await expect(send.locator('[data-haptic-trigger]')).toHaveCount(0);
  });

  test('turning haptics off removes every overlay', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo.project.name), 'phone only');
    await page.addInitScript(() => localStorage.setItem('aside-relay.haptics', 'off'));
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Open conversations' })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.locator('[data-haptic-trigger]')).toHaveCount(0);
    await expect(page.locator(SWITCH)).toHaveCount(0);
  });
});
