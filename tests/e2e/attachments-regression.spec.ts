import { test, expect, SESSION_A } from './fixture';

const RELATIVE_IMAGE_PATH = 'tmp/image.webp';
const IMAGE_API_PATH = `/api/sessions/${SESSION_A}/file/${RELATIVE_IMAGE_PATH}`;
const IMAGE_BODY = '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><rect width="3" height="2" fill="red"/></svg>';

test('relative Markdown image loads through the session file API and keeps its URL when expanded', async ({ page, mockAside }) => {
  mockAside.messages.get(SESSION_A)?.push({
    seq: 2,
    role: 'assistant',
    blocks: [{ type: 'text', text: `![Relative image](${RELATIVE_IMAGE_PATH})` }],
    ts: Date.now(),
    responseId: 'relative-image-response',
    model: 'gpt-6.1-sol',
    provider: 'openai-codex',
  });
  await page.route(`**${IMAGE_API_PATH}`, route => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: IMAGE_BODY,
  }));

  await page.goto(`/c/${SESSION_A}`);
  const image = page.getByRole('img', { name: 'Relative image' });
  await expect(image).toHaveAttribute('src', IMAGE_API_PATH);
  await expect.poll(() => image.evaluate(element => element instanceof HTMLImageElement ? element.naturalWidth : 0)).toBeGreaterThan(0);

  const minimizeBrowser = page.getByRole('button', { name: 'Minimize browser preview' });
  if (await minimizeBrowser.isVisible()) await minimizeBrowser.click();
  await image.click();
  const expandedImage = page.getByRole('img', { name: 'Expanded attachment' });
  await expect(expandedImage).toHaveAttribute('src', IMAGE_API_PATH);
  await expect.poll(() => expandedImage.evaluate(element => element instanceof HTMLImageElement ? element.naturalWidth : 0)).toBeGreaterThan(0);
});

test('queued PDF renders as a named file link instead of an image', async ({ page, mockAside }) => {
  const pdfUrl = '/api/upload/queued-report.pdf';
  mockAside.followups.set(SESSION_A, [{
    id: 'queued-pdf',
    prompt: 'Review the queued report.',
    attachments: [{ id: 'queued-pdf-file', name: 'queued-report.pdf', mime: 'application/pdf', bytes: 1_024, url: pdfUrl }],
    status: 'queued',
  }]);

  await page.goto(`/c/${SESSION_A}`);
  const queuedMessage = page.getByRole('article', { name: 'Queued message 1' });
  const fileLink = queuedMessage.getByRole('link', { name: 'queued-report.pdf' });
  await expect(fileLink).toHaveAttribute('href', pdfUrl);
  await expect(queuedMessage.getByRole('img')).toHaveCount(0);
});

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
