import type { Page, Route } from '@playwright/test';
import { expect, SESSION_A, test } from './fixture';

type WorkspaceState = ReturnType<typeof workspaceState>;

test('workspace exposes every native section and keeps project edits in sync', async ({ page }) => {
  const state = workspaceState();
  await installWorkspaceApi(page, state);
  const workspace = await openWorkspace(page);

  await expect(workspace.getByRole('button', { name: /Projects/ })).toBeVisible();
  await expect(workspace.getByRole('button', { name: /Routines/ })).toBeVisible();
  await expect(workspace.getByRole('button', { name: /Memory/ })).toBeVisible();
  await expect(workspace.getByRole('button', { name: /Context awareness/ })).toBeVisible();
  await expect(workspace.getByRole('button', { name: /Skills/ })).toBeVisible();
  await expect(workspace.getByRole('button', { name: /Plugins & MCP/ })).toBeVisible();
  await expect(workspace.getByRole('button', { name: /AI providers/ })).toBeVisible();
  await expect(workspace.getByRole('button', { name: /Account & devices/ })).toBeVisible();
  await expect(workspace.getByRole('button', { name: /Native preferences/ })).toBeVisible();

  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: viewport.width, height: 640 });
  const title = workspace.getByRole('heading', { name: 'Workspace & preferences', exact: true });
  const close = workspace.getByRole('button', { name: 'Close', exact: true });
  const body = workspace.locator('[data-app-dialog-body]');
  const titleBefore = await title.boundingBox();
  const closeBefore = await close.boundingBox();
  await body.evaluate(element => element.scrollTo(0, element.scrollHeight));
  await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await title.boundingBox()).toEqual(titleBefore);
  expect(await close.boundingBox()).toEqual(closeBefore);
  expect(await workspace.evaluate(element => element.scrollTop)).toBe(0);
  await expect(workspace.getByRole('button', { name: /Native preferences/ })).toBeInViewport();
  await page.setViewportSize(viewport);

  await openSection(workspace, 'Projects');
  const project = workspace.getByRole('article').filter({ hasText: 'SMURF Project' });
  await expect(project).toContainText('/workspace/smurf');
  await project.getByRole('button', { name: 'Instructions' }).click();
  const instructions = page.getByRole('dialog', { name: 'SMURF Project instructions' });
  await expect(instructions.getByLabel('Instructions')).toHaveValue('# SMURF rules\nUse primary sources.');
  await instructions.getByRole('button', { name: 'Close' }).click();

  await project.getByRole('button', { name: 'Edit' }).click();
  const editProject = page.getByRole('dialog', { name: 'Edit project' });
  await editProject.getByLabel('Name').fill('SMURF Research');
  await editProject.getByRole('button', { name: 'Save project' }).click();
  await expect(workspace.getByRole('article').filter({ hasText: 'SMURF Research' })).toBeVisible();

  await backToWorkspace(workspace);
  await openSection(workspace, 'Routines');
  await expect(workspace.getByText('Daily SMURF brief')).toBeVisible();
  await expect(workspace.getByText('Summarize SMURF research.')).toBeVisible();

  await backToWorkspace(workspace);
  await openSection(workspace, 'Memory');
  await expect(workspace.getByText('Research preferences')).toBeVisible();
  await expect(workspace.getByText('memory/preferences.md', { exact: false })).toBeVisible();

  await backToWorkspace(workspace);
  await openSection(workspace, 'Context awareness');
  await expect(workspace.getByText('Capture controls')).toBeVisible();
  await expect(workspace.getByText('Chrome research')).toBeVisible();

  await backToWorkspace(workspace);
  await openSection(workspace, 'Skills');
  await expect(workspace.getByRole('heading', { name: 'Research helper', exact: true })).toBeVisible();
  await expect(workspace.getByText('Local catalog')).toBeVisible();
  await expect(workspace.getByText('Visual browse')).toBeVisible();

  await backToWorkspace(workspace);
  await openSection(workspace, 'Plugins & MCP');
  await expect(workspace.getByText('Local MCP', { exact: true }).first()).toBeVisible();
  await expect(workspace.getByLabel('Search web permission')).toHaveValue('ask');
  await expect(workspace.getByText('Available tools')).toBeVisible();

  await backToWorkspace(workspace);
  await openSection(workspace, 'AI providers');
  await expect(workspace.getByText('OpenAI Codex')).toBeVisible();
  await expect(workspace.getByText('1 model')).toBeVisible();

  await backToWorkspace(workspace);
  await openSection(workspace, 'Account & devices');
  await expect(workspace.getByRole('heading', { name: 'Mina', exact: true })).toBeVisible();
  await expect(workspace.getByText('MacBook Pro')).toBeVisible();
  await expect(workspace.getByText('This device')).toBeVisible();

  await backToWorkspace(workspace);
  await openSection(workspace, 'Native preferences');
  await expect(workspace.getByLabel('Follow-up behavior')).toHaveValue('queue');
  await expect(workspace.getByLabel('Timezone')).toHaveValue('Asia/Seoul');
});

test('preference conflict reloads native state instead of keeping a stale draft', async ({ page, mockAside }) => {
  mockAside.allowConsoleError(/status of 409 \(Conflict\)/);
  const state = workspaceState();
  state.failPreferenceSave = true;
  await installWorkspaceApi(page, state);
  const workspace = await openWorkspace(page);

  await openSection(workspace, 'Native preferences');
  await workspace.getByLabel('Follow-up behavior').selectOption('steer');
  await workspace.getByLabel('Timezone').fill('Local/Draft');
  await workspace.getByRole('button', { name: 'Save preferences' }).click();

  await expect(page.getByText('Preferences changed in Aside. Loaded the latest settings.')).toBeVisible();
  await expect(workspace.getByLabel('Follow-up behavior')).toHaveValue('queue');
  await expect(workspace.getByLabel('Timezone')).toHaveValue('Remote/Changed');
});

function workspaceState() {
  const project = { id: 'project-smurf', name: 'SMURF Project', workspacePath: '/workspace/smurf', sessionId: SESSION_A };
  const routine = { id: 'routine-daily', name: 'Daily SMURF brief', prompt: 'Summarize SMURF research.', rrule: 'FREQ=DAILY;BYHOUR=9', status: 'active' };
  const memories = { preferences: { enabled: true, episodicRetentionDays: 90, dreamingMinHours: 12, dreamingMinSessions: 4 }, files: [{ name: 'Research preferences', path: 'memory/preferences.md', lastUpdatedAt: '2026-10-11T01:00:00Z' }] };
  const contextAwareness = { settings: { enabled: true, captureTypedText: false, screenOcr: true, pausedUntil: null, rules: [] }, status: { state: 'active' }, applications: [{ name: 'Chrome' }] };
  const skills = [{ name: 'Research helper', path: 'user/research-helper', description: 'Repeatable research workflow.', enabled: true, group: 'user' }];
  const connections = { servers: [{ name: 'Local MCP', transport: 'stdio', command: 'smurf-mcp', enabled: true, status: 'connected' }], inventories: { 'Local MCP': { tools: [{ name: 'Search web', description: 'Search trusted sources.' }] } } };
  const providers = { connectedProviders: [{ providerId: 'openai-codex', name: 'OpenAI Codex', state: 'connected', type: 'oauth' }], availableModels: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', provider: 'openai-codex' }] };
  const account = { profile: { name: 'Mina', email: 'mina@example.com', subscriptionPlan: 'Plus' }, devices: [{ id: 'device-mac', deviceName: 'MacBook Pro', platform: 'macOS', appVersion: '1.26.1010.2149', isCurrent: true, lastSeenAt: '2026-10-11T01:00:00Z' }] };
  const preferences = { defaultPermissionMode: 'default', followUpBehavior: 'queue', agentTabs: { closeAfterIdleMinutes: 15 }, agentTaskNotifications: { needsAttention: true, taskCompletions: true, routineCompletions: false }, completionSound: { enabled: true }, sidebarRecentChatLimit: 10, sidepanelSessionOnTabChange: 'new-session', timezone: 'Asia/Seoul' };
  return { project, routine, memories, contextAwareness, skills, connections, providers, account, preferences, failPreferenceSave: false };
}

async function installWorkspaceApi(page: Page, state: WorkspaceState) {
  await page.route('**/api/native/workspace**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;

    if (method === 'GET' && path === '/api/native/workspace') return reply(route, workspaceRoot(state));
    if (method === 'GET' && path === '/api/native/workspace/projects') return reply(route, [state.project]);
    if (method === 'GET' && path === '/api/native/workspace/projects/project-smurf/instructions') return reply(route, { content: '# SMURF rules\nUse primary sources.', lastUpdatedAt: '2026-10-11T01:00:00Z' });
    if (method === 'PATCH' && path === '/api/native/workspace/projects/project-smurf') {
      Object.assign(state.project, request.postDataJSON());
      return reply(route, state.project);
    }
    if (method === 'GET' && path === '/api/native/workspace/routines') return reply(route, [state.routine]);
    if (method === 'GET' && path === '/api/native/workspace/memories') return reply(route, state.memories);
    if (method === 'GET' && path === '/api/native/workspace/context-awareness') return reply(route, state.contextAwareness);
    if (method === 'GET' && path === '/api/native/workspace/context-awareness/history') return reply(route, [{ id: 'capture-one', name: 'Chrome research', application: 'Chrome', url: 'https://example.com/research', createdAt: '2026-10-11T01:00:00Z' }]);
    if (method === 'GET' && path === '/api/native/workspace/skills') return reply(route, state.skills);
    if (method === 'GET' && path === '/api/native/workspace/skills/catalog') return reply(route, { groups: { personal: state.skills, builtin: [], system: [{ name: 'Visual browse', path: 'builtin/visual-browse' }], passwordManager: [] }, skills: state.skills });
    if (method === 'GET' && path === '/api/native/workspace/connections') return reply(route, state.connections);
    if (method === 'GET' && path === '/api/native/workspace/connections/tools/permissions') return reply(route, { rules: { allow: [], ask: [{ type: 'tool', tool: 'Search web' }], deny: [], default: 'allow' }, tools: [{ server: 'Local MCP', name: 'Search web', description: 'Search trusted sources.' }] });
    if (method === 'GET' && path === '/api/native/workspace/providers') return reply(route, state.providers);
    if (method === 'GET' && path === '/api/native/workspace/account') return reply(route, state.account);
    if (method === 'GET' && path === '/api/native/workspace/preferences') return reply(route, state.preferences);
    if (method === 'PATCH' && path === '/api/native/workspace/preferences') {
      if (state.failPreferenceSave) {
        state.failPreferenceSave = false;
        state.preferences = { ...state.preferences, followUpBehavior: 'queue', timezone: 'Remote/Changed' };
        return reply(route, { detail: 'Some settings may have changed because rollback failed. Refresh settings before editing again.' }, 409);
      }
      Object.assign(state.preferences, request.postDataJSON());
      return reply(route, { updated: Object.keys(request.postDataJSON() as object), settings: state.preferences });
    }
    throw new Error(`Unexpected workspace API request: ${method} ${path}${url.search}`);
  });
}

function workspaceRoot(state: WorkspaceState) {
  return {
    available: true,
    capabilities: {
      projects: true, routines: true, memories: true, contextAwareness: true, skills: true,
      connections: true, providers: true, account: true, preferences: true,
      projectInstructions: true, skillCatalog: true, skillCustomization: true, toolPermissions: true,
    },
    sections: {
      projects: [state.project], routines: [state.routine], memories: state.memories,
      contextAwareness: state.contextAwareness, skills: state.skills, connections: state.connections,
      providers: state.providers, account: state.account, preferences: state.preferences,
    },
  };
}

async function openWorkspace(page: Page) {
  await page.goto(`/c/${SESSION_A}`);
  const drawerButton = page.getByRole('button', { name: 'Open conversations' });
  if (await drawerButton.isVisible()) await drawerButton.click();
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Workspace & preferences' }).click();
  const workspace = page.getByRole('dialog', { name: 'Workspace & preferences' });
  await expect(workspace.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
  return workspace;
}

async function openSection(workspace: ReturnType<Page['getByRole']>, name: string) {
  await workspace.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await expect(workspace.getByRole('heading', { name, exact: true }).first()).toBeVisible();
}

async function backToWorkspace(workspace: ReturnType<Page['getByRole']>) {
  await workspace.getByRole('button', { name: 'Back to workspace' }).click();
  await expect(workspace.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
}

function reply(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}
