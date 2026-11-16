import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createDatabaseClient, ensureDatabaseConnected, seedBaseData } from '@astrabi/prisma';
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
const validRoles = new Set<UserRole>(['ADMIN', 'ANALYST', 'VIEWER']);

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
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
  for await (const chunk of request) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(next);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function currentUser(request: IncomingMessage): Promise<SessionUser | null> {
  const token = readSessionCookie(request);
  if (!token) return null;
  const userId = await verifySessionToken(token);
  if (!userId) return null;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true, isActive: true },
  });
  if (!user || !user.isActive) return null;
  return { id: user.id, email: user.email, name: user.name, role: user.role as UserRole };
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
  if (databaseConnected) {
    await seedBaseData(db);
  }
  return databaseConnected;
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
            name: 'AstraBI',
            version: '0.1.0',
            environment: process.env.NODE_ENV ?? 'development',
            status: databaseConnected ? 'operational' : 'degraded',
            database: databaseConnected ? 'connected' : 'unavailable',
            checkedAt: new Date().toISOString(),
          });
          return;
        }

        if (pathname === '/api/v1/auth/login' && method === 'POST') {
          const body = await readJson(request);
          const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
          const password = typeof body?.password === 'string' ? body.password : '';
          if (!email || !password) {
            sendJson(response, 400, { error: 'invalid_credentials' });
            return;
          }

          const user = await db.user.findUnique({ where: { email } });
          if (!user || !user.isActive) {
            sendJson(response, 401, { error: 'invalid_credentials' });
            return;
          }

          const valid = await verifyPassword(password, user.passwordHash);
          if (!valid) {
            sendJson(response, 401, { error: 'invalid_credentials' });
            return;
          }

          const sessionUser: SessionUser = {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role as UserRole,
          };

          setSessionCookie(response, await createSessionToken(sessionUser));
          sendJson(response, 200, { user: sessionUser });
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

        if (pathname === '/api/v1/auth/logout' && method === 'POST') {
          clearSessionCookie(response);
          sendJson(response, 200, { ok: true });
          return;
        }

        if (!databaseConnected) {
          sendJson(response, 503, { error: 'database_unavailable' });
          return;
        }

        if (pathname === '/api/v1/admin/feature-flags' && method === 'GET') {
          const actor = await currentUser(request);
          if (!actor) { sendJson(response, 401, { error: 'unauthenticated' }); return; }
          if (!hasRole(actor, ['ADMIN'])) { sendJson(response, 403, { error: 'forbidden' }); return; }

          const flags = await db.featureFlag.findMany({ orderBy: { createdAt: 'asc' } });
          sendJson(response, 200, { total: flags.length, data: flags });
          return;
        }

        if (pathname.match(/^\/api\/v1\/admin\/feature-flags\/([^/]+)$/) && method === 'PATCH') {
          const actor = await currentUser(request);
          if (!actor) { sendJson(response, 401, { error: 'unauthenticated' }); return; }
          if (!hasRole(actor, ['ADMIN'])) { sendJson(response, 403, { error: 'forbidden' }); return; }

          const key = decodeURIComponent(pathname.split('/').at(-1) ?? '');
          const body = await readJson(request);
          const update = await db.featureFlag.update({
            where: { key },
            data: {
              enabled: typeof body?.enabled === 'boolean' ? body.enabled : undefined,
              description: typeof body?.description === 'string' ? body.description : undefined,
            },
          });

          await writeAudit(actor, 'feature_flag.updated', { key, enabled: update.enabled, description: update.description });
          sendJson(response, 200, { featureFlag: update });
          return;
        }

        if (pathname === '/api/v1/dashboard' && method === 'GET') {
          const actor = await currentUser(request);
          if (!actor) { sendJson(response, 401, { error: 'unauthenticated' }); return; }
          if (!hasRole(actor, ['ADMIN', 'ANALYST'])) { sendJson(response, 403, { error: 'forbidden' }); return; }

          const dashboard = await db.dashboard.findFirst({
            where: { isDefault: true },
            include: { widgets: true },
          });

          sendJson(response, 200, {
            name: dashboard?.name ?? 'No Dashboard',
            description: dashboard?.description ?? null,
            widgets: dashboard?.widgets ?? [],
          });
          return;
        }

        if (pathname === '/api/v1/reports' && method === 'GET') {
          const actor = await currentUser(request);
          if (!actor) { sendJson(response, 401, { error: 'unauthenticated' }); return; }
          if (!hasRole(actor, ['ADMIN', 'ANALYST'])) { sendJson(response, 403, { error: 'forbidden' }); return; }

          const reports = await db.report.findMany({ orderBy: { createdAt: 'desc' } });
          sendJson(response, 200, { total: reports.length, data: reports });
          return;
        }

        if (pathname === '/api/v1/reports' && method === 'POST') {
          const actor = await currentUser(request);
          if (!actor) { sendJson(response, 401, { error: 'unauthenticated' }); return; }
          if (!hasRole(actor, ['ADMIN', 'ANALYST'])) { sendJson(response, 403, { error: 'forbidden' }); return; }

          const body = await readJson(request);
          const title = typeof body?.title === 'string' ? body.title.trim() : '';
          if (!title) {
            sendJson(response, 400, { error: 'invalid_report_title' });
            return;
          }

          const created = await db.report.create({
            data: {
              title,
              description: typeof body?.description === 'string' ? body.description : null,
              status: typeof body?.status === 'string' ? body.status : 'draft',
              template: typeof body?.template === 'string' ? body.template : 'table',
              createdBy: actor.email,
            },
          });

          await writeAudit(actor, 'report.created', { reportId: created.id, title });
          sendJson(response, 200, { report: created });
          return;
        }

        if (pathname === '/api/v1/admin/users' && method === 'GET') {
          const actor = await currentUser(request);
          if (!actor) { sendJson(response, 401, { error: 'unauthenticated' }); return; }
          if (!hasRole(actor, ['ADMIN'])) { sendJson(response, 403, { error: 'forbidden' }); return; }

          const users = await db.user.findMany({
            orderBy: { createdAt: 'asc' },
            select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true },
          });

          sendJson(response, 200, { total: users.length, data: users });
          return;
        }

        if (pathname.match(/^\/api\/v1\/admin\/users\/([^/]+)$/) && method === 'PATCH') {
          const actor = await currentUser(request);
          if (!actor) { sendJson(response, 401, { error: 'unauthenticated' }); return; }
          if (!hasRole(actor, ['ADMIN'])) { sendJson(response, 403, { error: 'forbidden' }); return; }

          const targetId = decodeURIComponent(pathname.split('/').at(-1) ?? '');
          const target = await db.user.findUnique({ where: { id: targetId } });
          if (!target) { sendJson(response, 404, { error: 'user_not_found' }); return; }

          const body = await readJson(request);
          const data: { role?: UserRole; isActive?: boolean } = {};
          if (body && Object.hasOwn(body, 'role')) {
            if (typeof body.role !== 'string' || !validRoles.has(body.role as UserRole)) {
              sendJson(response, 400, { error: 'invalid_role' });
              return;
            }
            data.role = body.role as UserRole;
          }
          if (body && Object.hasOwn(body, 'isActive')) {
            if (typeof body.isActive !== 'boolean') {
              sendJson(response, 400, { error: 'invalid_is_active' });
              return;
            }
            data.isActive = body.isActive;
          }

          if (Object.keys(data).length === 0) {
            sendJson(response, 400, { error: 'empty_update' });
            return;
          }

          if ((data.role === 'VIEWER' || data.isActive === false) && targetId === actor.id) {
            sendJson(response, 400, { error: 'cannot_remove_own_admin_access' });
            return;
          }

          const updated = await db.user.update({
            where: { id: targetId },
            data,
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
        console.error('API error:', error);
        sendJson(response, 500, { error: 'internal_server_error' });
      }
    })();
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

export async function closeDatabase(): Promise<void> {
  await db.$disconnect();
}
