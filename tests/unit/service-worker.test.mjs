import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const serviceWorkerSource = await readFile(new URL('../../web/sw.js', import.meta.url), 'utf8')

function fakeCaches() {
  const stores = new Map()
  const keyOf = request => typeof request === 'string' ? request : new URL(request.url).pathname
  const open = async name => {
    if (!stores.has(name)) stores.set(name, new Map())
    const store = stores.get(name)
    return {
      async addAll(urls) { for (const url of urls) store.set(url, new Response('shell:' + url, { headers: { 'content-type': 'text/html' } })) },
      async put(request, response) { store.set(keyOf(request), response) },
      async match(request) { return store.get(keyOf(request))?.clone() },
      async keys() { return [...store.keys()].map(url => ({ url })) },
      async delete(request) { return store.delete(keyOf(request)) },
    }
  }
  return {
    stores,
    open,
    async keys() { return [...stores.keys()] },
    async delete(name) { return stores.delete(name) },
    async match(request, { cacheName }) { return (await open(cacheName)).match(request) },
  }
}

function serviceWorkerHarness({ clients = [], fetch = async () => { throw new TypeError('offline') }, instantTimers = true } = {}) {
  const handlers = new Map()
  const caches = fakeCaches()
  const notifications = []
  const opened = []
  let claimed = false
  let skipped = false

  class FakeMessageChannel {
    constructor() {
      const port1 = {
        closed: false,
        onmessage: undefined,
        close() { this.closed = true },
      }
      this.port1 = port1
      this.port2 = {
        postMessage(data) { port1.onmessage?.({ data }) },
      }
    }
  }

  const worker = {
    location: { origin: 'https://aside.test' },
    addEventListener(type, listener) { handlers.set(type, listener) },
    skipWaiting: async () => { skipped = true },
    caches,
    registration: {
      async showNotification(title, options) { notifications.push({ title, options }) },
    },
    clients: {
      async claim() { claimed = true },
      async matchAll(options) {
        assert.equal(options.type, 'window')
        assert.equal(options.includeUncontrolled, true)
        return clients
      },
      async openWindow(url) { opened.push(url); return { url } },
    },
  }
  const timers = new Set()
  const context = vm.createContext({
    self: worker,
    URL,
    Response,
    fetch,
    MessageChannel: FakeMessageChannel,
    setTimeout(callback) {
      const timer = { active: true }
      if (!instantTimers) return timer
      timers.add(timer)
      queueMicrotask(() => {
        if (timer.active) callback()
        timers.delete(timer)
      })
      return timer
    },
    clearTimeout(timer) { timer.active = false; timers.delete(timer) },
  })
  vm.runInContext(serviceWorkerSource, context, { filename: 'web/sw.js' })

  return {
    handlers,
    caches,
    notifications,
    opened,
    get claimed() { return claimed },
    get skipped() { return skipped },
  }
}

async function dispatchWaitable(handler, event) {
  let completion
  handler({
    ...event,
    waitUntil(promise) { completion = Promise.resolve(promise) },
  })
  assert.ok(completion, 'event handler must extend the service-worker lifetime')
  await completion
}

test('service worker activates immediately and claims existing app windows', async () => {
  const worker = serviceWorkerHarness()
  await dispatchWaitable(worker.handlers.get('install'), {})
  await dispatchWaitable(worker.handlers.get('activate'), {})
  assert.equal(worker.skipped, true)
  assert.equal(worker.claimed, true)
})

test('push notifications show the actual response title and body without an Aside byline', async () => {
  const worker = serviceWorkerHarness()
  await dispatchWaitable(worker.handlers.get('push'), {
    data: { json: () => ({ notification: {
      title: 'Research complete',
      body: 'I found three matching options.',
      navigate: '/c/abcdefghijkl',
      tag: 'conversation-abcdefghijkl',
    } }) },
  })

  assert.equal(worker.notifications.length, 1)
  const [{ title, options }] = worker.notifications
  assert.equal(title, 'Research complete')
  assert.equal(options.body, 'I found three matching options.')
  assert.doesNotMatch(`${title} ${options.body}`, /from aside/i)
  assert.equal(options.data.url, 'https://aside.test/c/abcdefghijkl')
  assert.equal(options.tag, 'conversation-abcdefghijkl')
})

test('malformed push data uses readable defaults and never opens an external destination', async () => {
  for (const data of [
    { json: () => { throw new Error('invalid JSON') } },
    { json: () => ({ notification: { navigate: 'https://attacker.test/c/abcdefghijkl' } }) },
    { json: () => ({ notification: { navigate: '/c/not-valid!' } }) },
  ]) {
    const worker = serviceWorkerHarness()
    await dispatchWaitable(worker.handlers.get('push'), { data })
    const [{ title, options }] = worker.notifications
    assert.equal(title, 'New response')
    assert.equal(options.body, 'Your response is ready. Tap to open the conversation.')
    assert.equal(options.data.url, 'https://aside.test/')
  }
})

test('notification clicks reuse an existing same-origin app after its navigation acknowledgement', async () => {
  let focused = false
  let navigated = false
  let posted
  const externalClient = {
    url: 'https://other.test/',
    postMessage() { throw new Error('cross-origin client must be ignored') },
  }
  const appClient = {
    url: 'https://aside.test/c/oldsession001',
    postMessage(message, [replyPort]) {
      posted = message
      replyPort.postMessage('/c/abcdefghijkl')
    },
    async navigate() { navigated = true },
    async focus() { focused = true },
  }
  const worker = serviceWorkerHarness({ clients: [externalClient, appClient] })
  let closed = false

  await dispatchWaitable(worker.handlers.get('notificationclick'), {
    notification: {
      data: { url: 'https://aside.test/c/abcdefghijkl' },
      close() { closed = true },
    },
  })

  assert.equal(closed, true)
  assert.equal(posted.type, 'open-conversation')
  assert.equal(posted.url, 'https://aside.test/c/abcdefghijkl')
  assert.equal(navigated, false)
  assert.equal(focused, true)
  assert.deepEqual(worker.opened, [])
})

test('missing navigation acknowledgement falls back to navigating and focusing the existing app', async () => {
  let navigatedTo
  let focused = false
  const destination = { async focus() { focused = true } }
  const appClient = {
    url: 'https://aside.test/',
    postMessage() {},
    async navigate(url) { navigatedTo = url; return destination },
  }
  const worker = serviceWorkerHarness({ clients: [appClient] })

  await dispatchWaitable(worker.handlers.get('notificationclick'), {
    notification: { data: { url: '/c/abcdefghijkl' }, close() {} },
  })

  assert.equal(navigatedTo, 'https://aside.test/c/abcdefghijkl')
  assert.equal(focused, true)
  assert.deepEqual(worker.opened, [])
})

test('notification clicks open a safe new window when no reusable app window exists', async () => {
  const worker = serviceWorkerHarness({ clients: [{ url: 'https://other.test/', postMessage() {} }] })
  await dispatchWaitable(worker.handlers.get('notificationclick'), {
    notification: { data: { url: 'https://attacker.test/c/abcdefghijkl' }, close() {} },
  })

  assert.deepEqual(worker.opened, ['https://aside.test/'])
})

async function respond(worker, request) {
  let response
  worker.handlers.get('fetch')({ request, respondWith(value) { response = Promise.resolve(value) } })
  return response && await response
}

const navigation = path => ({ method: 'GET', mode: 'navigate', url: 'https://aside.test' + path })

test('install caches the app shell so the Home Screen app opens while the Mac is offline', async () => {
  const worker = serviceWorkerHarness({ instantTimers: false })
  await dispatchWaitable(worker.handlers.get('install'), {})
  const response = await respond(worker, navigation('/c/abcdefghijkl'))
  assert.equal(await response.text(), 'shell:/')
})

test('a 502 from the proxy falls back to the cached shell, a 404 does not', async () => {
  let status = 502
  const worker = serviceWorkerHarness({ fetch: async () => new Response('bad gateway', { status }), instantTimers: false })
  await dispatchWaitable(worker.handlers.get('install'), {})
  assert.equal(await (await respond(worker, navigation('/'))).text(), 'shell:/')
  status = 404
  assert.equal((await respond(worker, navigation('/'))).status, 404)
})

test('API, WebSocket and cross-origin requests are never served from the cache', async () => {
  const worker = serviceWorkerHarness()
  for (const url of ['https://aside.test/api/sessions', 'https://aside.test/ws', 'https://other.test/assets/x.js']) {
    assert.equal(await respond(worker, { method: 'GET', mode: 'cors', url }), undefined)
  }
  assert.equal(await respond(worker, { method: 'POST', mode: 'cors', url: 'https://aside.test/assets/x.js' }), undefined)
})

test('activate deletes old app caches only', async () => {
  const worker = serviceWorkerHarness()
  await worker.caches.open('aside-relay-shell-v0')
  await worker.caches.open('someone-else')
  await dispatchWaitable(worker.handlers.get('activate'), {})
  assert.deepEqual([...worker.caches.stores.keys()], ['someone-else'])
})
