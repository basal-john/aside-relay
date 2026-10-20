import { expect, SESSION_A, test } from './fixture';
import type { Page, Route } from '@playwright/test';

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
