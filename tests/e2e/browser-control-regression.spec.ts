import type { Page, Route } from '@playwright/test';
import type { BrowserControl } from '../../web/src/browser';
import { BROWSER_TAB_ID, BROWSER_TAB_TITLE, BROWSER_TAB_URL, SESSION_A, expect, test } from './fixture';

const CONTROL_ROUTE = `**/api/native/browser/tabs/${BROWSER_TAB_ID}/control?*`;

async function openControlledTab(page: Page) {
  await page.goto(`/c/${SESSION_A}`);
  await page.getByRole('button', { name: 'Expand browser preview', exact: true }).click();
  const browser = page.getByRole('dialog', { name: 'Browser', exact: true });
  await expect(browser.getByRole('heading', { name: BROWSER_TAB_TITLE })).toBeVisible();
  return browser;
}

function acceptControl(route: Route) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, url: BROWSER_TAB_URL, title: BROWSER_TAB_TITLE }),
  });
}

test('opening a PiP tab enables direct page clicks and text input immediately', async ({ page }) => {
  const commands: BrowserControl[] = [];
  await page.route(CONTROL_ROUTE, route => {
    commands.push(route.request().postDataJSON());
    return acceptControl(route);
  });

  const browser = await openControlledTab(page);
  const surface = browser.getByRole('button', { name: 'Control browser page', exact: true });
  await expect(surface).toBeVisible();
  await expect.poll(() => surface.locator('img').evaluate(image => image instanceof HTMLImageElement && image.naturalWidth > 0)).toBe(true);
  await surface.click();
  await expect.poll(() => commands.length).toBe(1);
  const click = commands[0];
  expect(click.action).toBe('click');
  if (click.action !== 'click') throw new Error('Expected a page click.');
  expect(Math.abs(click.x - .5)).toBeLessThan(.01);
  expect(Math.abs(click.y - .5)).toBeLessThan(.01);
  await browser.getByRole('textbox', { name: 'Text to type in browser' }).fill('직접 입력');
  await browser.getByRole('button', { name: 'Type', exact: true }).click();
  await expect.poll(() => commands).toContainEqual({ action: 'type', text: '직접 입력' });
  const bounds = await surface.boundingBox();
  if (!bounds) throw new Error('The browser control surface is missing.');
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y + 30);
  await page.mouse.down();
  await page.mouse.move(x, y - 30);
  await page.mouse.up();
  await expect.poll(() => commands).toContainEqual({ action: 'scroll', x: expect.closeTo(.5, 1), y: expect.any(Number), deltaX: 0, deltaY: expect.closeTo(180, 0) });
});

test('wheel and focused keyboard events control the remote page', async ({ page, isMobile }) => {
  const commands: unknown[] = [];
  await page.route(CONTROL_ROUTE, route => {
    commands.push(route.request().postDataJSON());
    return acceptControl(route);
  });

  const browser = await openControlledTab(page);
  const surface = browser.getByRole('button', { name: 'Control browser page', exact: true });
  await expect(surface).toBeVisible();
  if (isMobile) {
    const bounds = await surface.boundingBox();
    if (!bounds) throw new Error('The browser control surface is missing.');
    await surface.dispatchEvent('wheel', { deltaX: 0, deltaY: 240, clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2 });
  } else {
    await surface.hover();
    await page.mouse.wheel(0, 240);
  }
  await expect.poll(() => commands).toContainEqual({ action: 'scroll', x: expect.any(Number), y: expect.any(Number), deltaX: 0, deltaY: 240 });
  await surface.focus();
  await surface.press('Tab');
  await expect.poll(() => commands).toContainEqual({ action: 'key', key: 'Tab' });
  await surface.press('Escape');
  await expect.poll(() => commands).toContainEqual({ action: 'key', key: 'Escape' });
  await expect(browser).toBeVisible();
});

test('sleeping tabs expose their state without accepting page input', async ({ page, mockAside }) => {
  mockAside.tabs[0].loaded = false;
  const commands: unknown[] = [];
  await page.route(CONTROL_ROUTE, route => {
    commands.push(route.request().postDataJSON());
    return acceptControl(route);
  });

  const browser = await openControlledTab(page);
  await expect(browser.getByText('This tab is asleep', { exact: true })).toBeVisible();
  await expect(browser.getByRole('button', { name: 'Control browser page', exact: true })).toHaveCount(0);
  await expect(browser.getByRole('button', { name: 'Go to address', exact: true })).toBeDisabled();
  expect(commands).toEqual([]);
});

test('the selected control view receives finite snapshots without relying on a stream', async ({ page }) => {
  let shots = 0;
  await page.route(`**/api/tabs/${BROWSER_TAB_ID}/shot?*`, async route => {
    shots += 1;
    await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="blue"/></svg>' });
  });
  await page.goto(`/c/${SESSION_A}`);
  await expect.poll(() => shots).toBeGreaterThan(0);
  const before = shots;
  await page.getByRole('button', { name: 'Expand browser preview', exact: true }).click();
  await expect.poll(() => shots).toBeGreaterThan(before);
  const image = page.getByRole('dialog', { name: 'Browser', exact: true }).getByRole('img', { name: `Current view of ${BROWSER_TAB_TITLE}` });
  await expect(image).toHaveAttribute('src', /^blob:/);
});

test('failed text delivery retains the draft and address navigation uses the same selected tab', async ({ page, mockAside }) => {
  mockAside.allowedConsoleErrors.push(/503/);
  const commands: unknown[] = [];
  await page.route(CONTROL_ROUTE, route => {
    const command: unknown = route.request().postDataJSON();
    commands.push(command);
    if (typeof command === 'object' && command !== null && Reflect.get(command, 'action') === 'type') {
      return route.fulfill({ status: 503, json: { detail: 'Temporarily unavailable.' } });
    }
    return acceptControl(route);
  });
  const browser = await openControlledTab(page);
  const input = browser.getByRole('textbox', { name: 'Text to type in browser' });
  await expect(input).toBeVisible();
  await input.fill('Keep my draft');
  await browser.getByRole('button', { name: 'Type', exact: true }).click();
  await expect.poll(() => commands).toContainEqual({ action: 'type', text: 'Keep my draft' });
  await expect(input).toHaveValue('Keep my draft');
  await browser.getByRole('textbox', { name: 'Website address' }).fill('  https://example.com/next  ');
  await browser.getByRole('button', { name: 'Go to address' }).click();
  await expect.poll(() => commands).toContainEqual({ action: 'navigate', url: 'https://example.com/next' });
});
