import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../web/dist');
const publicRoot = path.resolve(import.meta.dirname, '../web');
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
await readFile(path.join(root, 'index.html'));

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const isPublicAsset = pathname === '/sw.js' || pathname === '/manifest.webmanifest' || pathname === '/favicon.ico' || pathname.startsWith('/icons/') || pathname.startsWith('/vendor/');
    const assetRoot = isPublicAsset ? publicRoot : root;
    const assetPath = pathname === '/favicon.ico' ? '/icons/favicon.ico' : pathname;
    const target = path.extname(pathname) ? path.resolve(assetRoot, '.' + assetPath) : path.join(root, 'index.html');
    if (!target.startsWith(assetRoot + path.sep)) { response.writeHead(403).end(); return; }
    if (pathname.startsWith('/api/') || pathname === '/ws') { response.writeHead(501).end('Test requests must be explicitly intercepted.'); return; }
    const content = await readFile(target);
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(content);
  } catch {
    response.writeHead(404).end();
  }
});
server.listen(4175, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
