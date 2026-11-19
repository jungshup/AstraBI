import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
const apiUrl = new URL(process.env.ASTRABI_API_URL ?? 'http://localhost:4000');
const publicDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }

  if (pathname === '/config.js') {
    response.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'self'; connect-src 'self' ${apiUrl.origin}; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    response.end(`window.ASTRABI_API_URL = ${JSON.stringify(apiUrl.origin)};`);
    return;
  }

  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = resolve(publicDirectory, `.${requestedPath}`);
  const pathFromRoot = relative(publicDirectory, filePath);
  if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === '..') {
    response.writeHead(404).end();
    return;
  }

  try {
    const file = await stat(filePath);
    if (!file.isFile()) {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, {
      'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
      'content-length': file.size,
      'content-security-policy': `default-src 'self'; connect-src 'self' ${apiUrl.origin}; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = createReadStream(filePath);
    stream.on('error', (error) => {
      console.error('Unable to stream web asset.', error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
    stream.pipe(response);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT') {
      response.writeHead(404).end();
      return;
    }
    console.error('Unable to serve web asset.', error);
    response.writeHead(500).end();
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`AstraBI web app listening on port ${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close());
}
