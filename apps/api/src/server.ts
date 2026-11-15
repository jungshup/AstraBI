import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

const allowedOrigins = new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function setCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'Origin');
  }
  response.setHeader('access-control-allow-methods', 'GET, OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type');
}

export function createApiServer(): Server {
  return createServer((request, response) => {
    setCors(request, response);
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method_not_allowed' });
      return;
    }

    if (pathname === '/health' || pathname === '/api/v1/health') {
      sendJson(response, 200, { status: 'ok', service: 'astrabi-api' });
      return;
    }

    if (pathname === '/api/v1/status') {
      sendJson(response, 200, {
        name: 'AstraBI',
        version: '0.1.0',
        environment: process.env.NODE_ENV ?? 'development',
        status: 'operational',
        checkedAt: new Date().toISOString(),
      });
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  });
}

export function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
}
