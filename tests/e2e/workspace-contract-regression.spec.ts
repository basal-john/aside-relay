import type { Page } from '@playwright/test';
import { SESSION_A, expect, test } from './fixture';

const WORKSPACE_PATH = '/api/native/workspace';
const PROJECT_PATH = `${WORKSPACE_PATH}/projects`;
const PROJECT = { id: 'project-contract', name: 'Contract project', workspacePath: '/tmp/contract-project' };

async function openWorkspace(page: Page) {
  await page.goto(`/c/${SESSION_A}`);
  const drawer = page.getByRole('button', { name: 'Open conversations' });
  if (await drawer.isVisible()) await drawer.click();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Workspace & preferences' }).click();
  return page.locator('[data-app-dialog]').first();
}

async function installWorkspace(page: Page) {
  await page.route(`**${WORKSPACE_PATH}`, route => route.fulfill({ json: {
    available: true,
    capabilities: { projects: true, projectInstructions: true },
    sections: { projects: [PROJECT] },
  } }));
  await page.route(`**${PROJECT_PATH}`, route => route.fulfill({ json: [PROJECT] }));
}

test('malformed workspace responses show recovery without crashing the app', async ({ page }) => {
  await page.route(`**${WORKSPACE_PATH}`, route => route.fulfill({ json: { available: true } }));
  const workspace = await openWorkspace(page);
  await expect(workspace.getByText('Workspace unavailable', { exact: true })).toBeVisible();
  await expect(workspace.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
});

test('failed section loads expose retry and recover the selected section', async ({ page, mockAside }) => {
  mockAside.allowedConsoleErrors.push(/503/);
  await installWorkspace(page);
  let shouldFail = true;
  await page.route(`**${PROJECT_PATH}`, route => shouldFail
    ? route.fulfill({ status: 503, json: { detail: 'Temporarily unavailable.' } })
    : route.fulfill({ json: [PROJECT] }));
  const workspace = await openWorkspace(page);
  await workspace.getByRole('button', { name: /^Projects/ }).click();
  await expect(workspace.getByText('Could not load this section', { exact: true })).toBeVisible();
  shouldFail = false;
  await workspace.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(workspace.getByRole('article').filter({ hasText: PROJECT.name })).toBeVisible();
});

test('failed project instruction reads keep the editor closed and can be retried', async ({ page, mockAside }) => {
  mockAside.allowedConsoleErrors.push(/503/);
  await installWorkspace(page);
  let shouldFail = true;
  await page.route(`**${PROJECT_PATH}/${PROJECT.id}/instructions`, route => shouldFail
    ? route.fulfill({ status: 503, json: { detail: 'Temporarily unavailable.' } })
    : route.fulfill({ json: { content: 'Keep the instructions.' } }));
  const workspace = await openWorkspace(page);
  await workspace.getByRole('button', { name: /^Projects/ }).click();
  await workspace.getByRole('button', { name: 'Instructions', exact: true }).click();
  await expect(page.getByText('Could not load workspace details.', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: `${PROJECT.name} instructions` })).toHaveCount(0);
  shouldFail = false;
  await workspace.getByRole('button', { name: 'Instructions', exact: true }).click();
  await expect(page.getByRole('dialog', { name: `${PROJECT.name} instructions` }).getByLabel('Instructions')).toHaveValue('Keep the instructions.');
});

test('artifact previews use their path without unused MIME or preview URL fields', async ({ page }) => {
  await page.route(`**/api/native/files/sessions/${SESSION_A}/artifacts`, route => route.fulfill({ json: { items: [{
    name: 'result.txt', path: 'result.txt', absolutePath: '/tmp/result.txt', bytes: 12, mtime: 1_700_000_000_000, kind: 'text',
  }] } }));
  await page.goto(`/files?session=${SESSION_A}`);
  const files = page.getByRole('dialog', { name: 'Files', exact: true });
  const artifact = files.getByRole('button', { name: /result\.txt/ });
  await expect(artifact).toBeVisible();
  await artifact.click();
  await expect(files).toContainText('E2E file content');
  await expect(files.getByRole('link', { name: 'Download', exact: true })).toHaveAttribute('href', new RegExp(`/artifacts/result\\.txt\\?download=true$`));
});

test('failed memory reads keep the editor closed and preserve saved content on retry', async ({ page, mockAside }) => {
  mockAside.allowedConsoleErrors.push(/503/);
  const memory = { path: 'saved.md', name: 'Saved memory' };
  await page.route(`**${WORKSPACE_PATH}`, route => route.fulfill({ json: {
    available: true, capabilities: { memories: true }, sections: { memories: { items: [memory] } },
  } }));
  await page.route(`**${WORKSPACE_PATH}/memories`, route => route.fulfill({ json: { items: [memory] } }));
  let shouldFail = true;
  await page.route(`**${WORKSPACE_PATH}/memories/file?*`, route => shouldFail
    ? route.fulfill({ status: 503, json: { detail: 'Temporarily unavailable.' } })
    : route.fulfill({ json: { content: 'Keep saved memory.' } }));
  const workspace = await openWorkspace(page);
  await workspace.getByRole('button', { name: /^Memory/ }).click();
  await workspace.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByText('Could not load workspace details.', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Edit memory', exact: true })).toHaveCount(0);
  shouldFail = false;
  await workspace.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit memory', exact: true }).getByRole('textbox', { name: 'Memory', exact: true })).toHaveValue('Keep saved memory.');
});
