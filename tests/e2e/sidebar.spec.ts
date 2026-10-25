import { test, expect, SESSION_A, SESSION_B } from './fixture';

async function openConversations(page: import('@playwright/test').Page) {
  const drawerButton = page.getByRole('button', { name: 'Open conversations' });
  if (await drawerButton.isVisible()) await drawerButton.click();
  return page.getByRole('complementary', { name: 'Conversations' });
}

test.beforeEach(async ({ page }) => {
  await page.goto(`/c/${SESSION_A}`);
  await expect(page.getByRole('article', { name: 'Response' })).toBeVisible();
});

test('native-only conversation options load pin details from the real details contract', async ({ page, mockAside }) => {
  const title = 'Native-only conversation';
  const id = 'nativeonlysession01';
  mockAside.sessions.unshift({ ...mockAside.sessions[0], id, title, isPinned: true, pinned: true });
  await page.route('**/api/sessions?*', route => {
    const items = mockAside.sessions.filter(session => session.id !== id);
    return route.fulfill({ json: { items, total: items.length, matched: items.length } });
  });
  const sidebar = await openConversations(page);
  await sidebar.getByRole('button', { name: 'Show all', exact: true }).click();
  await sidebar.getByRole('button', { name: `Options for ${title}`, exact: true }).click();
  await expect.poll(() => mockAside.calls.some(call => call.path === `/api/sessions/${id}/details`)).toBe(true);
  await expect(page.getByRole('menuitem', { name: 'Unpin conversation', exact: true })).toBeVisible();
});

test('show all sends server-side status and search filters', async ({ page, mockAside }) => {
  const sidebar = await openConversations(page);
  await sidebar.getByRole('button', { name: 'Show all' }).click();
  await sidebar.getByRole('combobox', { name: 'Filter by status' }).selectOption('suspended');
  await expect(sidebar.getByText('Bravo conversation')).toBeVisible();
  await expect(sidebar.getByText('Alpha conversation')).toHaveCount(0);

  await sidebar.getByRole('textbox', { name: 'Search conversations' }).fill('bravo');
  await expect.poll(() => mockAside.calls.some(call => call.path.includes('/api/native/sessions?') && call.path.includes('status=suspended') && call.path.includes('q=bravo'))).toBe(true);
});

test('session menu performs optimistic pin, rename, unread, and archive actions', async ({ page, mockAside }) => {
  const sidebar = await openConversations(page);
  const releasePin = mockAside.holdNextRequest('PATCH', `/api/sessions/${SESSION_B}`);
  await sidebar.getByRole('button', { name: 'Options for Bravo conversation' }).click();
  let menu = page.getByRole('menu', { name: 'Conversation options' });
  await menu.getByRole('menuitem', { name: 'Pin conversation' }).click();
  try {
    await sidebar.getByRole('button', { name: 'Options for Bravo conversation' }).click();
    await expect(page.getByRole('menuitem', { name: 'Unpin conversation' })).toBeVisible();
  } finally { releasePin(); }
  await expect.poll(() => mockAside.calls.some(call => call.method === 'PATCH' && call.path === `/api/sessions/${SESSION_B}` && Reflect.get(call.body as object, 'isPinned') === true)).toBe(true);
  await page.keyboard.press('Escape');

  await sidebar.getByRole('button', { name: 'Options for Bravo conversation' }).click();
  menu = page.getByRole('menu', { name: 'Conversation options' });
  await menu.getByRole('menuitem', { name: 'Rename' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename conversation' });
  await rename.getByRole('textbox', { name: 'Conversation name' }).fill('Renamed conversation');
  await rename.getByRole('button', { name: 'Save' }).click();
  await expect(sidebar.getByText('Renamed conversation')).toBeVisible();

  const releaseRead = mockAside.holdNextRequest('POST', `/api/native/sessions/${SESSION_B}/read`);
  await sidebar.getByRole('button', { name: 'Options for Renamed conversation' }).click();
  menu = page.getByRole('menu', { name: 'Conversation options' });
  await menu.getByRole('menuitem', { name: 'Mark as read' }).click();
  try {
    await sidebar.getByRole('button', { name: 'Options for Renamed conversation' }).click();
    await expect(page.getByRole('menuitem', { name: 'Mark as unread' })).toBeVisible();
  } finally { releaseRead(); }
  await expect.poll(() => mockAside.calls.some(call => call.path === `/api/native/sessions/${SESSION_B}/read`)).toBe(true);
  await page.keyboard.press('Escape');

  const releaseArchive = mockAside.holdNextRequest('POST', `/api/native/sessions/${SESSION_B}/archive`);
  await sidebar.getByRole('button', { name: 'Options for Renamed conversation' }).click();
  menu = page.getByRole('menu', { name: 'Conversation options' });
  await menu.getByRole('menuitem', { name: 'Archive' }).click();
  try { await expect(sidebar.getByText('Renamed conversation')).toHaveCount(0); }
  finally { releaseArchive(); }
  await expect.poll(() => mockAside.calls.some(call => call.path === `/api/native/sessions/${SESSION_B}/archive`)).toBe(true);
});

test('a delayed old page cannot append after the status filter changes', async ({ page, mockAside }) => {
  for (let index = 0; index < 55; index += 1) mockAside.sessions.push({ ...mockAside.sessions[2], id: `history${String(index).padStart(8, '0')}`, title: `History ${index}`, isPinned: false, pinned: false, mtime: Date.now() / 1000 - 300 - index });
  await page.reload();
  const release = mockAside.holdNextNativePage(50);
  const sidebar = await openConversations(page);
  await sidebar.getByRole('button', { name: 'Show all' }).click();
  await expect(sidebar.getByText('History 0')).toBeVisible();
  const scroller = sidebar.locator('[data-virtuoso-scroller="true"]');
  const showMore = sidebar.getByRole('button', { name: 'Show more' });
  await expect.poll(async () => {
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
    return showMore.count();
  }).toBe(1);
  await sidebar.getByRole('button', { name: 'Show more' }).click();
  await sidebar.getByRole('combobox', { name: 'Filter by status' }).selectOption('suspended');
  release();

  await expect(sidebar.getByText('Bravo conversation')).toBeVisible();
  await expect(sidebar.getByText('History 50')).toHaveCount(0);
});

test('failed read and archive mutations roll optimistic state back', async ({ page, mockAside }) => {
  mockAside.sessions.find(session => session.id === SESSION_B)!.unread = false;
  mockAside.nativeUnreadOverrides.set(SESSION_B, true);
  await page.reload();
  const sidebar = await openConversations(page);
  await sidebar.getByRole('button', { name: 'Show all' }).click();
  await expect(sidebar.getByText('Bravo conversation')).toBeVisible();
  const options = () => sidebar.getByRole('button', { name: 'Options for Bravo conversation' });

  const releaseRead = mockAside.holdNextRequest('POST', `/api/native/sessions/${SESSION_B}/read`, 503);
  await options().click();
  await page.getByRole('menuitem', { name: 'Mark as read' }).click();
  await options().click();
  await expect(page.getByRole('menuitem', { name: 'Mark as unread' })).toBeVisible();
  await page.keyboard.press('Escape');
  const releaseReadRefresh = mockAside.holdNativeRefreshes();
  releaseRead();
  try {
    await expect(page.getByRole('alert')).toContainText("Couldn't update the conversation");
    await options().click();
    await expect(page.getByRole('menuitem', { name: 'Mark as read' })).toBeVisible();
    await page.keyboard.press('Escape');
  } finally { releaseReadRefresh(); }
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);

  const releaseArchive = mockAside.holdNextRequest('POST', `/api/native/sessions/${SESSION_B}/archive`, 503);
  await options().click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(sidebar.getByText('Bravo conversation')).toHaveCount(0);
  const releaseArchiveRefresh = mockAside.holdNativeRefreshes();
  releaseArchive();
  try {
    await expect(page.getByRole('alert')).toContainText("Couldn't update the conversation");
    await expect(sidebar.getByText('Bravo conversation')).toBeVisible();
  } finally { releaseArchiveRefresh(); }
});

test('failed unarchive restores an archived-only row', async ({ page, mockAside }) => {
  mockAside.sessions.find(session => session.id === SESSION_B)!.archived = false;
  mockAside.nativeArchivedOverrides.set(SESSION_B, true);
  await page.reload();
  const sidebar = await openConversations(page);
  await sidebar.getByRole('button', { name: 'Show all' }).click();
  await sidebar.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(sidebar.getByText('Bravo conversation')).toBeVisible();

  const release = mockAside.holdNextRequest('POST', `/api/native/sessions/${SESSION_B}/unarchive`, 503);
  await sidebar.getByRole('button', { name: 'Options for Bravo conversation' }).click();
  await page.getByRole('menuitem', { name: 'Unarchive' }).click();
  await expect(sidebar.getByText('Bravo conversation')).toHaveCount(0);
  const releaseRefresh = mockAside.holdNativeRefreshes();
  release();
  try {
    await expect(page.getByRole('alert')).toContainText("Couldn't update the conversation");
    await expect(sidebar.getByText('Bravo conversation')).toBeVisible();
  } finally { releaseRefresh(); }
});

test('success toast preserves the dark theme and layout, then dismisses itself', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('asideTheme', 'dark'));
  await page.reload();
  const sidebar = await openConversations(page);
  const header = page.locator('main[aria-label="Chat"] header').first();
  const before = await header.boundingBox();
  expect(before).not.toBeNull();

  await sidebar.getByRole('button', { name: 'Options for Bravo conversation' }).click();
  await page.getByRole('menuitem', { name: 'Mark as read' }).click();
  const toast = page.getByRole('status').filter({ hasText: 'Marked as read.' });
  await expect(toast).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const themeColor = await page.locator('meta[name="theme-color"]').getAttribute('content');
  const canvas = await page.locator('html').evaluate(element => getComputedStyle(element).getPropertyValue('--canvas').trim());
  expect(themeColor).toBe(canvas);
  const during = await header.boundingBox();
  expect(during).toEqual(before);
  await expect(toast).toHaveCount(0, { timeout: 4_500 });
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', canvas);
  expect(await header.boundingBox()).toEqual(before);
});
