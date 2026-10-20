import type { Page } from '@playwright/test';
import { expect, SESSION_A, test } from './fixture';

type ViewportValues = {
  width: number;
  height: number;
  offsetTop: number;
  innerHeight?: number;
  layoutHeight?: number;
};

type MockViewport = {
  set: (values: ViewportValues, event?: 'resize' | 'scroll' | false) => void;
  setVisibility: (state: DocumentVisibilityState) => void;
  snapshot: () => ViewportValues;
};

declare global {
  interface Window {
    __mockViewport: MockViewport;
  }
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-webkit', 'iPhone visual viewport regression');
  await page.addInitScript(() => {
    const nativeInnerHeight = window.innerHeight;
    const values: ViewportValues = {
      width: window.innerWidth,
      height: nativeInnerHeight,
      offsetTop: 0,
      innerHeight: nativeInnerHeight,
      layoutHeight: nativeInnerHeight,
    };
    let visibilityState: DocumentVisibilityState = 'visible';
    const viewport = new EventTarget() as EventTarget & VisualViewport;
    Object.defineProperties(viewport, {
      width: { get: () => values.width },
      height: { get: () => values.height },
      offsetTop: { get: () => values.offsetTop },
      offsetLeft: { get: () => 0 },
      pageTop: { get: () => values.offsetTop },
      pageLeft: { get: () => 0 },
      scale: { get: () => 1 },
    });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => values.innerHeight });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibilityState });
    let hasLayoutHeightOverride = false;
    window.__mockViewport = {
      set(next, event = 'resize') {
        Object.assign(values, next);
        if (!hasLayoutHeightOverride) {
          Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, get: () => values.layoutHeight });
          hasLayoutHeightOverride = true;
        }
        if (event) viewport.dispatchEvent(new Event(event));
      },
      setVisibility(next) { visibilityState = next; },
      snapshot() { return { ...values }; },
    };
  });
  await page.goto(`/c/${SESSION_A}`);
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
});

test('keyboard panning keeps the fixed header and composer inside the visible viewport', async ({ page }) => {
  const screen = requiredViewport(page);
  const draft = page.getByRole('textbox', { name: 'Message' });
  await draft.fill('Draft survives keyboard geometry changes');

  const keyboard = {
    width: screen.width,
    height: screen.height - 280,
    offsetTop: 48,
    innerHeight: screen.height,
    layoutHeight: screen.height,
  };
  await setViewport(page, keyboard);
  await expectKeyboardLayout(page, keyboard.offsetTop, keyboard.offsetTop + keyboard.height);
  await expect(page.getByRole('button', { name: 'Open browser', exact: true })).toBeVisible();

  await setViewport(page, { ...keyboard, innerHeight: keyboard.height, layoutHeight: keyboard.height });
  await expectKeyboardLayout(page, keyboard.offsetTop, keyboard.offsetTop + keyboard.height);
  await expect(page.getByRole('button', { name: 'Open browser', exact: true })).toHaveCount(1);
  await expect(draft).toHaveValue('Draft survives keyboard geometry changes');
});

test('stale visual viewport values cannot displace the shell after a portrait landscape round trip', async ({ page }) => {
  const portrait = requiredViewport(page);
  const draft = page.getByRole('textbox', { name: 'Message' });
  await draft.fill('Rotation draft');
  await draft.blur();

  const landscape = { width: portrait.height, height: portrait.width };
  await page.setViewportSize(landscape);
  await setViewport(page, { ...landscape, offsetTop: 0, innerHeight: landscape.height, layoutHeight: landscape.height });
  await page.setViewportSize(portrait);
  await setViewport(page, {
    width: portrait.width,
    height: portrait.height - 230,
    offsetTop: 96,
    innerHeight: portrait.height,
    layoutHeight: portrait.height,
  });

  await expect.poll(() => shellBounds(page)).toMatchObject({ top: 0, height: portrait.height });
  await expect.poll(() => composerBottom(page)).toBeCloseTo(portrait.height, 0);
  await expect(headerTop(page)).resolves.toBeGreaterThanOrEqual(0);
  await expect(draft).toHaveValue('Rotation draft');
});

test('a viewport correction that settles after 100ms is reconciled without another viewport event', async ({ page }) => {
  const screen = requiredViewport(page);
  const draft = page.getByRole('textbox', { name: 'Message' });
  await draft.fill('Late viewport draft');
  await setViewport(page, {
    width: screen.width,
    height: screen.height - 190,
    offsetTop: 20,
    innerHeight: screen.height,
    layoutHeight: screen.height,
  });

  const settled = {
    width: screen.width,
    height: screen.height - 300,
    offsetTop: 64,
    innerHeight: screen.height,
    layoutHeight: screen.height,
  };
  await page.waitForTimeout(160);
  await setViewport(page, settled, false);

  await expect.poll(() => composerBottom(page), { timeout: 2_000 }).toBeCloseTo(settled.offsetTop + settled.height, 0);
  await expect(page.getByRole('button', { name: 'Open browser', exact: true })).toHaveCount(1);
  await expect(draft).toHaveValue('Late viewport draft');
});

test('app return signals recover stale geometry across repeated keyboard and rotation cycles', async ({ page, mockAside }) => {
  const portrait = requiredViewport(page);
  const landscape = { width: portrait.height, height: portrait.width };
  const draft = page.getByRole('textbox', { name: 'Message' });
  await draft.fill('Persistent draft');

  for (let cycle = 0; cycle < 4; cycle += 1) {
    const keyboard = {
      width: portrait.width,
      height: portrait.height - 260 - cycle * 4,
      offsetTop: 32 + cycle,
      innerHeight: portrait.height,
      layoutHeight: portrait.height,
    };
    await setViewport(page, keyboard);
    await expectKeyboardLayout(page, keyboard.offsetTop, keyboard.offsetTop + keyboard.height);
    await expect(page.getByRole('button', { name: 'Open browser', exact: true })).toBeVisible();

    await page.setViewportSize(landscape);
    const rotatedKeyboard = {
      width: landscape.width,
      height: landscape.height - 180,
      offsetTop: 24,
      innerHeight: landscape.height,
      layoutHeight: landscape.height,
    };
    await setViewport(page, rotatedKeyboard);
    await expectKeyboardLayout(page, rotatedKeyboard.offsetTop, rotatedKeyboard.offsetTop + rotatedKeyboard.height);
    await page.setViewportSize(portrait);

    await page.evaluate(values => {
      const mock = window.__mockViewport;
      mock.set(values, false);
      mock.setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      mock.setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      window.dispatchEvent(new Event('focus'));
    }, { width: portrait.width, height: portrait.height, offsetTop: 0, innerHeight: portrait.height, layoutHeight: portrait.height });

    await expect.poll(() => composerBottom(page)).toBeCloseTo(portrait.height, 0);
    await expect.poll(() => shellBounds(page)).toMatchObject({ top: 0, height: portrait.height });
    const toolbarButton = page.locator('#composer button[aria-label="Open browser"]');
    await expect(toolbarButton).toHaveCount(1);
    await expect(toolbarButton).toBeHidden();
    await expect(draft).toHaveValue('Persistent draft');
  }
  expect(mockAside.socketMessages.filter(message => message.op === 'run' || message.op === 'continue')).toEqual([]);
});

function requiredViewport(page: Page) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('A fixed mobile viewport is required.');
  return viewport;
}

async function setViewport(page: Page, values: ViewportValues, event: 'resize' | 'scroll' | false = 'resize') {
  await page.evaluate(({ values, event }) => window.__mockViewport.set(values, event), { values, event });
}

async function expectKeyboardLayout(page: Page, visibleTop: number, visibleBottom: number) {
  await expect.poll(() => composerBottom(page)).toBeCloseTo(visibleBottom, 0);
  await expect.poll(async () => await headerTop(page) - visibleTop).toBeCloseTo(0, 0);
}

async function composerBottom(page: Page) {
  const box = await page.locator('#composer').boundingBox();
  if (!box) throw new Error('Composer is not rendered.');
  return Math.round(box.y + box.height);
}

async function headerTop(page: Page) {
  const box = await page.locator('header').boundingBox();
  if (!box) throw new Error('Header is not rendered.');
  return Math.round(box.y);
}

async function shellBounds(page: Page) {
  return page.locator('#root > div').first().evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { top: Math.round(bounds.top), height: Math.round(bounds.height) };
  });
}
