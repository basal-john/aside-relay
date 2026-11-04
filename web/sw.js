const SHELL_CACHE = 'aside-relay-shell-v1';
const ASSET_CACHE = 'aside-relay-assets-v1';
const SHELL_URLS = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/mark.svg'];
const MAX_ASSETS = 80;
const NAVIGATION_TIMEOUT_MS = 4_000;

self.addEventListener('install', event => event.waitUntil((async () => {
  try { await (await self.caches.open(SHELL_CACHE)).addAll(SHELL_URLS); } catch { }
  await self.skipWaiting();
})()));

self.addEventListener('activate', event => event.waitUntil((async () => {
  try {
    const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
    for (const key of await self.caches.keys()) if (key.startsWith('aside-relay-') && !keep.has(key)) await self.caches.delete(key);
  } catch { }
  await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') { event.respondWith(shellNavigation(request)); return; }
  if (url.pathname.startsWith('/assets/')) { event.respondWith(cachedAsset(request)); return; }
  if (SHELL_URLS.includes(url.pathname) && url.pathname !== '/') event.respondWith(freshOrCached(request, SHELL_CACHE));
});

/** Loads the page from the Mac and falls back to the cached app shell when the Mac or the tunnel is down. */
async function shellNavigation(request) {
  try {
    const response = await withTimeout(fetch(request), NAVIGATION_TIMEOUT_MS);
    if (response.ok && response.type === 'basic' && (response.headers.get('content-type') || '').includes('text/html')) {
      const copy = response.clone();
      self.caches.open(SHELL_CACHE).then(cache => cache.put('/', copy)).catch(() => { });
      return response;
    }
    if (response.status < 500) return response;
  } catch { }
  const cached = await self.caches.match('/', { cacheName: SHELL_CACHE }).catch(() => undefined);
  if (cached) return cached;
  return fetch(request);
}

/** Hashed build files never change, so a cached copy is always correct. */
async function cachedAsset(request) {
  const cache = await self.caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    const keys = await cache.keys();
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(key);
  }
  return response;
}

async function freshOrCached(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) { const copy = response.clone(); self.caches.open(cacheName).then(cache => cache.put(request, copy)).catch(() => { }); }
    return response;
  } catch {
    const cached = await self.caches.match(request, { cacheName });
    if (cached) return cached;
    throw new Error('offline');
  }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })]).finally(() => clearTimeout(timer));
}

self.addEventListener('push', event => {
  let notification;
  try { notification = event.data?.json()?.notification; } catch { }
  const target = conversationUrl(notification?.navigate);
  event.waitUntil(self.registration.showNotification(notification?.title || 'New response', {
    body: notification?.body || 'Your response is ready. Tap to open the conversation.',
    icon: '/icons/icon-192.png',
    tag: notification?.tag,
    data: { url: target.href },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = conversationUrl(event.notification.data?.url);
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (new URL(client.url).origin !== target.origin) continue;
      try {
        const didOpen = await new Promise(resolve => {
          const channel = new MessageChannel();
          const timeout = setTimeout(() => { channel.port1.close(); resolve(false); }, 1_000);
          channel.port1.onmessage = event => {
            clearTimeout(timeout);
            channel.port1.close();
            resolve(event.data === target.pathname);
          };
          client.postMessage({ type: 'open-conversation', url: target.href }, [channel.port2]);
        });
        const destination = didOpen ? client : await client.navigate(target.href);
        if (destination) { await destination.focus(); return; }
      } catch { }
    }
    await self.clients.openWindow(target.href);
  })());
});

function conversationUrl(value) {
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin === self.location.origin && /^\/c\/[A-Za-z0-9]{12,32}$/.test(url.pathname)) return url;
  } catch { }
  return new URL('/', self.location.origin);
}
