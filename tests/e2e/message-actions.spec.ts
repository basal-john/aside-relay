import { test, expect, SESSION_A, SIDECHAT } from './fixture';

test.beforeEach(async ({ page }) => {
  await page.goto(`/c/${SESSION_A}`);
  await expect(page.getByRole('article', { name: 'Response' })).toContainText('Hello from the assistant.');
});

async function openMessageMenu(page: import('@playwright/test').Page, label: 'Your message' | 'Response', longPress = false) {
  const message = page.getByRole('article', { name: label }).first();
  if (longPress) {
    const box = await message.boundingBox();
    if (!box) throw new Error('Message is not rendered.');
    const point = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    await message.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 7, isPrimary: true, button: 0, ...point });
    const menu = page.getByRole('menu', { name: 'Message options' });
    await expect(menu).toBeVisible();
    await message.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 7, isPrimary: true, button: 0, ...point });
    await expect(menu).toBeVisible();
    return menu;
  }
  await message.focus();
  await message.press('Shift+F10');
  const menu = page.getByRole('menu', { name: 'Message options' });
  await expect(menu).toBeVisible();
  return menu;
}

test('long press menu remains open after release and edits a user message', async ({ page, mockAside }) => {
  const menu = await openMessageMenu(page, 'Your message', true);
  await menu.getByRole('menuitem', { name: 'Edit message' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit message' });
  await dialog.getByRole('textbox', { name: 'Message' }).fill('Edited user message');
  await dialog.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText('Message updated.')).toBeVisible();
  expect(mockAside.calls.some(call => call.path === `/api/native/sessions/${SESSION_A}/command` && Reflect.get(call.body as object, 'command') === 'edit-user-message' && Reflect.get(call.body as object, 'seq') === 0)).toBe(true);
});

test('assistant actions add context, navigate turns, and create a native side chat', async ({ page, mockAside }) => {
  let menu = await openMessageMenu(page, 'Response');
  await menu.getByRole('menuitem', { name: 'Add to chat' }).click();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(/> Hello from the assistant\./);

  menu = await openMessageMenu(page, 'Response');
  await menu.getByRole('menuitem', { name: /Jump to turn/ }).click();
  await expect(page.getByRole('dialog', { name: 'Jump to turn' })).toBeVisible();
  await page.getByRole('button', { name: 'Hello Aside' }).click();

  menu = await openMessageMenu(page, 'Response');
  await menu.getByRole('menuitem', { name: 'Ask in side chat' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ask in side chat' });
  await dialog.getByRole('textbox').fill('Explain this response');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${SIDECHAT}$`));
  expect(mockAside.calls.some(call => call.path === `/api/native/sessions/${SESSION_A}/command` && Reflect.get(call.body as object, 'command') === 'sidechat')).toBe(true);
});
