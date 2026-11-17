import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApiServer, initializeDatabase, closeDatabase } from './server.js';
import { createDatabaseClient, ensureDatabaseConnected, seedBaseData } from '@astrabi/prisma';
import { hashPassword } from './auth.js';

const testDatabaseUrl = process.env.ASTRABI_TEST_DATABASE_URL;
const integrationTest = testDatabaseUrl ? test : test.skip;
const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const adminEmail = `admin-${unique}@example.test`;
const memberEmail = `member-${unique}@example.test`;
const adminPassword = 'integration-admin-password-123';
const memberPassword = 'integration-member-password-123';

let server: ReturnType<typeof createApiServer>;
let baseUrl: string;
let prisma: ReturnType<typeof createDatabaseClient>;
let adminId: string;
let memberId: string;

if (testDatabaseUrl) {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.ADMIN_EMAIL = adminEmail;
  process.env.ADMIN_PASSWORD = adminPassword;
  process.env.SESSION_SECRET = 'integration-test-secret-more-than-32-bytes-long';
}

const api = await import('./server.js');

before(async () => {
  if (!testDatabaseUrl) return;
  // DATABASE_URL must be supplied before importing the API server module.
  // This guard fails clearly if an importing test runner loaded the API first.
  assert.equal(process.env.DATABASE_URL, testDatabaseUrl);
  prisma = createDatabaseClient(testDatabaseUrl);
  assert.equal(await ensureDatabaseConnected(prisma), true);
  assert.equal(await api.initializeDatabase(), true);
  await seedBaseData(prisma);

  const [flag, dashboard, seededReports] = await Promise.all([
    prisma.featureFlag.findUnique({ where: { key: 'dashboard-v2' } }),
    prisma.dashboard.findFirst({ where: { isDefault: true }, include: { widgets: true } }),
    prisma.report.count({ where: { createdBy: 'system-seed' } }),
  ]);
  assert.ok(flag, 'feature flag seed should exist');
  assert.ok(dashboard, 'default dashboard seed should exist');
  assert.ok(dashboard.widgets.length > 0, 'dashboard seed should include widgets');
  assert.ok(seededReports >= 2, 'report seeds should exist');

  const seedCountsBefore = {
    flags: await prisma.featureFlag.count({ where: { key: 'dashboard-v2' } }),
    dashboards: await prisma.dashboard.count({ where: { isDefault: true } }),
    reports: await prisma.report.count({ where: { createdBy: 'system-seed' } }),
  };
  await seedBaseData(prisma);
  assert.deepEqual({
    flags: await prisma.featureFlag.count({ where: { key: 'dashboard-v2' } }),
    dashboards: await prisma.dashboard.count({ where: { isDefault: true } }),
    reports: await prisma.report.count({ where: { createdBy: 'system-seed' } }),
  }, seedCountsBefore, 'running the seed repeatedly should not duplicate base records');

  const admin = await prisma.user.findUniqueOrThrow({ where: { email: adminEmail } });
  adminId = admin.id;
  const member = await prisma.user.create({
    data: {
      email: memberEmail,
      name: 'Integration Member',
      role: 'VIEWER',
      passwordHash: await hashPassword(memberPassword),
    },
  });
  memberId = member.id;

  server = api.createApiServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Could not read test server address'));
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

after(async () => {
  if (!testDatabaseUrl) return;
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  await prisma.auditLog.deleteMany({ where: { userId: { in: [adminId, memberId].filter(Boolean) } } });
  await prisma.user.deleteMany({ where: { email: { in: [adminEmail, memberEmail] } } });
  await prisma.$disconnect();
  await api.closeDatabase();
});

integrationTest('Prisma connects, seeds idempotently, and provisions only configured admin credentials', async () => {
  assert.ok(testDatabaseUrl);
  assert.ok(await prisma.user.findUnique({ where: { email: adminEmail } }));
});

integrationTest('login succeeds with valid credentials and rejects invalid credentials', async () => {
  const success = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: memberEmail.toUpperCase(), password: memberPassword }),
  });
  assert.equal(success.status, 200);
  const payload = await success.json();
  assert.equal(payload.user.email, memberEmail);
  assert.equal(payload.user.role, 'VIEWER');
  const cookie = success.headers.get('set-cookie');
  assert.ok(cookie?.includes('HttpOnly'));
  assert.ok(cookie?.includes('SameSite=Lax'));

  const wrongPassword = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: memberEmail, password: 'incorrect-password' }),
  });
  assert.equal(wrongPassword.status, 401);
  assert.deepEqual(await wrongPassword.json(), { error: 'invalid_credentials' });

  const unknownAccount = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `missing-${unique}@example.test`, password: memberPassword }),
  });
  assert.equal(unknownAccount.status, 401);

  const missingFields = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: memberEmail }),
  });
  assert.equal(missingFields.status, 400);
});

integrationTest('admin routes reject anonymous and viewer users, but allow an administrator', async () => {
  const anonymousResponse = await fetch(`${baseUrl}/api/v1/admin/users`);
  assert.equal(anonymousResponse.status, 401);

  const memberLogin = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: memberEmail, password: memberPassword }),
  });
  const memberCookie = memberLogin.headers.get('set-cookie')?.split(';')[0];
  assert.ok(memberCookie);
  const viewerResponse = await fetch(`${baseUrl}/api/v1/admin/users`, { headers: { cookie: memberCookie } });
  assert.equal(viewerResponse.status, 403);

  const adminLogin = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  assert.equal(adminLogin.status, 200);
  const adminCookie = adminLogin.headers.get('set-cookie')?.split(';')[0];
  assert.ok(adminCookie);
  const adminResponse = await fetch(`${baseUrl}/api/v1/admin/users`, { headers: { cookie: adminCookie } });
  assert.equal(adminResponse.status, 200);
  const users = await adminResponse.json();
  assert.ok(users.data.some((user: { id: string }) => user.id === memberId));
});
