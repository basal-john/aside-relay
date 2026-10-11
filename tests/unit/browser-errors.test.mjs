import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getBrowserStreamUrl,
  getWebsiteUrl,
  isTabResponse,
  parseBrowserLibrary,
} from '../../web/src/browser.ts'
import {
  BROWSER_CONNECTION_MESSAGE,
  GENERIC_ERROR_MESSAGE,
  formatRequestError,
} from '../../web/src/errors.ts'

test('website links only expose HTTP and HTTPS destinations', () => {
  assert.equal(getWebsiteUrl('https://example.com/path?q=one two'), 'https://example.com/path?q=one%20two')
  assert.equal(getWebsiteUrl('http://localhost:3000/'), 'http://localhost:3000/')
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'file:///Users/me/private', 'not a url']) {
    assert.equal(getWebsiteUrl(value), undefined)
  }
})

test('browser stream URLs encode tab and session identifiers without changing query meaning', () => {
  assert.equal(
    getBrowserStreamUrl('tab/a?b', 'session & one', true, 5),
    '/api/native/browser/tabs/tab%2Fa%3Fb/stream.mjpeg?fps=5&session=session+%26+one&all=true',
  )
  assert.equal(getBrowserStreamUrl('tab'), '/api/native/browser/tabs/tab/stream.mjpeg?fps=2')
})

test('tab responses preserve explicit asleep metadata and reject malformed timestamps', () => {
  const asleep = { targetId: 'tab-1', url: 'https://example.com', title: 'Example', active: false, loaded: false, favicon: null, lastAccessed: 0 }
  assert.equal(isTabResponse({ tabs: [asleep] }), true)
  assert.equal(isTabResponse({ tabs: [{ ...asleep, loaded: 'false' }] }), false)
  assert.equal(isTabResponse({ tabs: [{ ...asleep, lastAccessed: Number.NaN }] }), false)
  assert.equal(isTabResponse({ tabs: [{ ...asleep, lastAccessed: Number.POSITIVE_INFINITY }] }), false)
})

test('browser library drops unsafe destinations and supplies useful visible fallbacks', () => {
  const result = parseBrowserLibrary({ items: [
    { url: 'https://example.com/article', title: '', visitCount: 3 },
    { id: 'unsafe', url: 'javascript:alert(1)', title: 'Do not show' },
    null,
  ] }, 'history')

  assert.deepEqual(result, [{
    id: 'history:https://example.com/article',
    title: 'example.com',
    url: 'https://example.com/article',
    favicon: undefined,
    detail: '3 visits',
  }])
  assert.throws(() => parseBrowserLibrary({ items: null }, 'bookmarks'), /Invalid browser library response/)
})

test('browser history never renders invalid visit-count metadata', () => {
  for (const visitCount of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    const [item] = parseBrowserLibrary({ items: [{ url: 'https://example.com', visitCount }] }, 'history')
    assert.equal(item.detail, undefined)
  }
})

test('raw CLI connection details, email addresses, file paths, and logs never reach the UI', () => {
  const privateFailures = [
    'Aside CLI 1.26.1008.1938 is available. Aside Browser profile for account u0 — mym0***@gmail.com ("Profile 0") is not connected to the daemon. Run: aside update',
    'Error: failed at /Users/mj/.aside/u0/session.json\n    at connect (daemon.ts:42:7)',
    'spawn aside ENOENT\nstderr: token=secret',
  ]

  assert.equal(formatRequestError({ message: privateFailures[0] }), BROWSER_CONNECTION_MESSAGE)
  for (const message of privateFailures.slice(1)) {
    const visible = formatRequestError({ message })
    assert.equal(visible, GENERIC_ERROR_MESSAGE)
    assert.doesNotMatch(visible, /@|\/Users\/|stderr|token=/)
  }
})

test('known HTTP and network failures become concise actionable messages', () => {
  assert.equal(formatRequestError({ status: 413, message: 'nginx body exceeded at /private/path' }), 'The image is too large. Choose a smaller image.')
  assert.equal(formatRequestError({ message: 'Failed to fetch' }), 'Check your connection and try again.')
  assert.equal(formatRequestError({ message: 'session abc is already running' }), 'This conversation is already running.')
})
