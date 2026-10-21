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

test('browser page control is permanent without a view-only toggle', async ({ page }) => {
  const browser = await openControlledTab(page);
  await expect(browser.getByRole('button', { name: 'Control', exact: true })).toHaveCount(0);
  await expect(browser.getByRole('button', { name: 'Control browser page', exact: true })).toBeVisible();
  await expect(browser.getByRole('textbox', { name: 'Text to type in browser' })).toBeVisible();
});

test('fullscreen controls the selected page while ordinary scrolling leaves local zoom unchanged', async ({ page, isMobile }) => {
  const commands: BrowserControl[] = [];
  await page.route(CONTROL_ROUTE, route => {
    commands.push(route.request().postDataJSON());
    return acceptControl(route);
  });
  const browser = await openControlledTab(page);
  await browser.getByRole('button', { name: 'Expand browser view', exact: true }).click();
  const fullscreen = page.getByRole('dialog', { name: 'Browser preview', exact: true });
  const surface = fullscreen.getByRole('button', { name: 'Control browser page', exact: true });
  await expect(surface).toBeVisible();
  await surface.click();
  await expect.poll(() => commands).toContainEqual({ action: 'click', x: expect.closeTo(.5, 1), y: expect.closeTo(.5, 1) });
  const bounds = await surface.boundingBox();
  if (!bounds) throw new Error('The fullscreen control surface is missing.');
  if (isMobile) {
    await surface.dispatchEvent('wheel', { deltaY: 120, clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2 });
  } else {
    await surface.hover();
    await page.mouse.wheel(0, 120);
  }
  await expect.poll(() => commands).toContainEqual({ action: 'scroll', x: expect.any(Number), y: expect.any(Number), deltaX: 0, deltaY: 120 });
  await expect(fullscreen.getByRole('button', { name: 'Reset zoom, 100%' })).toBeVisible();
  await fullscreen.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(fullscreen.getByRole('button', { name: 'Reset zoom, 150%' })).toBeVisible();
  await surface.click();
  const zoomedBounds = await surface.boundingBox();
  if (!zoomedBounds) throw new Error('The zoomed control surface is missing.');
  const dragX = zoomedBounds.x + zoomedBounds.width / 2;
  const dragY = zoomedBounds.y + zoomedBounds.height / 2;
  await page.mouse.move(dragX, dragY + 30);
  await page.mouse.down();
  await page.mouse.move(dragX, dragY - 30);
  await page.mouse.up();
  await expect.poll(() => commands).toContainEqual({ action: 'scroll', x: expect.any(Number), y: expect.any(Number), deltaX: 0, deltaY: 180 });
  await expect(fullscreen.getByRole('button', { name: 'Reset zoom, 150%' })).toBeVisible();
  await surface.press('ArrowDown');
  await surface.press('Escape');
  await expect.poll(() => commands).toContainEqual({ action: 'key', key: 'ArrowDown' });
  await expect.poll(() => commands).toContainEqual({ action: 'key', key: 'Escape' });
  await expect(fullscreen).toBeVisible();
  await fullscreen.getByRole('textbox', { name: 'Text to type in browser' }).fill('Fullscreen input');
  const inputBounds = await fullscreen.getByRole('textbox', { name: 'Text to type in browser' }).boundingBox();
  if (!inputBounds) throw new Error('The fullscreen text input is missing.');
  await page.mouse.move(inputBounds.x + inputBounds.width / 2, inputBounds.y + inputBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(inputBounds.x + inputBounds.width / 2, inputBounds.y + inputBounds.height / 2 + 70);
  await page.mouse.up();
  await expect(fullscreen).toBeVisible();
  await expect(fullscreen.getByRole('textbox', { name: 'Text to type in browser' })).toHaveValue('Fullscreen input');
  await fullscreen.getByRole('button', { name: 'Type', exact: true }).click();
  await expect.poll(() => commands).toContainEqual({ action: 'type', text: 'Fullscreen input' });
  await fullscreen.getByRole('button', { name: 'Close browser preview', exact: true }).click();
  await expect(fullscreen).toHaveCount(0);
  await expect(browser.getByRole('button', { name: 'Control browser page', exact: true })).toBeVisible();
});

test('remote touch scrolling cannot drag the surrounding browser sheet', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'The draggable browser sheet is mobile-only.');
  const commands: BrowserControl[] = [];
  await page.route(CONTROL_ROUTE, route => {
    commands.push(route.request().postDataJSON());
    return acceptControl(route);
  });
  const browser = await openControlledTab(page);
  const surface = browser.getByRole('button', { name: 'Control browser page', exact: true });
  await surface.hover();
  const bounds = await surface.boundingBox();
  if (!bounds) throw new Error('The control surface is missing.');
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await surface.evaluate((element, point) => {
    for (const [type, offset] of [['touchstart', 0], ['touchmove', 60]] as const) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: [{ identifier: 1, clientX: point.x, clientY: point.y + offset }] });
      element.dispatchEvent(event);
    }
  }, { x, y });
  await expect.poll(() => browser.locator('[data-dialog-surface]').evaluate(element => element instanceof HTMLElement ? element.style.translate : '')).toBe('');
  await page.mouse.move(x, y + 60);
  await page.mouse.up();
  await expect.poll(() => commands).toContainEqual({ action: 'scroll', x: expect.any(Number), y: expect.any(Number), deltaX: 0, deltaY: -180 });
  await expect(browser).toBeVisible();
});

test('fullscreen letterboxing and zoom preserve noncentral page coordinates', async ({ page }) => {
  await page.route(`**/api/tabs/${BROWSER_TAB_ID}/shot?*`, route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="1000" height="1000" fill="blue"/></svg>' }));
  const commands: BrowserControl[] = [];
  await page.route(CONTROL_ROUTE, route => { commands.push(route.request().postDataJSON()); return acceptControl(route); });
  const browser = await openControlledTab(page);
  await browser.getByRole('button', { name: 'Expand browser view', exact: true }).click();
  const fullscreen = page.getByRole('dialog', { name: 'Browser preview', exact: true });
  const surface = fullscreen.getByRole('button', { name: 'Control browser page', exact: true });
  const box = await surface.boundingBox();
  if (!box) throw new Error('The fullscreen surface is missing.');
  const side = Math.min(box.width, box.height);
  expect(Math.abs(box.width - box.height)).toBeGreaterThan(20);
  await page.mouse.click(box.x + (box.width > box.height ? 3 : box.width / 2), box.y + (box.height > box.width ? 3 : box.height / 2));
  await page.mouse.click(box.x + box.width / 2 - side / 4, box.y + box.height / 2 + side / 10);
  await expect.poll(() => commands).toEqual([{ action: 'click', x: expect.closeTo(.25, 2), y: expect.closeTo(.6, 2) }]);
  await fullscreen.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(() => surface.locator('img').evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a)).toBeCloseTo(1.5, 2);
  await page.mouse.click(box.x + box.width / 2 - side * 1.5 / 4, box.y + box.height / 2 + side * 1.5 / 10);
  await expect.poll(() => commands).toEqual([
    { action: 'click', x: expect.closeTo(.25, 2), y: expect.closeTo(.6, 2) },
    { action: 'click', x: expect.closeTo(.25, 2), y: expect.closeTo(.6, 2) },
  ]);
});

test('two-finger fullscreen zoom sends no remote gesture and the title can still dismiss', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Native multi-touch injection requires Chromium CDP.');
  const commands: BrowserControl[] = [];
  await page.route(CONTROL_ROUTE, route => { commands.push(route.request().postDataJSON()); return acceptControl(route); });
  const browser = await openControlledTab(page);
  await browser.getByRole('button', { name: 'Expand browser view', exact: true }).click();
  const fullscreen = page.getByRole('dialog', { name: 'Browser preview', exact: true });
  const surface = fullscreen.getByRole('button', { name: 'Control browser page', exact: true });
  const box = await surface.boundingBox();
  if (!box) throw new Error('The fullscreen surface is missing.');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x - 30, y, id: 1 }, { x: x + 30, y, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 60, y, id: 1 }, { x: x + 60, y, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: x + 60, y, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 60, y: y + 30, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(fullscreen.getByRole('button', { name: /Reset zoom/ })).not.toHaveText('100%');
    await surface.press('Enter');
    await expect.poll(() => commands).toEqual([{ action: 'key', key: 'Enter' }]);
  } finally {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await cdp.detach();
  }
  const title = await fullscreen.getByRole('heading', { name: BROWSER_TAB_TITLE, exact: true }).boundingBox();
  if (!title) throw new Error('The fullscreen title is missing.');
  await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2);
  await page.mouse.down();
  await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2 + 220, { steps: 8 });
  await page.mouse.up();
  await expect(fullscreen).toHaveCount(0);
});
