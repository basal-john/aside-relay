import type { Page, Route } from '@playwright/test';
import { BROWSER_TAB_ID, BROWSER_TAB_TITLE, SESSION_A, expect, test } from './fixture';

const SHOT_ROUTE = '**/api/tabs/*/shot?*';
const REFRESH_SETTLE_MS = 1_250;

test('floating preview uses a decoded finite shot without requesting MJPEG', async ({ page }) => {
  const requestedUrls: string[] = [];
  let shotCount = 0;
  page.on('request', request => requestedUrls.push(request.url()));
  await page.route(SHOT_ROUTE, route => {
    shotCount += 1;
    return fulfillShot(route, '#d12f3f');
  });

  await page.goto(`/c/${SESSION_A}`);
  const image = previewImage(page);
  await expect.poll(() => shotCount).toBeGreaterThan(0);
  await expect.poll(() => naturalWidth(image)).toBeGreaterThan(0);
  expect(requestedUrls.some(url => url.includes('stream.mjpeg'))).toBe(false);
});

test('corrupt JPEG keeps the last decoded frame until a later valid shot arrives', async ({ page }) => {
  const thirdShot = deferred();
  let shotCount = 0;
  await page.route(SHOT_ROUTE, async route => {
    shotCount += 1;
    if (shotCount === 2) {
      await route.fulfill({ status: 200, contentType: 'image/jpeg', body: 'corrupt jpeg' });
      return;
    }
    if (shotCount === 3) await thirdShot.promise;
    await fulfillShot(route, shotCount === 1 ? '#2166d1' : '#1f9d55');
  });

  await page.goto(`/c/${SESSION_A}`);
  const image = previewImage(page);
  await expect.poll(() => naturalWidth(image)).toBeGreaterThan(0);
  const firstSource = await image.getAttribute('src');
  await expect.poll(() => shotCount).toBe(3);
  await expect(image).toHaveAttribute('src', firstSource ?? '');

  thirdShot.resolve();
  await expect.poll(() => image.getAttribute('src')).not.toBe(firstSource);
  await expect.poll(() => naturalWidth(image)).toBeGreaterThan(0);
});

test('visible pageshow resumes capture after the PWA was hidden', async ({ page }) => {
  let shotCount = 0;
  await page.route(SHOT_ROUTE, route => {
    shotCount += 1;
    return fulfillShot(route, '#7b4cc9');
  });

  await page.goto(`/c/${SESSION_A}`);
  await expect.poll(() => shotCount).toBeGreaterThan(0);
  await setVisibility(page, 'hidden');
  await expectStableCount(() => shotCount, page);

  const hiddenShotCount = shotCount;
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    window.dispatchEvent(new Event('pageshow'));
  });
  await expect.poll(() => shotCount).toBeGreaterThan(hiddenShotCount);
});

test('hidden aborts a pending first shot so pageshow can capture a fresh frame', async ({ page }) => {
  const firstShot = deferred();
  let shotCount = 0;
  let wasFirstShotAborted = false;
  page.on('requestfailed', request => {
    if (request.url().includes(`/api/tabs/${BROWSER_TAB_ID}/shot`)) wasFirstShotAborted = true;
  });
  await page.route(SHOT_ROUTE, async route => {
    shotCount += 1;
    if (shotCount === 1) {
      await firstShot.promise;
      try { await fulfillShot(route, '#983a8f'); }
      catch { /* The application aborted this route while it was pending. */ }
      return;
    }
    await fulfillShot(route, '#3a8f62');
  });

  await page.goto(`/c/${SESSION_A}`);
  await expect.poll(() => shotCount).toBe(1);
  await setVisibility(page, 'hidden');
  try {
    await expect.poll(() => wasFirstShotAborted).toBe(true);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      window.dispatchEvent(new Event('pageshow'));
    });
    await expect.poll(() => shotCount, { timeout: 4_000 }).toBeGreaterThan(1);
    await expect.poll(() => naturalWidth(previewImage(page)), { timeout: 4_000 }).toBeGreaterThan(0);
  } finally {
    firstShot.resolve();
  }
});

test('minimized, closed, and asleep previews stop capture and resume only when available', async ({ page, mockAside }) => {
  let shotCount = 0;
  await page.route(SHOT_ROUTE, route => {
    shotCount += 1;
    return fulfillShot(route, '#d07a20');
  });

  await page.goto(`/c/${SESSION_A}`);
  await expect.poll(() => shotCount).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Minimize browser preview' }).click();
  await expectStableCount(() => shotCount, page);

  await page.getByRole('button', { name: 'Restore browser preview' }).click();
  const restoredShotCount = shotCount;
  await expect.poll(() => shotCount).toBeGreaterThan(restoredShotCount);

  mockAside.tabs[0].loaded = false;
  await expect(page.getByText('Tab asleep', { exact: true })).toBeVisible({ timeout: 4_000 });
  await expectStableCount(() => shotCount, page);

  mockAside.tabs[0].loaded = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => naturalWidth(previewImage(page)), { timeout: 4_000 }).toBeGreaterThan(0);
  const awakeShotCount = shotCount;
  await expect.poll(() => shotCount).toBeGreaterThan(awakeShotCount);

  await page.getByRole('button', { name: 'Close browser preview', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Browser preview' })).toHaveCount(0);
  await expectStableCount(() => shotCount, page);
});

test('late shot from the previous tab cannot replace the active tab preview', async ({ page, mockAside }) => {
  const oldShot = deferred();
  let oldShotStarted = false;
  await page.route(SHOT_ROUTE, async route => {
    const targetId = new URL(route.request().url()).pathname.split('/')[3];
    if (targetId === BROWSER_TAB_ID) {
      oldShotStarted = true;
      await oldShot.promise;
      await fulfillShot(route, '#c92b65');
      return;
    }
    await fulfillShot(route, '#218a72');
  });

  await page.goto(`/c/${SESSION_A}`);
  await expect.poll(() => oldShotStarted).toBe(true);
  mockAside.tabs = [{ targetId: 'tab-second-002', title: 'Second tab', url: 'https://example.com/second', active: true, loaded: true, lastAccessed: Date.now() }];
  const newHandle = page.getByRole('button', { name: 'Open browser preview: Second tab' });
  await expect(newHandle).toBeVisible({ timeout: 4_000 });
  const image = previewImage(page);
  await expect.poll(() => naturalWidth(image)).toBeGreaterThan(0);
  const activeSource = await image.getAttribute('src');

  oldShot.resolve();
  await page.waitForTimeout(100);
  await expect(image).toHaveAttribute('src', activeSource ?? '');
  await expect(page.getByRole('button', { name: `Open browser preview: ${BROWSER_TAB_TITLE}` })).toHaveCount(0);
});

test('switching tabs never paints the previous frame under the new tab title', async ({ page, mockAside }) => {
  const secondTabShot = deferred();
  let isSecondTabShotPending = false;
  await page.route(SHOT_ROUTE, async route => {
    const targetId = new URL(route.request().url()).pathname.split('/')[3];
    if (targetId === BROWSER_TAB_ID) {
      await fulfillShot(route, '#3867d6');
      return;
    }
    isSecondTabShotPending = true;
    await secondTabShot.promise;
    await fulfillShot(route, '#20a36b');
  });

  await page.goto(`/c/${SESSION_A}`);
  const image = previewImage(page);
  await expect.poll(() => naturalWidth(image)).toBeGreaterThan(0);
  const firstSource = await image.getAttribute('src');
  await page.evaluate(() => {
    document.body.dataset.secondTabFramePending = 'true';
    document.body.dataset.previousFrameLeak = 'false';
    const detectLeak = () => {
      const handle = document.querySelector('button[aria-label="Open browser preview: Second tab"]');
      const preview = document.querySelector('[aria-label="Browser preview"]');
      if (document.body.dataset.secondTabFramePending === 'true' && handle && preview?.querySelector('img')) {
        document.body.dataset.previousFrameLeak = 'true';
      }
    };
    new MutationObserver(detectLeak).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-label', 'src'] });
    detectLeak();
  });

  mockAside.tabs = [{ targetId: 'tab-second-002', title: 'Second tab', url: 'https://example.com/second', active: true, loaded: true, lastAccessed: Date.now() }];
  const newHandle = page.getByRole('button', { name: 'Open browser preview: Second tab' });
  await expect(newHandle).toBeVisible({ timeout: 4_000 });
  await expect.poll(() => isSecondTabShotPending).toBe(true);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(previewImage(page)).toHaveCount(0);
  expect(await page.evaluate(() => document.body.dataset.previousFrameLeak)).toBe('false');

  await page.evaluate(() => { document.body.dataset.secondTabFramePending = 'false'; });
  secondTabShot.resolve();
  await expect.poll(() => naturalWidth(previewImage(page))).toBeGreaterThan(0);
  await expect.poll(() => previewImage(page).getAttribute('src')).not.toBe(firstSource);
  expect(await page.evaluate(() => document.body.dataset.previousFrameLeak)).toBe('false');
});

function previewImage(page: Page) {
  return page.getByRole('region', { name: 'Browser preview' }).locator('img');
}

async function naturalWidth(image: ReturnType<typeof previewImage>) {
  return image.evaluate(element => element instanceof HTMLImageElement ? element.naturalWidth : 0);
}

function fulfillShot(route: Route, fill: string) {
  return route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="${fill}"/></svg>`,
  });
}

async function setVisibility(page: Page, visibility: 'hidden' | 'visible') {
  await page.evaluate(nextVisibility => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => nextVisibility });
    document.dispatchEvent(new Event('visibilitychange'));
  }, visibility);
}

async function expectStableCount(readCount: () => number, page: Page) {
  const count = readCount();
  await page.waitForTimeout(REFRESH_SETTLE_MS);
  expect(readCount()).toBe(count);
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}
