import { test, expect, SESSION_A } from './fixture';

test('sidebar shows ten recent conversations when no preference is stored', async ({ page, mockAside }) => {
  delete mockAside.preferences.sidebarRecentChatLimit;
  const referenceSession = mockAside.sessions[1];
  const oldestSession = mockAside.sessions[mockAside.sessions.length - 1];
  Array.from({ length: 8 }, (_, index) => index + 1).forEach(index => {
    mockAside.sessions.push({
      ...referenceSession,
      id: `recent-regression-${index}`,
      title: `Recent regression ${index}`,
      isPinned: false,
      pinned: false,
      unread: false,
      status: 'idle',
      statusLabel: 'Completed',
      suspensionKind: undefined,
      mtime: oldestSession.mtime - index,
    });
  });

  await page.goto(`/c/${SESSION_A}`);
  const openConversations = page.getByRole('button', { name: 'Open conversations' });
  if (await openConversations.isVisible()) await openConversations.click();
  const conversations = page.getByRole('complementary', { name: 'Conversations' });
  await conversations.locator('[data-virtuoso-scroller]').evaluate(element => element.scrollTo(0, element.scrollHeight));
  await expect(conversations.getByRole('button', { name: 'Recent regression 6', exact: true })).toBeVisible();
  await expect(conversations.getByRole('button', { name: 'Recent regression 7', exact: true })).toHaveCount(0);
  await expect(conversations.getByRole('button', { name: 'Show all', exact: true })).toBeVisible();
});
