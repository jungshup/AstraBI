import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { SignJWT } from 'jose';
import { createDatabaseClient, ensureDatabaseConnected, seedBaseData } from '@astrabi/prisma';
import { hashPassword } from './auth.js';
import type { Server } from 'node:http';

const testDatabaseUrl = process.env.ASTRABI_TEST_DATABASE_URL;
const integrationTest = testDatabaseUrl ? test : test.skip;
const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const adminEmail = `admin-${unique}@example.test`;
const memberEmail = `member-${unique}@example.test`;
const adminPassword = 'integration-admin-password-123';
const memberPassword = 'integration-member-password-123';
const sessionSecret = 'integration-test-secret-more-than-32-bytes-long';

let server: Server | undefined;
let baseUrl = '';
let prisma: ReturnType<typeof createDatabaseClient> | undefined;
let api: typeof import('./server.js');
let adminId = '';
let memberId = '';

// The API module creates its Prisma client at import time; configure the test DB first.
if (testDatabaseUrl) {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.ADMIN_EMAIL = adminEmail;
  process.env.ADMIN_PASSWORD = adminPassword;
  process.env.SESSION_SECRET = sessionSecret;
}
api = await import('./server.js');

function getPrisma(): ReturnType<typeof createDatabaseClient> {
  if (!prisma) throw new Error('Integration database is not initialized');
  return prisma;
}

async function login(email: string, password: string): Promise<{ response: Response; cookie: string | null }> {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? null };
}

before(async () => {
  if (!testDatabaseUrl) return;

  prisma = createDatabaseClient(testDatabaseUrl);
  assert.equal(await ensureDatabaseConnected(getPrisma()), true);
  assert.equal(await api.initializeDatabase(), true);
  await seedBaseData(getPrisma());

  const db = getPrisma();
  const [flag, dashboard, seededReports] = await Promise.all([
    db.featureFlag.findUnique({ where: { key: 'dashboard-v2' } }),
    db.dashboard.findFirst({ where: { isDefault: true }, include: { widgets: true } }),
    db.report.count({ where: { createdBy: 'system-seed' } }),
  ]);
  assert.ok(flag, 'feature flag seed should exist');
  assert.ok(dashboard, 'default dashboard seed should exist');
  assert.ok(dashboard.widgets.length > 0, 'dashboard seed should include widgets');
  assert.ok(seededReports >= 2, 'report seeds should exist');

  const countsBefore = {
    flags: await db.featureFlag.count({ where: { key: 'dashboard-v2' } }),
    dashboards: await db.dashboard.count({ where: { isDefault: true } }),
    reports: await db.report.count({ where: { createdBy: 'system-seed' } }),
  };
  await seedBaseData(db);
  assert.deepEqual({
    flags: await db.featureFlag.count({ where: { key: 'dashboard-v2' } }),
    dashboards: await db.dashboard.count({ where: { isDefault: true } }),
    reports: await db.report.count({ where: { createdBy: 'system-seed' } }),
  }, countsBefore, 're-running seed should not duplicate base records');

  const admin = await db.user.findUniqueOrThrow({ where: { email: adminEmail } });
  adminId = admin.id;
  const member = await db.user.create({
    data: {
      email: memberEmail,
      name: 'Integration Member',
      role: 'ANALYST',
      passwordHash: await hashPassword(memberPassword),
    },
  });
  memberId = member.id;

  server = api.createApiServer();
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', () => {
      server!.off('error', reject);
      const address = server!.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not read test server address'));
        return;
      }
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

after(async () => {
  if (!testDatabaseUrl || !prisma) return;
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  }
  await prisma.auditLog.deleteMany({ where: { userId: { in: [adminId, memberId].filter(Boolean) } } });
  await prisma.user.deleteMany({ where: { email: { in: [adminEmail, memberEmail] } } });
  await prisma.$disconnect();
  await api.closeDatabase();
});

integrationTest('Prisma connects, seeds idempotently, and provisions configured admin credentials', async () => {
  const admin = await getPrisma().user.findUnique({ where: { email: adminEmail } });
  assert.ok(admin);
  assert.equal(admin.role, 'ADMIN');
  assert.equal(await getPrisma().user.count({ where: { email: adminEmail } }), 1);
});

integrationTest('login succeeds with valid credentials and rejects invalid credentials', async () => {
  const success = await login(memberEmail.toUpperCase(), memberPassword);
  assert.equal(success.response.status, 200);
  const payload = await success.response.json();
  assert.equal(payload.user.email, memberEmail);
  assert.equal(payload.user.role, 'ANALYST');
  assert.ok(success.cookie);
  assert.ok(success.response.headers.get('set-cookie')?.includes('HttpOnly'));
  assert.ok(success.response.headers.get('set-cookie')?.includes('SameSite=Lax'));

  const wrongPassword = await login(memberEmail, 'incorrect-password');
  assert.equal(wrongPassword.response.status, 401);
  assert.deepEqual(await wrongPassword.response.json(), { error: 'invalid_credentials' });

  const unknownAccount = await login(`missing-${unique}@example.test`, memberPassword);
  assert.equal(unknownAccount.response.status, 401);

  const missingFields = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: memberEmail }),
  });
  assert.equal(missingFields.status, 400);
});

integrationTest('admin routes deny anonymous/viewer access; admin may demote another user and the change is audited', async () => {
  const anonymousResponse = await fetch(`${baseUrl}/api/v1/admin/users`);
  assert.equal(anonymousResponse.status, 401);

  const memberLogin = await login(memberEmail, memberPassword);
  assert.equal(memberLogin.response.status, 200);
  assert.ok(memberLogin.cookie);

  const viewerListResponse = await fetch(`${baseUrl}/api/v1/admin/users`, {
    headers: { cookie: memberLogin.cookie! },
  });
  assert.equal(viewerListResponse.status, 403);

  const forbiddenDemotion = await fetch(`${baseUrl}/api/v1/admin/users/${encodeURIComponent(memberId)}`, {
    method: 'PATCH',
    headers: { cookie: memberLogin.cookie!, 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'VIEWER' }),
  });
  assert.equal(forbiddenDemotion.status, 403, 'non-admin users cannot change roles');

  const adminLogin = await login(adminEmail, adminPassword);
  assert.equal(adminLogin.response.status, 200);
  assert.ok(adminLogin.cookie);

  const selfDemotion = await fetch(`${baseUrl}/api/v1/admin/users/${encodeURIComponent(adminId)}`, {
    method: 'PATCH',
    headers: { cookie: adminLogin.cookie!, 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'VIEWER' }),
  });
  assert.equal(selfDemotion.status, 400, 'admin cannot remove their own administrator access');

  const demotion = await fetch(`${baseUrl}/api/v1/admin/users/${encodeURIComponent(memberId)}`, {
    method: 'PATCH',
    headers: { cookie: adminLogin.cookie!, 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'VIEWER' }),
  });
  assert.equal(demotion.status, 200, 'administrator may demote a different user');
  assert.equal((await demotion.json()).user.role, 'VIEWER');

  const audit = await getPrisma().auditLog.findFirst({
    where: { userId: adminId, action: 'user.updated' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(audit, 'role change should create an audit log');
  assert.equal(audit.actor, adminEmail);
  assert.deepEqual(audit.details, { userId: memberId, changes: { role: 'VIEWER' } });
});

integrationTest('expired token and deactivated account sessions are rejected', async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiredToken = await new SignJWT({ email: memberEmail })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(memberId)
    .setIssuer('astrabi-api')
    .setAudience('astrabi-web')
    .setIssuedAt(nowSeconds - 120)
    .setExpirationTime(nowSeconds - 60)
    .sign(new TextEncoder().encode(sessionSecret));

  const expiredSession = await fetch(`${baseUrl}/api/v1/auth/session`, {
    headers: { cookie: `astrabi_session=${expiredToken}` },
  });
  assert.equal(expiredSession.status, 401);
  assert.deepEqual(await expiredSession.json(), { error: 'unauthenticated' });

  const memberLogin = await login(memberEmail, memberPassword);
  assert.equal(memberLogin.response.status, 200);
  assert.ok(memberLogin.cookie);
  const validSession = await fetch(`${baseUrl}/api/v1/auth/session`, {
    headers: { cookie: memberLogin.cookie! },
  });
  assert.equal(validSession.status, 200);

  const adminLogin = await login(adminEmail, adminPassword);
  assert.ok(adminLogin.cookie);
  const deactivate = await fetch(`${baseUrl}/api/v1/admin/users/${encodeURIComponent(memberId)}`, {
    method: 'PATCH',
    headers: { cookie: adminLogin.cookie!, 'content-type': 'application/json' },
    body: JSON.stringify({ isActive: false }),
  });
  assert.equal(deactivate.status, 200);

  const revokedSession = await fetch(`${baseUrl}/api/v1/auth/session`, {
    headers: { cookie: memberLogin.cookie! },
  });
  assert.equal(revokedSession.status, 401, 'inactive users must lose access even with an unexpired token');
});
