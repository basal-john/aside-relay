import type { Locator, Page } from '@playwright/test';
import { expect, SESSION_A, SESSION_B, test } from './fixture';

const UNREAD_SESSION = 'sessioncharlie03';
const READ_SESSION = 'sessiondelta004';
const AGENT_ALPHA = 'agentalpha001';
const AGENT_BRAVO = 'agentbravo002';
const WEB_ACTION_TITLE = 'Read browser reference';
const WEB_PAGE_TITLE = 'Browser Reference';
const WEB_PAGE_URL = 'https://example.com/browser';

async function conversations(page: Page) {
  const open = page.getByRole('button', { name: 'Open conversations' });
  if (await open.isVisible()) await open.click();
  return page.getByRole('complementary', { name: 'Conversations' });
}

async function iconMetadata(section: Locator) {
  return section.locator('svg').first().evaluate(svg => {
    const path = svg.querySelector('path');
    const gradients = [...svg.querySelectorAll('linearGradient')];
    return {
      path: path?.getAttribute('d') ?? '',
      pathClass: path?.getAttribute('class') ?? '',
      fill: path?.getAttribute('fill') ?? '',
      colors: gradients.map(gradient => gradient.querySelector('stop')?.getAttribute('stop-color') ?? ''),
    };
  });
}

test('conversation status shows unread completed, prioritizes running, and leaves read completed clear', async ({ page, mockAside }) => {
  const unread = mockAside.sessions.find(session => session.id === UNREAD_SESSION)!;
  Object.assign(unread, { status: 'idle', statusLabel: 'Completed', unread: true, suspensionKind: undefined });
  const running = mockAside.sessions.find(session => session.id === SESSION_B)!;
  Object.assign(running, { status: 'running', statusLabel: 'Working', unread: true, suspensionKind: 'approval' });
  const read = mockAside.sessions.find(session => session.id === READ_SESSION)!;
  Object.assign(read, { status: 'idle', statusLabel: 'Completed', unread: false, suspensionKind: undefined });
  mockAside.running.add(SESSION_B);

  await page.goto('/');
  const sidebar = await conversations(page);
  const unreadRow = sidebar.locator(`button[data-session-id="${UNREAD_SESSION}"]`);
  const runningRow = sidebar.locator(`button[data-session-id="${SESSION_B}"]`);
  const readRow = sidebar.locator(`button[data-session-id="${READ_SESSION}"]`);

  const unreadStatus = unreadRow.getByRole('img', { name: 'Unread' });
  await expect(unreadStatus).toBeVisible();
  await expect(unreadRow.getByRole('img', { name: 'Running' })).toHaveCount(0);
  await expect.poll(() => unreadStatus.evaluate(status => {
    const dot = status.firstElementChild;
    if (!(dot instanceof HTMLElement)) return false;
    const probe = document.createElement('span');
    probe.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--primary');
    document.body.append(probe);
    const matches = getComputedStyle(dot).backgroundColor === getComputedStyle(probe).backgroundColor;
    probe.remove();
    return matches;
  })).toBe(true);

  await expect(runningRow.getByRole('img', { name: 'Running' })).toBeVisible();
  await expect(runningRow.getByRole('img', { name: 'Unread' })).toHaveCount(0);
  await expect(runningRow.getByRole('img', { name: 'Working' })).toHaveCount(0);

  await expect(readRow.getByRole('img', { name: /Running|Unread|Needs attention|Task failed/ })).toHaveCount(0);
});

test('activity keeps distinct stable subagent identities and meaningful web, code, and file rows', async ({ page, mockAside }) => {
  mockAside.workspace = {
    status: 'running',
    children: [
      { id: AGENT_ALPHA, title: 'Compare sources', status: 'running' },
      { id: AGENT_BRAVO, title: 'Inspect markup', status: 'idle' },
    ],
    subagents: [
      { sessionId: AGENT_ALPHA, description: 'Compare sources', isRunning: true, model: { modelId: 'gpt-6.1-sol', thinkingLevel: 'high' } },
      { sessionId: AGENT_BRAVO, description: 'Inspect markup', isRunning: false, model: { modelId: 'gpt-6.1-sol', thinkingLevel: 'low' } },
    ],
    todos: [],
    outputs: [],
  };
  const now = Date.now();
  const calls = [
    { type: 'toolCall', id: 'call-agent-alpha', name: 'subagent', args: { action: 'spawn', description: 'Compare sources', session_id: AGENT_ALPHA } },
    { type: 'toolCall', id: 'call-agent-bravo', name: 'subagent', args: { action: 'spawn', description: 'Inspect markup', session_id: AGENT_BRAVO } },
    { type: 'toolCall', id: 'call-web', name: 'webfetch', args: { title: WEB_ACTION_TITLE, url: WEB_PAGE_URL } },
    { type: 'toolCall', id: 'call-code', name: 'repl', args: { title: 'Executed DOM probe', code: 'document.querySelector("main")' } },
    { type: 'toolCall', id: 'call-file', name: 'read_file', args: { path: `/Users/mj/.aside/u/0/sessions/2026_${SESSION_A}/src/activity.ts` } },
  ];
  const result = (seq: number, toolCallId: string, text: string) => Object.assign({
    seq,
    role: 'toolResult' as const,
    ts: now + seq,
    blocks: [{ type: 'text', text }],
  }, { toolCallId });
  mockAside.messages.set(SESSION_A, [
    { seq: 0, role: 'user', ts: now, blocks: [{ type: 'text', text: 'Run a mixed activity task' }] },
    { seq: 1, role: 'assistant', ts: now + 1, responseId: 'activity-response', model: 'gpt-6.1-sol', provider: 'openai-codex', blocks: calls },
    result(2, 'call-agent-alpha', `session_id: ${AGENT_ALPHA}\nmodel: gpt-6.1-sol · high`),
    result(3, 'call-agent-bravo', `session_id: ${AGENT_BRAVO}\nmodel: gpt-6.1-sol · low`),
    result(4, 'call-web', `→ ${WEB_PAGE_TITLE} (${WEB_PAGE_URL})`),
    result(5, 'call-code', 'DOM probe completed.'),
    result(6, 'call-file', 'export function Activity() {}'),
  ]);

  await page.goto(`/c/${SESSION_A}`);
  await page.getByRole('button', { name: 'Minimize browser preview' }).click();
  await expect(page.getByRole('button', { name: 'Open agents, 1 active, 1 complete, 0 failed' })).toBeVisible();
  const activitySummary = page.getByText('Used subagents, browsed the web, ran actions +1 more', { exact: true });
  await activitySummary.click();

  const alpha = page.getByRole('region', { name: 'Compare sources' });
  const bravo = page.getByRole('region', { name: 'Inspect markup' });
  await expect(alpha).toBeVisible();
  await expect(bravo).toBeVisible();
  const firstAlpha = await iconMetadata(alpha);
  const firstBravo = await iconMetadata(bravo);
  expect(firstAlpha.path).toMatch(/^M6\.90986 2\.73871/);
  expect(firstBravo.path).toBe(firstAlpha.path);
  expect(firstAlpha.pathClass).toMatch(/^subagent-icon-/);
  expect(firstBravo.pathClass).toMatch(/^subagent-icon-/);
  expect(firstAlpha.fill).toMatch(/^url\(#subagent-light-/);
  expect(firstBravo.fill).toMatch(/^url\(#subagent-light-/);
  expect(firstAlpha.colors).toHaveLength(2);
  expect(firstBravo.colors).toHaveLength(2);
  expect(firstAlpha.colors[0]).not.toBe(firstBravo.colors[0]);

  await page.getByRole('button', { name: 'Open agents, 1 active, 1 complete, 0 failed' }).click();
  const agents = page.getByRole('dialog', { name: 'Agents' });
  const agentAlpha = agents.locator('article').filter({ hasText: 'Compare sources' });
  const agentBravo = agents.locator('article').filter({ hasText: 'Inspect markup' });
  await expect(agentAlpha).toBeVisible();
  await expect(agentBravo).toBeVisible();
  expect((await iconMetadata(agentAlpha)).colors).toEqual(firstAlpha.colors);
  expect((await iconMetadata(agentBravo)).colors).toEqual(firstBravo.colors);
  await agents.getByRole('button', { name: 'Close', exact: true }).click();

  const web = page.getByRole('region', { name: WEB_ACTION_TITLE });
  await expect(web.locator('svg').first()).toHaveClass(/lucide-globe/);
  await expect(web.getByRole('link', { name: new RegExp(WEB_PAGE_TITLE) })).toHaveAttribute('href', WEB_PAGE_URL);
  const code = page.getByRole('region', { name: 'Executed DOM probe' });
  await expect(code.locator('svg').first()).toHaveClass(/lucide-code-xml/);
  await code.getByText('Technical details', { exact: true }).click();
  await expect(code).toContainText('document.querySelector("main")');
  const file = page.getByRole('region', { name: 'Read file' });
  await expect(file.locator('svg').first()).toHaveClass(/lucide-file/);
  await expect(file.getByRole('link', { name: /2026_sessionalpha01 \/ src \/ activity\.ts/ })).toHaveAttribute('href', `/api/sessions/${SESSION_A}/file/src/activity.ts`);

  await activitySummary.click();
  await activitySummary.click();
  const secondAlpha = await iconMetadata(page.getByRole('region', { name: 'Compare sources' }));
  const secondBravo = await iconMetadata(page.getByRole('region', { name: 'Inspect markup' }));
  expect(secondAlpha.colors).toEqual(firstAlpha.colors);
  expect(secondBravo.colors).toEqual(firstBravo.colors);
  expect(secondAlpha.path).toBe(firstAlpha.path);
  expect(secondBravo.path).toBe(firstBravo.path);
  expect(secondAlpha.pathClass).toMatch(/^subagent-icon-/);
  expect(secondBravo.pathClass).toMatch(/^subagent-icon-/);
});
