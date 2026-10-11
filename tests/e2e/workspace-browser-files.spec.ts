import { BROWSER_TAB_TITLE, test, expect, SESSION_A } from './fixture';

test('subagent approval omits always-allow and resolves optimistically', async ({ page, mockAside }) => {
  mockAside.workspace = {
    status: 'suspended', summary: 'Waiting for permission.', agents: [], todos: [], outputs: [],
    suspension: { kind: 'permission-approval', toolCallId: 'tool-approval-1', title: 'Approval needed', request: { message: 'Allow browser access?', source: { taskId: 'subagent-task-1' } } },
  };
  await page.goto(`/c/${SESSION_A}`);
  await page.getByRole('button', { name: /Approval needed/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Approval needed' });
  await expect(dialog.getByText('Do not ask again')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Allow' }).click();
  await expect(dialog).toBeHidden();
  expect(mockAside.calls.some(call => call.path.endsWith('/command') && Reflect.get(call.body as object, 'command') === 'resolve-suspension' && Reflect.get(Reflect.get(call.body as object, 'response') as object, 'always') === false)).toBe(true);
});

test('browser preview supports keyboard movement, minimize, restore, expand, and close', async ({ page }) => {
  await page.goto(`/c/${SESSION_A}`);
  const preview = page.getByRole('region', { name: 'Browser preview' });
  await expect(preview).toBeVisible();
  async function stablePreviewBox() {
    let previous: Awaited<ReturnType<typeof preview.boundingBox>>;
    let current: Awaited<ReturnType<typeof preview.boundingBox>>;
    await expect.poll(async () => {
      current = await preview.boundingBox();
      const isStable = !!current && !!previous && Math.abs(current.x - previous.x) < .5 && Math.abs(current.y - previous.y) < .5 && Math.abs(current.width - previous.width) < .5;
      previous = current;
      return isStable;
    }).toBe(true);
    return current!;
  }
  const initial = await stablePreviewBox();
  const handle = page.getByRole('button', { name: `Open browser preview: ${BROWSER_TAB_TITLE}` });
  await handle.focus();
  await handle.press('ArrowLeft');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('asideBrowserPreviewPosition'))).not.toBeNull();
  const moved = await stablePreviewBox();
  expect(Math.round(moved.x - initial.x)).toBe(-20);
  await page.reload();
  await expect(preview).toBeVisible();
  const restored = await stablePreviewBox();
  expect({ x: Math.round(restored.x - moved.x), y: Math.round(restored.y - moved.y) }).toEqual({ x: 0, y: 0 });
  await page.getByRole('button', { name: 'Minimize browser preview' }).click();
  await expect(page.getByRole('button', { name: 'Expand browser preview' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Restore browser preview' }).click();
  await page.getByRole('button', { name: 'Expand browser preview' }).click();
  const browser = page.getByRole('dialog', { name: 'Browser' });
  await expect(browser).toBeVisible();
  await browser.getByRole('button', { name: 'Close browser', exact: true }).click();
  await page.getByRole('button', { name: 'Close browser preview', exact: true }).click();
  await expect(preview).toHaveCount(0);
});

test('files menu opens a real artifact preview and settings theme persists', async ({ page }) => {
  await page.goto(`/c/${SESSION_A}`);
  await page.getByRole('button', { name: 'Minimize browser preview' }).click();
  const drawerButton = page.getByRole('button', { name: 'Open conversations' });
  if (await drawerButton.isVisible()) await drawerButton.click();
  const sidebar = page.getByRole('complementary', { name: 'Conversations' });
  await sidebar.getByRole('button', { name: 'Options for Alpha conversation' }).click();
  await page.getByRole('menuitem', { name: 'Files & outputs' }).click();
  const files = page.getByRole('dialog', { name: 'Files' });
  await files.getByRole('button', { name: /result\.txt/ }).click();
  await expect(files).toContainText('E2E file content');
  await page.keyboard.press('Escape');
  await expect(files).toBeHidden();

  if (await drawerButton.isVisible()) await drawerButton.click();
  await page.getByRole('button', { name: /Settings/ }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const darkMode = settings.getByRole('switch', { name: 'Dark mode' });
  await darkMode.click();
  await expect(darkMode).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('asideTheme'))).toBe('dark');
});
