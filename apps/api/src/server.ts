import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createDatabaseClient, ensureDatabaseConnected } from '@astrabi/prisma';
import {
  clearSessionCookie,
  createSessionToken,
  hashPassword,
  hasRole,
  readSessionCookie,
  setSessionCookie,
  verifyPassword,
  verifySessionToken,
} from './auth.js';
import type { SessionUser, UserRole } from './auth.js';

const db = createDatabaseClient();
const allowedOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
let databaseConnected = false;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const validRoles = new Set<UserRole>(['ADMIN', 'ANALYST', 'VIEWER']);

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(JSON.stringify(body));
}

function setCors(request: IncomingMessage, response: ServerResponse): void {
  if (request.headers.origin === allowedOrigin) {
    response.setHeader('access-control-allow-origin', allowedOrigin);
    response.setHeader('access-control-allow-credentials', 'true');
    response.setHeader('vary', 'Origin');
  }
  response.setHeader('access-control-allow-methods', 'GET, POST, PATCH, OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type');
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 16_384) throw new Error('request_too_large');
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function currentUser(request: IncomingMessage): Promise<SessionUser | null> {
  const token = readSessionCookie(request);
  if (!token) return null;
  const id = await verifySessionToken(token);
  if (!id) return null;
  const user = await db.user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true, role: true, isActive: true },
  });
  if (!user || !user.isActive) return null;
  return { id: user.id, email: user.email, name: user.name, role: user.role as UserRole };
}

function originIsAllowed(request: IncomingMessage): boolean {
  return request.headers.origin === allowedOrigin;
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return false;
  }
  entry.count += 1;
  return entry.count > 10;
}

async function writeAudit(actor: SessionUser, action: string, details: object): Promise<void> {
  await db.auditLog.create({
    data: {
      actor: actor.email,
      action,
      userId: actor.id,
      details,
    },
  });
}

export async function initializeDatabase(): Promise<boolean> {
  databaseConnected = await ensureDatabaseConnected(db);
  if (!databaseConnected) return false;

  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (email && password) {
    if (password.length < 12) throw new Error('ADMIN_PASSWORD must contain at least 12 characters.');
    const existing = await db.user.findUnique({ where: { email } });
    if (!existing) {
      await db.user.create({
        data: {
          email,
          name: 'Platform Admin',
          role: 'ADMIN',
          passwordHash: await hashPassword(password),
        },
      });
      console.info(`Bootstrap administrator created for ${email}`);
    }
  } else {
    console.warn('ADMIN_EMAIL/ADMIN_PASSWORD are unset; no bootstrap administrator was created.');
  }
  return true;
}

export function createApiServer(): Server {
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
        const method = request.method ?? 'GET';

        if (pathname === '/health' || pathname === '/api/v1/health') {
          sendJson(response, 200, {
            status: databaseConnected ? 'ok' : 'degraded',
            service: 'astrabi-api',
            database: databaseConnected ? 'connected' : 'unavailable',
          });
          return;
        }

        if (pathname === '/api/v1/status' && method === 'GET') {
          sendJson(response, 200, {
            name: 'AstraBI', version: '0.1.0',
            environment: process.env.NODE_ENV ?? 'development',
            status: databaseConnected ? 'operational' : 'degraded',
            database: databaseConnected ? 'connected' : 'unavailable',
            checkedAt: new Date().toISOString(),
          });
          return;
        }

        if (!databaseConnected) {
          sendJson(response, 503, { error: 'database_unavailable' });
          return;
        }

        if (pathname.startsWith('/api/v1/auth/') && ['POST', 'PATCH'].includes(method) && !originIsAllowed(request)) {
          sendJson(response, 403, { error: 'origin_not_allowed' });
          return;
        }

        if (pathname === '/api/v1/auth/login' && method === 'POST') {
          const ip = request.socket.remoteAddress ?? 'unknown';
          if (rateLimited(ip)) {
            sendJson(response, 429, { error: 'too_many_attempts', message: 'Try again in 15 minutes.' });
            return;
          }
          if (!String(request.headers['content-type'] ?? '').includes('application/json')) {
            sendJson(response, 415, { error: 'application_json_required' });
            return;
          }
          const input = await readJson(request);
          const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
          const password = typeof input?.password === 'string' ? input.password : '';
          if (!email || !password || email.length > 254 || password.length > 1024) {
            sendJson(response, 400, { error: 'invalid_credentials' });
            return;
          }
          const user = await db.user.findUnique({ where: { email } });
          const valid = user?.isActive && user.passwordHash
            ? await verifyPassword(password, user.passwordHash)
            : false;
          if (!valid || !user) {
            sendJson(response, 401, { error: 'invalid_credentials' });
            return;
          }
          loginAttempts.delete(ip);
          const sessionUser: SessionUser = {
            id: user.id, email: user.email, name: user.name, role: user.role as UserRole,
          };
          setSessionCookie(response, await createSessionToken(sessionUser));
          sendJson(response, 200, { user: sessionUser });
          return;
        }

        if (pathname === '/api/v1/auth/logout' && method === 'POST') {
          clearSessionCookie(response);
          sendJson(response, 200, { ok: true });
          return;
        }

        if (pathname === '/api/v1/auth/session' && method === 'GET') {
          const user = await currentUser(request);
          if (!user) {
            sendJson(response, 401, { error: 'unauthenticated' });
            return;
          }
          sendJson(response, 200, { user });
          return;
        }

        if (pathname === '/api/v1/admin/users' && method === 'GET') {
          const actor = await currentUser(request);
          if (!actor) { sendJson(response, 401, { error: 'unauthenticated' }); return; }
          if (!hasRole(actor, ['ADMIN'])) { sendJson(response, 403, { error: 'forbidden' }); return; }
          const users = await db.user.findMany({
            select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
          });
          sendJson(response, 200, { total: users.length, data: users });
          return;
        }

        const userMatch = pathname.match(/^\/api\/v1\/admin\/users\/([^/]+)$/);
        if (userMatch && method === 'PATCH') {
          const actor = await currentUser(request);
          if (!actor) { sendJson(response, 401, { error: 'unauthenticated' }); return; }
          if (!hasRole(actor, ['ADMIN'])) { sendJson(response, 403, { error: 'forbidden' }); return; }
          if (!String(request.headers['content-type'] ?? '').includes('application/json')) {
            sendJson(response, 415, { error: 'application_json_required' }); return;
          }
          const input = await readJson(request);
          const targetId = decodeURIComponent(userMatch[1]);
          const target = await db.user.findUnique({ where: { id: targetId } });
          if (!target) { sendJson(response, 404, { error: 'user_not_found' }); return; }
          const data: { role?: UserRole; isActive?: boolean } = {};
          if (input && Object.hasOwn(input, 'role')) {
            if (typeof input.role !== 'string' || !validRoles.has(input.role as UserRole)) {
              sendJson(response, 400, { error: 'invalid_role' }); return;
            }
            data.role = input.role as UserRole;
          }
          if (input && Object.hasOwn(input, 'isActive')) {
            if (typeof input.isActive !== 'boolean') {
              sendJson(response, 400, { error: 'invalid_is_active' }); return;
            }
            data.isActive = input.isActive;
          }
          if (Object.keys(data).length === 0) { sendJson(response, 400, { error: 'empty_update' }); return; }
          if (targetId === actor.id && (data.role && data.role !== 'ADMIN' || data.isActive === false)) {
            sendJson(response, 400, { error: 'cannot_remove_own_admin_access' }); return;
          }
          const updated = await db.user.update({
            where: { id: targetId }, data,
            select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true },
          });
          await writeAudit(actor, 'user.updated', { userId: targetId, changes: data });
          sendJson(response, 200, { user: updated });
          return;
        }

        if (pathname === '/api/v1/admin/audit' && method === 'GET') {
          const actor = await currentUser(request);
          if (!actor) { sendJson(response, 401, { error: 'unauthenticated' }); return; }
          if (!hasRole(actor, ['ADMIN'])) { sendJson(response, 403, { error: 'forbidden' }); return; }
          const logs = await db.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
          sendJson(response, 200, { total: logs.length, data: logs });
          return;
        }

        sendJson(response, 404, { error: 'not_found' });
      } catch (error) {
        if (error instanceof Error && error.message === 'request_too_large') {
          sendJson(response, 413, { error: 'request_too_large' });
          return;
        }
        console.error('API request failed:', error);
        sendJson(response, 500, { error: 'internal_server_error' });
      }
    })();
  });
}

export function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => { server.off('error', reject); resolve(); });
  });
}

export async function closeDatabase(): Promise<void> {
  await db.$disconnect();
}
