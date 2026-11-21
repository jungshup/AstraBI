import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { issueAccessToken } from '@astrabi/auth';
import type { PrismaClient } from '@astrabi/prisma';
import { decryptSecret, encryptSecret, hashPassword, rotateSecret } from '@astrabi/security';
import { rotateDataSourceEncryptionKey } from './rotate-encryption-key.js';
import {
  refreshPostgresDatasetAndRecordStatus,
} from './dataset-refresh.js';
import { createServer, type ServerConfig } from './server.js';

const databaseUrl = process.env.ASTRABI_TEST_DATABASE_URL;
const secret = 'integration-test-secret-that-is-long-enough';
const config: ServerConfig = {
  PORT: 4000,
  DATABASE_URL: databaseUrl ?? 'postgresql://localhost/unused',
  JWT_SECRET: secret,
  ASTRABI_DATA_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ASTRABI_POSTGRES_HOST_ALLOWLIST: ['localhost'],
  WEB_ORIGIN: 'http://localhost:3000',
};
const tenantId = randomUUID();
const otherTenantId = randomUUID();
const adminId = randomUUID();
const memberId = randomUUID();
const otherTenantUserId = randomUUID();
const adminEmail = `admin-${randomUUID()}@astrabi.test`;
const memberEmail = `member-${randomUUID()}@astrabi.test`;
let app: Awaited<ReturnType<typeof createServer>> | undefined;
let prisma: PrismaClient | undefined;
let adminToken = '';
let memberToken = '';

test('data source encryption protects stored credentials', () => {
  const key = config.ASTRABI_DATA_ENCRYPTION_KEY;
  const encrypted = encryptSecret('postgres-password', key);
  assert.notEqual(encrypted.ciphertext, 'postgres-password');
  assert.equal(decryptSecret(encrypted, key), 'postgres-password');
  assert.throws(() => decryptSecret({ ...encrypted, authTag: 'invalid' }, key));

  const replacementKey = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
  const rotated = rotateSecret(encrypted, key, replacementKey);
  assert.equal(decryptSecret(rotated, replacementKey), 'postgres-password');
  assert.throws(() => decryptSecret(rotated, key));
});

before(async () => {
  process.env.DATABASE_URL = databaseUrl ?? config.DATABASE_URL;
  ({ prisma } = await import('@astrabi/prisma'));
  app = await createServer({ prisma: prisma!, config });
  if (!databaseUrl) return;

  await prisma!.tenant.create({ data: { id: tenantId, name: 'Integration test tenant' } });
  await prisma!.tenant.create({ data: { id: otherTenantId, name: 'Other integration tenant' } });
  const passwordHash = await hashPassword('test-password-1234');
  await prisma!.user.createMany({
    data: [
      {
        id: adminId,
        tenantId,
        email: adminEmail,
        displayName: 'Temporary Administrator',
        passwordHash,
        role: 'ADMIN',
      },
      {
        id: memberId,
        tenantId,
        email: memberEmail,
        displayName: 'Temporary Member',
        passwordHash,
        role: 'MEMBER',
      },
      {
        id: otherTenantUserId,
        tenantId: otherTenantId,
        email: `member-${randomUUID()}@astrabi.test`,
        displayName: 'Other Tenant Member',
        passwordHash,
        role: 'MEMBER',
      },
    ],
  });
});

after(async () => {
  await app?.close();
  if (prisma) {
    if (databaseUrl) {
      await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
    }
    await prisma.$disconnect();
  }
});

test('health endpoint responds without depending on database readiness', async () => {
  const response = await app!.inject({ method: 'GET', url: '/healthz' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
});

test('login, role changes, tenant scoping, and disabling invalidate active sessions', {
  skip: !databaseUrl,
}, async () => {
  const adminLogin = await app!.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { tenantId, email: adminEmail, password: 'test-password-1234' },
  });
  assert.equal(adminLogin.statusCode, 200);
  adminToken = adminLogin.json<{ token: string }>().token;

  const memberLogin = await app!.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { tenantId, email: memberEmail, password: 'test-password-1234' },
  });
  assert.equal(memberLogin.statusCode, 200);
  memberToken = memberLogin.json<{ token: string }>().token;

  const forbidden = await app!.inject({
    method: 'GET',
    url: '/users',
    headers: { authorization: `Bearer ${memberToken}` },
  });
  assert.equal(forbidden.statusCode, 403);

  const memberQuery = await app!.inject({
    method: 'POST',
    url: '/analytics/query',
    headers: { authorization: `Bearer ${memberToken}` },
    payload: { mode: 'sql', datasetIds: [], sql: 'SELECT 1' },
  });
  assert.equal(memberQuery.statusCode, 403);
  const memberDashboardWrite = await app!.inject({
    method: 'POST',
    url: '/dashboards',
    headers: { authorization: `Bearer ${memberToken}` },
    payload: { name: 'Member dashboard' },
  });
  assert.equal(memberDashboardWrite.statusCode, 403);
  const memberDashboardRead = await app!.inject({
    method: 'GET',
    url: '/dashboards',
    headers: { authorization: `Bearer ${memberToken}` },
  });
  assert.equal(memberDashboardRead.statusCode, 200);

  const created = await app!.inject({
    method: 'POST',
    url: '/users',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      email: `analyst-${randomUUID()}@astrabi.test`,
      displayName: 'New Analyst',
      password: 'another-test-password',
    },
  });
  assert.equal(created.statusCode, 201);
  const createdUser = created.json<{ id: string; passwordHash?: string }>();
  assert.equal('passwordHash' in createdUser, false);
  const creationAudit = await prisma!.auditLog.findFirst({
    where: { tenantId, actorId: adminId, targetId: createdUser.id, action: 'user.created' },
  });
  assert.ok(creationAudit);

  const roleChange = await app!.inject({
    method: 'PATCH',
    url: `/users/${memberId}/role`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { role: 'ADMIN' },
  });
  assert.equal(roleChange.statusCode, 200);
  assert.equal(roleChange.json<{ role: string }>().role, 'ADMIN');

  const staleSession = await app!.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { authorization: `Bearer ${memberToken}` },
  });
  assert.equal(staleSession.statusCode, 401);

  const crossTenantRoleChange = await app!.inject({
    method: 'PATCH',
    url: `/users/${otherTenantUserId}/role`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { role: 'ADMIN' },
  });
  assert.equal(crossTenantRoleChange.statusCode, 404);

  const audit = await prisma!.auditLog.findFirst({
    where: { tenantId, actorId: adminId, targetId: memberId, action: 'role.changed' },
  });
  assert.deepEqual(audit?.metadata, { from: 'MEMBER', to: 'ADMIN' });

  const promotedLogin = await app!.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { tenantId, email: memberEmail, password: 'test-password-1234' },
  });
  assert.equal(promotedLogin.statusCode, 200);
  memberToken = promotedLogin.json<{ token: string }>().token;

  const disable = await app!.inject({
    method: 'PATCH',
    url: `/users/${memberId}/disable`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(disable.statusCode, 204);

  const oldSession = await app!.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { authorization: `Bearer ${memberToken}` },
  });
  assert.equal(oldSession.statusCode, 401);
});

test('expired JWTs are rejected by protected routes', { skip: !databaseUrl }, async () => {
  const session = await prisma!.session.create({
    data: { tenantId, userId: adminId, expiresAt: new Date(Date.now() + 60_000) },
  });
  const token = await issueAccessToken(
    { subject: adminId, tenantId, role: 'ADMIN', sessionId: session.jwtId },
    secret,
    0,
  );
  const response = await app!.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 401);
});

test('stored PostgreSQL credentials can be rotated transactionally', { skip: !databaseUrl }, async () => {
  const replacementKey = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
  const encrypted = encryptSecret(JSON.stringify({
    host: 'localhost',
    port: 5432,
    database: 'source',
    user: 'reader',
    password: 'source-password',
  }), config.ASTRABI_DATA_ENCRYPTION_KEY);
  const source = await prisma!.dataSource.create({
    data: {
      tenantId,
      name: `rotation-${randomUUID()}`,
      kind: 'POSTGRES',
      encryptedConfig: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.authTag,
    },
  });

  try {
    const rotatedCount = await rotateDataSourceEncryptionKey(
      prisma!,
      config.ASTRABI_DATA_ENCRYPTION_KEY,
      replacementKey,
    );
    assert.ok(rotatedCount >= 1);
    const updated = await prisma!.dataSource.findUniqueOrThrow({ where: { id: source.id } });
    const rotated = {
      ciphertext: updated.encryptedConfig!,
      iv: updated.encryptionIv!,
      authTag: updated.encryptionTag!,
    };
    const plaintext = decryptSecret(rotated, replacementKey);
    assert.equal(JSON.parse(plaintext).password, 'source-password');
    assert.throws(() => decryptSecret(rotated, config.ASTRABI_DATA_ENCRYPTION_KEY));
  } finally {
    await prisma!.dataSource.delete({ where: { id: source.id } });
  }
});

test('PostgreSQL dataset snapshots refresh atomically and retain prior rows on schema removal', {
  skip: !databaseUrl,
}, async () => {
  const encrypted = encryptSecret(JSON.stringify({
    host: 'localhost',
    port: 5432,
    database: 'source',
    user: 'reader',
    password: 'source-password',
  }), config.ASTRABI_DATA_ENCRYPTION_KEY);
  const source = await prisma!.dataSource.create({
    data: {
      tenantId,
      name: `snapshot-${randomUUID()}`,
      kind: 'POSTGRES',
      encryptedConfig: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.authTag,
    },
  });
  const dataset = await prisma!.dataSet.create({
    data: {
      tenantId,
      dataSourceId: source.id,
      name: `sales-${randomUUID()}`,
      sourceSchema: 'public',
      sourceTable: 'sales',
      columns: [
        { key: 'c0', name: 'region', type: 'STRING' },
        { key: 'c1', name: 'amount', type: 'NUMBER' },
      ],
      rowCount: 1,
    },
  });
  await prisma!.dataRow.create({
    data: { tenantId, datasetId: dataset.id, rowIndex: 0, data: ['Old', '7'] },
  });

  try {
    const viewerEmail = `snapshot-viewer-${randomUUID()}@astrabi.test`;
    await prisma!.user.create({
      data: {
        tenantId,
        email: viewerEmail,
        displayName: 'Snapshot Viewer',
        passwordHash: await hashPassword('viewer-password-1234'),
        role: 'MEMBER',
      },
    });
    const viewerLogin = await app!.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { tenantId, email: viewerEmail, password: 'viewer-password-1234' },
    });
    assert.equal(viewerLogin.statusCode, 200);
    const viewerToken = viewerLogin.json<{ token: string }>().token;
    const memberSchedule = await app!.inject({
      method: 'PATCH',
      url: `/datasets/${dataset.id}/refresh-schedule`,
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { intervalMinutes: 15 },
    });
    assert.equal(memberSchedule.statusCode, 403);
    const memberRefresh = await app!.inject({
      method: 'POST',
      url: `/datasets/${dataset.id}/refresh`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    assert.equal(memberRefresh.statusCode, 403);
    const invalidSchedule = await app!.inject({
      method: 'PATCH',
      url: `/datasets/${dataset.id}/refresh-schedule`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { intervalMinutes: 30 },
    });
    assert.equal(invalidSchedule.statusCode, 400);
    const schedule = await app!.inject({
      method: 'PATCH',
      url: `/datasets/${dataset.id}/refresh-schedule`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { intervalMinutes: 15 },
    });
    assert.equal(schedule.statusCode, 204);

    const refreshedRows = await refreshPostgresDatasetAndRecordStatus(
      prisma!,
      tenantId,
      dataset.id,
      config,
      async () => ({
        columns: [
          { key: 'c0', name: 'amount', type: 'NUMBER' },
          { key: 'c1', name: 'region', type: 'STRING' },
          { key: 'c2', name: 'channel', type: 'STRING' },
        ],
        rows: [['12', 'North', 'web'], ['20', 'South', 'store']],
      }),
    );
    assert.equal(refreshedRows, 2);
    const updated = await prisma!.dataSet.findUniqueOrThrow({ where: { id: dataset.id } });
    assert.equal(updated.rowCount, 2);
    assert.equal(updated.lastRefreshError, null);
    assert.ok(updated.lastRefreshedAt);
    assert.ok(updated.nextRefreshAt && updated.nextRefreshAt > new Date());
    assert.deepEqual(updated.columns, [
      { key: 'c1', name: 'amount', type: 'NUMBER' },
      { key: 'c0', name: 'region', type: 'STRING' },
      { key: 'c2', name: 'channel', type: 'STRING' },
    ]);
    const rows = await prisma!.dataRow.findMany({
      where: { tenantId, datasetId: dataset.id },
      orderBy: { rowIndex: 'asc' },
      select: { data: true },
    });
    assert.deepEqual(rows.map(({ data }) => data), [
      ['12', 'North', 'web'],
      ['20', 'South', 'store'],
    ]);

    await assert.rejects(
      refreshPostgresDatasetAndRecordStatus(
        prisma!,
        tenantId,
        dataset.id,
        config,
        async () => ({
          columns: [{ key: 'c0', name: 'region', type: 'STRING' }],
          rows: [['Changed']],
        }),
      ),
      { code: 'source_schema_changed' },
    );
    const afterFailure = await prisma!.dataSet.findUniqueOrThrow({ where: { id: dataset.id } });
    assert.equal(afterFailure.lastRefreshError, 'source_schema_changed');
    const retainedRows = await prisma!.dataRow.findMany({
      where: { tenantId, datasetId: dataset.id },
      orderBy: { rowIndex: 'asc' },
      select: { data: true },
    });
    assert.deepEqual(retainedRows.map(({ data }) => data), [
      ['12', 'North', 'web'],
      ['20', 'South', 'store'],
    ]);
  } finally {
    await prisma!.dataSource.delete({ where: { id: source.id } });
  }
});

test('CSV datasets support visual and read-only SQL queries and saved dashboard panels', {
  skip: !databaseUrl,
}, async () => {
  const boundary = 'astrabi-test-boundary';
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="sales.csv"',
    'Content-Type: text/csv',
    '',
    'region,amount',
    'North,10',
    'South,20',
    'North,5',
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const uploaded = await app!.inject({
    method: 'POST',
    url: '/data-sources/csv',
    headers: {
      authorization: `Bearer ${adminToken}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: body,
  });
  assert.equal(uploaded.statusCode, 201);
  const dataset = uploaded.json<{ dataset: { id: string } }>().dataset;
  const visual = await app!.inject({
    method: 'POST',
    url: '/analytics/query',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      mode: 'visual',
      datasetId: dataset.id,
      dimensions: ['c0'],
      metrics: [{ operation: 'sum', column: 'c1' }],
      filters: [],
      limit: 20,
    },
  });
  assert.equal(visual.statusCode, 200);
  const visualResult = visual.json<{ columns: string[]; rows: unknown[][] }>();
  assert.deepEqual(visualResult.columns, ['c0', 'metric_0']);
  assert.deepEqual(
    visualResult.rows.sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    [['North', 15], ['South', 20]],
  );

  const sqlTable = `ds_${dataset.id.replace(/-/g, '')}`;
  const sql = await app!.inject({
    method: 'POST',
    url: '/analytics/query',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      mode: 'sql',
      datasetIds: [dataset.id],
      sql: `SELECT COUNT(*) AS total FROM ${sqlTable}`,
    },
  });
  assert.equal(sql.statusCode, 200);
  assert.deepEqual(sql.json<{ rows: unknown[][] }>().rows, [['3']]);

  const blockedSql = await app!.inject({
    method: 'POST',
    url: '/analytics/query',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      mode: 'sql',
      datasetIds: [dataset.id],
      sql: `SELECT * FROM users`,
    },
  });
  assert.equal(blockedSql.statusCode, 400);
  const blockedMutation = await app!.inject({
    method: 'POST',
    url: '/analytics/query',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      mode: 'sql',
      datasetIds: [dataset.id],
      sql: `DROP TABLE ${sqlTable}`,
    },
  });
  assert.equal(blockedMutation.statusCode, 400);

  const foreignSource = await prisma!.dataSource.create({
    data: { tenantId: otherTenantId, name: `foreign-${randomUUID()}`, kind: 'CSV' },
  });
  const foreignDataset = await prisma!.dataSet.create({
    data: {
      tenantId: otherTenantId,
      dataSourceId: foreignSource.id,
      name: 'foreign-data',
      columns: [{ key: 'c0', name: 'secret', type: 'STRING' }],
      rowCount: 1,
    },
  });
  await prisma!.dataRow.create({
    data: {
      tenantId: otherTenantId,
      datasetId: foreignDataset.id,
      rowIndex: 0,
      data: ['not-for-this-tenant'],
    },
  });
  const crossTenantQuery = await app!.inject({
    method: 'POST',
    url: '/analytics/query',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      mode: 'sql',
      datasetIds: [foreignDataset.id],
      sql: `SELECT * FROM ds_${foreignDataset.id.replace(/-/g, '')}`,
    },
  });
  assert.equal(crossTenantQuery.statusCode, 404);

  const dashboard = await app!.inject({
    method: 'POST',
    url: '/dashboards',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: `Sales ${randomUUID()}` },
  });
  assert.equal(dashboard.statusCode, 201);
  const dashboardId = dashboard.json<{ id: string }>().id;
  const panel = await app!.inject({
    method: 'POST',
    url: `/dashboards/${dashboardId}/panels`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      title: 'Sales by region',
      chartType: 'BAR',
      query: {
        mode: 'visual',
        datasetId: dataset.id,
        dimensions: ['c0'],
        metrics: [{ operation: 'sum', column: 'c1' }],
      },
    },
  });
  assert.equal(panel.statusCode, 201);
  const sourcePanelId = panel.json<{ id: string }>().id;
  const metricPanel = await app!.inject({
    method: 'POST',
    url: `/dashboards/${dashboardId}/panels`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      title: 'Total sales',
      chartType: 'NUMBER',
      query: {
        mode: 'visual',
        datasetId: dataset.id,
        dimensions: [],
        metrics: [{ operation: 'sum', column: 'c1' }],
      },
    },
  });
  assert.equal(metricPanel.statusCode, 201);
  const metricPanelId = metricPanel.json<{ id: string }>().id;

  const dashboardResult = await app!.inject({
    method: 'GET',
    url: `/dashboards/${dashboardId}/results`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(dashboardResult.statusCode, 200);
  assert.equal(dashboardResult.json<{ panels: unknown[] }>().panels.length, 2);

  const filteredResult = await app!.inject({
    method: 'GET',
    url: `/dashboards/${dashboardId}/results?sourcePanelId=${sourcePanelId}&value=North`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(filteredResult.statusCode, 200);
  const filteredPanels = filteredResult.json<{
    activeFilter: { sourcePanelId: string; value: string };
    panels: Array<{ id: string; result: { rows: unknown[][] } }>;
  }>();
  assert.deepEqual(filteredPanels.activeFilter, { sourcePanelId, value: 'North' });
  assert.deepEqual(
    filteredPanels.panels
      .find((item) => item.id === sourcePanelId)?.result.rows
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    [['North', 15], ['South', 20]],
  );
  const totalSales = filteredPanels.panels.find((item) => item.id === metricPanelId);
  assert.deepEqual(totalSales?.result.rows, [[15]]);

  const invalidFilterSource = await app!.inject({
    method: 'GET',
    url: `/dashboards/${dashboardId}/results?sourcePanelId=${randomUUID()}&value=North`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(invalidFilterSource.statusCode, 400);

  const viewerId = randomUUID();
  const viewerEmail = `viewer-${randomUUID()}@astrabi.test`;
  await prisma!.user.create({
    data: {
      id: viewerId,
      tenantId,
      email: viewerEmail,
      displayName: 'Dashboard Viewer',
      passwordHash: await hashPassword('viewer-password-1234'),
      role: 'MEMBER',
    },
  });
  const viewerLogin = await app!.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { tenantId, email: viewerEmail, password: 'viewer-password-1234' },
  });
  assert.equal(viewerLogin.statusCode, 200);
  const viewerToken = viewerLogin.json<{ token: string }>().token;
  const viewerResult = await app!.inject({
    method: 'GET',
    url: `/dashboards/${dashboardId}/results`,
    headers: { authorization: `Bearer ${viewerToken}` },
  });
  assert.equal(viewerResult.statusCode, 200);
});
