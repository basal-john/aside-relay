import { expect, SESSION_A, test } from './fixture';
import type { Page, Route } from '@playwright/test';

const PUBLIC_KEY = 'A'.repeat(87);
const PUSH_CONFIG_PATH = '/api/push/config';
const PUSH_SUBSCRIPTIONS_PATH = '/api/push/subscriptions';

async function installSocketSequence(page: Page, closeCodes: (number | undefined)[]) {
  await page.addInitScript(({ closeCodes }) => {
    const state = { created: 0, sent: [] as string[] };

    class SyntheticWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly url: string;
      readyState = SyntheticWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;

      constructor(url: string | URL) {
        this.url = String(url);
        const closeCode = closeCodes[state.created++];
        queueMicrotask(() => {
          if (closeCode != null) {
            this.readyState = SyntheticWebSocket.CLOSED;
            this.onclose?.(new CloseEvent('close', { code: closeCode }));
            return;
          }
          this.readyState = SyntheticWebSocket.OPEN;
          this.onopen?.(new Event('open'));
          this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ op: 'hello', running: [] }) }));
        });
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        state.sent.push(String(data));
      }

      close(code = 1000) {
        this.readyState = SyntheticWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close', { code }));
      }
    }

    Object.defineProperty(window, 'WebSocket', { configurable: true, value: SyntheticWebSocket });
    Reflect.set(window, '__authSocketRegression', state);
  }, { closeCodes });
}

async function installPushHarness(page: Page, initialSubscription: 'matching' | 'stale') {
  await page.addInitScript(({ initialSubscription, publicKey }) => {
    const decodeKey = (value: string) => Uint8Array.from(
      atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='),
      character => character.charCodeAt(0),
    ).buffer;
    const expectedKey = decodeKey(publicKey);
    const staleKey = new Uint8Array(expectedKey.byteLength).fill(1).buffer;
    const state = { getCalls: 0, subscribeCalls: 0, unsubscribeCalls: 0 };

    class SyntheticSubscription {
      readonly options: { applicationServerKey: ArrayBuffer };

      constructor(key: ArrayBuffer) {
        this.options = { applicationServerKey: key };
      }

      async unsubscribe() {
        state.unsubscribeCalls += 1;
        currentSubscription = undefined;
        return true;
      }

      toJSON() {
        return {
          endpoint: 'https://push.example.test/subscription',
          expirationTime: null,
          keys: { auth: 'auth', p256dh: 'p256dh' },
        };
      }
    }

    let currentSubscription: SyntheticSubscription | undefined = new SyntheticSubscription(initialSubscription === 'matching' ? expectedKey : staleKey);
    const pushManager = {
      async getSubscription() {
        state.getCalls += 1;
        return currentSubscription;
      },
      async subscribe() {
        state.subscribeCalls += 1;
        currentSubscription = new SyntheticSubscription(expectedKey);
        return currentSubscription;
      },
    };
    const registration = { active: {}, pushManager };
    const serviceWorker = {
      ready: Promise.resolve(registration),
      async register() { return registration; },
      addEventListener() {},
      removeEventListener() {},
    };

    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: { permission: 'granted', async requestPermission() { return 'granted'; } },
    });
    Object.defineProperty(window, 'PushManager', { configurable: true, value: class PushManager {} });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    Reflect.set(window, '__pushRegression', state);
  }, { initialSubscription, publicKey: PUBLIC_KEY });
}

async function openSettings(page: Page) {
  const openDrawer = page.getByRole('button', { name: /Open conversations/ });
  if (await openDrawer.isVisible()) await openDrawer.click();
  await page.getByRole('button', { name: /Settings/ }).click();
  return page.getByRole('dialog', { name: 'Settings' });
}

function fulfillJson(route: Route, value: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
}

test('uses a saved token when the web token endpoint is temporarily unavailable', async ({ page, mockAside }) => {
  await page.addInitScript(() => localStorage.setItem('token', 'saved-token'));
  await page.route('**/api/web-token', route => fulfillJson(route, { error: 'temporarily unavailable' }, 503));
  const sessionAuthorizations: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/sessions') {
      sessionAuthorizations.push(request.headers().authorization ?? '');
    }
  });

  await page.goto(`/?session=${SESSION_A}`);

  await expect(page.getByText('Hello from the assistant.')).toBeVisible();
  await expect.poll(() => sessionAuthorizations).toContain('Bearer saved-token');
  expect(mockAside.calls.filter(call => call.method === 'POST' && call.path === '/api/auth')).toHaveLength(1);
});

test('keeps the tab connected when persistent token storage throws', async ({ page }) => {
  await page.addInitScript(() => {
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      Object.defineProperty(Storage.prototype, method, {
        configurable: true,
        value() { throw new DOMException('Storage is blocked.', 'SecurityError'); },
      });
    }
  });

  await page.goto(`/?session=${SESSION_A}`);

  await expect(page.getByText('Hello from the assistant.')).toBeVisible();
  await expect(page.getByText("Connected for this tab, but the access token couldn't be saved.")).toBeVisible();
});

test('refreshes authentication after a WebSocket closes before opening', async ({ page, mockAside }) => {
  await installSocketSequence(page, [1006, undefined]);

  await page.goto(`/?session=${SESSION_A}`);

  await expect(page.getByText('Hello from the assistant.')).toBeVisible();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__authSocketRegression').created)).toBe(2);
  expect(mockAside.calls.filter(call => call.method === 'POST' && call.path === '/api/auth')).toHaveLength(1);
});

test('stops refreshing authentication after a repeated pre-open 4401', async ({ page, mockAside }) => {
  await installSocketSequence(page, [4401, 4401]);

  await page.goto(`/?session=${SESSION_A}`);

  await expect(page.getByRole('alert')).toContainText('Connect to load your conversations.');
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__authSocketRegression').created)).toBe(2);
  await page.waitForTimeout(1_200);
  expect(await page.evaluate(() => Reflect.get(window, '__authSocketRegression').created)).toBe(2);
  expect(mockAside.calls.filter(call => call.method === 'POST' && call.path === '/api/auth')).toHaveLength(1);
});

test('finishes disabling after an in-flight notification restore', async ({ page }) => {
  await installPushHarness(page, 'matching');
  let subscriptionPuts = 0;
  let subscriptionDeletes = 0;
  let holdNextPut = false;
  let releaseHeldPut = () => {};
  let markHeldPutStarted = () => {};
  const heldPutStarted = new Promise<void>(resolve => { markHeldPutStarted = resolve; });
  await page.route('**/api/push/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === PUSH_CONFIG_PATH) {
      return fulfillJson(route, { publicKey: PUBLIC_KEY });
    }
    if (request.method() === 'PUT' && url.pathname === PUSH_SUBSCRIPTIONS_PATH) {
      subscriptionPuts += 1;
      if (holdNextPut) {
        holdNextPut = false;
        markHeldPutStarted();
        await new Promise<void>(resolve => { releaseHeldPut = resolve; });
      }
      return fulfillJson(route, { id: 'a'.repeat(64) });
    }
    if (request.method() === 'DELETE' && url.pathname.startsWith(PUSH_SUBSCRIPTIONS_PATH + '/')) {
      subscriptionDeletes += 1;
      return fulfillJson(route, { deleted: true });
    }
    return fulfillJson(route, { ok: true });
  });

  await page.goto(`/?session=${SESSION_A}`);
  const settings = await openSettings(page);
  await expect(settings.getByText('Enabled', { exact: true })).toBeVisible();
  holdNextPut = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await heldPutStarted;
  const disable = settings.getByRole('button', { name: 'Turn off notifications' });
  await disable.click();
  releaseHeldPut();

  await expect(settings.getByText('Off', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__pushRegression').unsubscribeCalls)).toBe(1);
  expect(subscriptionPuts).toBeGreaterThanOrEqual(2);
  expect(subscriptionDeletes).toBe(1);
});

test('replaces a stale VAPID subscription before enabling notifications', async ({ page }) => {
  await installPushHarness(page, 'stale');
  let subscriptionPuts = 0;
  await page.route('**/api/push/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === PUSH_CONFIG_PATH) {
      return fulfillJson(route, { publicKey: PUBLIC_KEY });
    }
    if (request.method() === 'PUT' && url.pathname === PUSH_SUBSCRIPTIONS_PATH) {
      subscriptionPuts += 1;
      return fulfillJson(route, { id: 'b'.repeat(64) });
    }
    return fulfillJson(route, { ok: true });
  });

  await page.goto(`/?session=${SESSION_A}`);
  const settings = await openSettings(page);
  await expect(settings.getByText('Off', { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'Enable notifications' }).click();

  await expect(settings.getByText('Enabled', { exact: true })).toBeVisible();
  const state = await page.evaluate(() => Reflect.get(window, '__pushRegression'));
  expect(state.unsubscribeCalls).toBe(1);
  expect(state.subscribeCalls).toBe(1);
  expect(subscriptionPuts).toBe(1);
});
