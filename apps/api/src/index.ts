import { createServer } from 'node:http';
import { createDatabaseClient, ensureDatabaseConnected, seedBaseData } from '@astrabi/prisma';

const db = createDatabaseClient();
let databaseConnected = false;

function sendJson(response: any, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function setCors(request: any, response: any): void {
  const origin = request.headers.origin;
  const allowedOrigins = new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);

  if (origin && allowedOrigins.has(origin)) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'Origin');
  }

  response.setHeader('access-control-allow-methods', 'GET, OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type');
}

export async function initializeDatabase(): Promise<boolean> {
  databaseConnected = await ensureDatabaseConnected(db);
  if (databaseConnected) {
    await seedBaseData(db);
  }
  return databaseConnected;
}

export function createApiServer(): ReturnType<typeof createServer> {
  return createServer((request, response) => {
    void (async () => {
      try {
        setCors(request, response);

        if (request.method === 'OPTIONS') {
          response.writeHead(204);
          response.end();
          return;
        }

        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

        if (request.method !== 'GET') {
          sendJson(response, 405, { error: 'method_not_allowed' });
          return;
        }

        if (pathname === '/health' || pathname === '/api/v1/health') {
          sendJson(response, 200, {
            status: databaseConnected ? 'ok' : 'degraded',
            service: 'astrabi-api',
            database: databaseConnected ? 'connected' : 'unavailable',
          });
          return;
        }

        if (pathname === '/api/v1/status') {
          sendJson(response, 200, {
            name: 'AstraBI',
            version: '0.1.0',
            environment: process.env.NODE_ENV ?? 'development',
            status: databaseConnected ? 'operational' : 'degraded',
            database: databaseConnected ? 'connected' : 'unavailable',
            checkedAt: new Date().toISOString(),
          });
          return;
        }

        if (pathname === '/api/v1/users') {
          if (!databaseConnected) {
            sendJson(response, 503, {
              error: 'database_unavailable',
              message: 'PostgreSQL is not reachable yet.',
            });
            return;
          }

          const users = await db.user.findMany({
            select: {
              id: true,
              email: true,
              name: true,
              role: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'asc' },
          });

          sendJson(response, 200, {
            total: users.length,
            data: users,
          });
          return;
        }

        sendJson(response, 404, { error: 'not_found' });
      } catch (error) {
        console.error('API request failed:', error);
        sendJson(response, 500, {
          error: 'internal_server_error',
          message: 'AstraBI API hit an unexpected failure.',
        });
      }
    })();
  });
}

export function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
}
