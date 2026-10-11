import type { Page, Route } from '@playwright/test';
import { BROWSER_TAB_ID as TAB_ID, BROWSER_TAB_TITLE as TAB_TITLE, BROWSER_TAB_URL as TAB_URL, expect, SESSION_A, test } from './fixture';

const BROWSER_INPUT = 'browser automation';
const HISTORY_TITLE = 'Browser guide';
const HISTORY_URL = 'https://history.example/guide';
const BOOKMARK_TITLE = 'Browser tools';
const BOOKMARK_URL = 'https://bookmark.example/tools';

async function openBrowserSheet(page: Page) {
  await page.goto(`/c/${SESSION_A}`);
  const drawerButton = page.getByRole('button', { name: 'Open conversations' });
  if (await drawerButton.isVisible()) await drawerButton.click();
  await page.getByRole('complementary', { name: 'Conversations' }).getByRole('button', { name: 'Browser', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Browser' });
  await expect(sheet).toBeVisible();
  return sheet;
}

async function openActiveTab(page: Page) {
  const sheet = await openBrowserSheet(page);
  const tab = sheet.getByRole('button', { name: new RegExp(TAB_TITLE) });
  await expect(tab).toContainText('Active');
  await tab.click();
  await expect(sheet.getByRole('heading', { name: TAB_TITLE })).toBeVisible();
  return sheet;
}

test('active tab exposes its destination and sends exact browser control commands', async ({ page }) => {
  const controls: unknown[] = [];
  await page.route(new RegExp(`/api/native/browser/tabs/${TAB_ID}/control(?:\\?.*)?$`), async (route: Route) => {
    controls.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, url: TAB_URL, title: TAB_TITLE }),
    });
  });

  const sheet = await openActiveTab(page);
  const openExternal = sheet.getByRole('button', { name: 'Open in your browser' });
  await expect(openExternal).toHaveAttribute('href', TAB_URL);
  await expect(openExternal).toHaveAttribute('target', '_blank');
  await expect(openExternal).toHaveAttribute('rel', /noopener/);
  await expect(sheet.getByRole('button', { name: 'Reload' })).toHaveCount(0);

  await sheet.getByRole('button', { name: 'Back', exact: true }).click();
  await sheet.getByRole('button', { name: 'Forward', exact: true }).click();
  await sheet.getByRole('button', { name: 'Control', exact: true }).click();
  await sheet.getByRole('textbox', { name: 'Text to type in browser' }).fill(BROWSER_INPUT);
  await sheet.getByRole('button', { name: 'Type', exact: true }).click();
  await sheet.getByRole('button', { name: 'Press Enter' }).click();

  await expect.poll(() => controls).toEqual([
    { action: 'back' },
    { action: 'forward' },
    { action: 'type', text: BROWSER_INPUT },
    { action: 'key', key: 'Enter' },
  ]);
});

test('show-all changes tab scope and confirmed close removes the tab', async ({ page, mockAside }) => {
  const sheet = await openBrowserSheet(page);
  await sheet.getByRole('button', { name: 'Show all' }).click();
  await expect(sheet.getByRole('button', { name: 'Chat tabs' })).toBeVisible();
  await expect.poll(() => mockAside.calls.some(call =>
    call.method === 'GET'
      && call.path === `/api/tabs?refresh=true&session=${SESSION_A}&all=true`,
  )).toBe(true);

  await sheet.getByRole('button', { name: new RegExp(TAB_TITLE) }).click();
  await sheet.getByRole('button', { name: 'Close tab' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Close this tab?' });
  await expect(confirmation).toContainText(TAB_TITLE);
  await confirmation.getByRole('button', { name: 'Close tab' }).click();

  await expect(confirmation).toBeHidden();
  await expect(sheet.getByText('No browser tabs')).toBeVisible();
  expect(mockAside.calls.some(call =>
    call.method === 'DELETE'
      && call.path === `/api/tabs/${TAB_ID}?session=${SESSION_A}&all=true`,
  )).toBe(true);
});

test('history and bookmarks open the chosen destination', async ({ page, mockAside }) => {
  const libraryRequests: string[] = [];
  await page.route('**/api/native/browser/library?*', async route => {
    const url = new URL(route.request().url());
    libraryRequests.push(`${url.pathname}${url.search}`);
    const kind = url.searchParams.get('kind');
    const items = kind === 'history'
      ? [{ id: 'history-guide', title: HISTORY_TITLE, url: HISTORY_URL, visitCount: 5 }]
      : kind === 'bookmarks'
        ? [{ id: 'bookmark-tools', title: BOOKMARK_TITLE, url: BOOKMARK_URL }]
        : [];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items }) });
  });

  const sheet = await openBrowserSheet(page);
  await sheet.getByRole('button', { name: 'History', exact: true }).click();
  await expect(sheet.getByRole('button', { name: new RegExp(HISTORY_TITLE) })).toContainText('5 visits');
  await sheet.getByRole('button', { name: new RegExp(HISTORY_TITLE) }).click();
  await expect(sheet.getByPlaceholder('Search tabs')).toBeVisible();

  await sheet.getByRole('button', { name: 'Bookmarks', exact: true }).click();
  await sheet.getByRole('button', { name: new RegExp(BOOKMARK_TITLE) }).click();
  await expect(sheet.getByPlaceholder('Search tabs')).toBeVisible();

  expect(libraryRequests).toEqual([
    `/api/native/browser/library?kind=history&query=&session=${SESSION_A}`,
    `/api/native/browser/library?kind=bookmarks&query=&session=${SESSION_A}`,
  ]);
  expect(mockAside.calls.filter(call => call.method === 'POST' && call.path === `/api/tabs?session=${SESSION_A}`).map(call => call.body)).toEqual([
    { url: HISTORY_URL },
    { url: BOOKMARK_URL },
  ]);
});
