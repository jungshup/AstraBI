import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { parse as parseCsv } from 'csv-parse/sync';
import { z } from 'zod';
import {
  AnalyticsError,
  executeAnalyticsQuery,
  analyticsQuerySchema,
} from './analytics.js';
import {
  inferCsvColumnType,
  inspectPostgresTable,
  listPostgresTables,
  normalizePostgresHost,
  type DatasetColumnMetadata,
  type PostgresConnectorConfig,
  verifyPostgresConnection,
} from './connectors.js';
import { isAccessTokenError, issueAccessToken, verifyAccessToken } from '@astrabi/auth';
import { authorizeAction } from '@astrabi/rbac';
import type { Prisma, PrismaClient, UserRole } from '@astrabi/prisma';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '@astrabi/security';

const loginSchema = z.object({
  tenantId: z.string().uuid(),
  email: z.string().email().max(254),
  password: z.string().min(1).max(128)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= 72),
});

const passwordSchema = z.string().min(12).max(128)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72);

const createUserSchema = z.object({
  email: z.string().email().max(254),
  displayName: z.string().trim().min(1).max(120),
  password: passwordSchema,
});

const roleSchema = z.object({
  role: z.enum(['ADMIN', 'MEMBER']),
});

const userIdSchema = z.string().uuid();
const postgresSourceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1).max(120),
  user: z.string().min(1).max(120),
  password: z.string().min(1).max(512),
});
const postgresTableSchema = z.object({
  schema: z.string().min(1).max(120),
  table: z.string().min(1).max(120),
});
const dashboardSchema = z.object({
  name: z.string().trim().min(1).max(120),
});
const dashboardPanelSchema = z.object({
  title: z.string().trim().min(1).max(120),
  chartType: z.enum(['TABLE', 'BAR', 'LINE', 'AREA', 'NUMBER']),
  query: analyticsQuerySchema,
});
const csvUploadMaxBytes = 10 * 1024 * 1024;
const csvUploadMaxRows = 25_000;
const csvUploadMaxColumns = 100;
const dashboardPanelLimit = 12;

export interface ServerConfig {
  PORT: number;
  DATABASE_URL: string;
  JWT_SECRET: string;
  ASTRABI_DATA_ENCRYPTION_KEY: string;
  ASTRABI_POSTGRES_HOST_ALLOWLIST: string[];
  WEB_ORIGIN: string;
}

interface AuthenticatedUser {
  id: string;
  tenantId: string;
  role: UserRole;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    authenticatedUser?: AuthenticatedUser;
  }
}

export async function createServer(options: {
  prisma: PrismaClient;
  config: ServerConfig;
}): Promise<FastifyInstance> {
  const { prisma, config } = options;
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  await app.register(cors, {
    origin: config.WEB_ORIGIN,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization'],
  });
  await app.register(rateLimit, { global: false });
  await app.register(multipart, {
    limits: { files: 1, fileSize: csvUploadMaxBytes, fields: 0 },
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready' };
    } catch (error) {
      app.log.error(error);
      return reply.code(503).send({ error: 'database_unavailable' });
    }
  });

  app.post('/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const { tenantId, email, password } = parsed.data;
    const user = await prisma.user.findUnique({
      where: { tenantId_email: { tenantId, email: email.toLowerCase() } },
    });

    if (!user || !user.isActive || !(await verifyPassword(password, user.passwordHash))) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    const expiresAt = new Date(Date.now() + 1000 * 60 * 60);
    const session = await prisma.session.create({
      data: { tenantId, userId: user.id, expiresAt },
    });
    const token = await issueAccessToken({
      subject: user.id,
      tenantId,
      role: user.role,
      sessionId: session.jwtId,
    }, config.JWT_SECRET);

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
    };
  });

  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthenticatedUser | undefined> {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      reply.code(401).send({ error: 'unauthorized' });
      return undefined;
    }

    let payload: Awaited<ReturnType<typeof verifyAccessToken>>['payload'];
    try {
      ({ payload } = await verifyAccessToken(authorization.slice(7), config.JWT_SECRET));
    } catch (error) {
      if (!isAccessTokenError(error)) throw error;
      reply.code(401).send({ error: 'unauthorized' });
      return undefined;
    }

    if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string' ||
        typeof payload.tenantId !== 'string') {
      reply.code(401).send({ error: 'unauthorized' });
      return undefined;
    }

    const session = await prisma.session.findFirst({
      where: {
        jwtId: payload.jti,
        tenantId: payload.tenantId,
        user: { id: payload.sub, isActive: true },
        isActive: true,
        expiresAt: { gt: new Date() },
      },
      include: { user: { select: { id: true, tenantId: true, role: true } } },
    });

    if (!session) {
      reply.code(401).send({ error: 'unauthorized' });
      return undefined;
    }

    return {
      id: session.user.id,
      tenantId: session.user.tenantId,
      role: session.user.role,
      sessionId: session.id,
    };
  }

  app.post('/auth/logout', async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    await prisma.session.update({ where: { id: user.sessionId }, data: { isActive: false } });
    return reply.code(204).send();
  });

  app.get('/auth/me', async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    return prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { id: true, email: true, displayName: true, role: true, tenantId: true },
    });
  });

  app.get('/users', async (request, reply) => {
    const actor = await authenticate(request, reply);
    if (!actor) return;
    if (!canManageUsers(actor)) return reply.code(403).send({ error: 'forbidden' });

    return prisma.user.findMany({
      where: { tenantId: actor.tenantId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });
  });

  app.post('/users', async (request, reply) => {
    const actor = await authenticate(request, reply);
    if (!actor) return;
    if (!canManageUsers(actor)) return reply.code(403).send({ error: 'forbidden' });

    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    try {
      const passwordHash = await hashPassword(parsed.data.password);
      const user = await prisma.$transaction(async (transaction) => {
        const created = await transaction.user.create({
          data: {
            ...parsed.data,
            email: parsed.data.email.toLowerCase(),
            passwordHash,
            tenantId: actor.tenantId,
          },
          select: { id: true, email: true, displayName: true, role: true, isActive: true },
        });
        await transaction.auditLog.create({
          data: {
            tenantId: actor.tenantId,
            actorId: actor.id,
            targetId: created.id,
            action: 'user.created',
          },
        });
        return created;
      });
      return reply.code(201).send(user);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return reply.code(409).send({ error: 'email_already_exists' });
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>('/users/:id/role', async (request, reply) => {
    const actor = await authenticate(request, reply);
    if (!actor) return;
    if (!canManageUsers(actor)) return reply.code(403).send({ error: 'forbidden' });
    if (!userIdSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: 'invalid_user_id' });
    }
    const parsed = roleSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const target = await prisma.user.findFirst({
      where: { id: request.params.id, tenantId: actor.tenantId, isActive: true },
      select: { id: true, email: true, displayName: true, role: true, isActive: true },
    });
    if (!target) return reply.code(404).send({ error: 'user_not_found' });
    if (target.id === actor.id && parsed.data.role !== 'ADMIN') {
      return reply.code(409).send({ error: 'cannot_remove_own_admin_role' });
    }
    if (target.role === parsed.data.role) return target;

    const updated = await prisma.$transaction(async (transaction) => {
      const user = await transaction.user.update({
        where: { id: target.id, tenantId: actor.tenantId },
        data: { role: parsed.data.role },
        select: { id: true, email: true, displayName: true, role: true, isActive: true },
      });
      await transaction.auditLog.create({
        data: {
          tenantId: actor.tenantId,
          actorId: actor.id,
          targetId: target.id,
          action: 'role.changed',
          metadata: { from: target.role, to: parsed.data.role },
        },
      });
      if (target.role !== parsed.data.role) {
        await transaction.session.updateMany({
          where: { userId: target.id, tenantId: actor.tenantId, isActive: true },
          data: { isActive: false },
        });
      }
      return user;
    });
    return updated;
  });

  app.patch<{ Params: { id: string } }>('/users/:id/disable', async (request, reply) => {
    const actor = await authenticate(request, reply);
    if (!actor) return;
    if (!canManageUsers(actor)) return reply.code(403).send({ error: 'forbidden' });
    if (!userIdSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: 'invalid_user_id' });
    }
    if (request.params.id === actor.id) return reply.code(409).send({ error: 'cannot_disable_self' });

    const target = await prisma.user.findFirst({
      where: { id: request.params.id, tenantId: actor.tenantId, isActive: true },
    });
    if (!target) return reply.code(404).send({ error: 'user_not_found' });

    await prisma.$transaction(async (transaction) => {
      await transaction.user.update({
        where: { id: target.id, tenantId: actor.tenantId },
        data: { isActive: false },
      });
      await transaction.session.updateMany({
        where: { userId: target.id, tenantId: actor.tenantId, isActive: true },
        data: { isActive: false },
      });
      await transaction.auditLog.create({
        data: {
          tenantId: actor.tenantId,
          actorId: actor.id,
          targetId: target.id,
          action: 'user.disabled',
        },
      });
    });
    return reply.code(204).send();
  });

  app.get('/data-sources', async (request, reply) => {
    const actor = await authenticate(request, reply);
    if (!actor) return;
    if (!canManageUsers(actor)) return reply.code(403).send({ error: 'forbidden' });
    return prisma.dataSource.findMany({
      where: { tenantId: actor.tenantId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        kind: true,
        createdAt: true,
        _count: { select: { datasets: true } },
      },
    });
  });

  app.post('/data-sources/postgres', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const actor = await authenticate(request, reply);
    if (!actor) return;
    if (!canManageUsers(actor)) return reply.code(403).send({ error: 'forbidden' });
    const parsed = postgresSourceSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const sourceConfig: PostgresConnectorConfig = {
      ...parsed.data,
      host: normalizePostgresHost(parsed.data.host),
    };
    if (!config.ASTRABI_POSTGRES_HOST_ALLOWLIST.includes(sourceConfig.host)) {
      return reply.code(403).send({ error: 'postgres_host_not_allowed' });
    }

    try {
      await verifyPostgresConnection(sourceConfig);
    } catch {
      return reply.code(422).send({ error: 'postgres_connection_failed' });
    }

    const encrypted = encryptSecret(
      JSON.stringify(sourceConfig),
      config.ASTRABI_DATA_ENCRYPTION_KEY,
    );
    try {
      const source = await prisma.$transaction(async (transaction) => {
        const created = await transaction.dataSource.create({
          data: {
            tenantId: actor.tenantId,
            name: parsed.data.name,
            kind: 'POSTGRES',
            encryptedConfig: encrypted.ciphertext,
            encryptionIv: encrypted.iv,
            encryptionTag: encrypted.authTag,
          },
          select: { id: true, name: true, kind: true, createdAt: true },
        });
        await transaction.auditLog.create({
          data: {
            tenantId: actor.tenantId,
            actorId: actor.id,
            targetId: created.id,
            action: 'data_source.created',
            metadata: { kind: 'POSTGRES' },
          },
        });
        return created;
      });
      return reply.code(201).send(source);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return reply.code(409).send({ error: 'data_source_name_already_exists' });
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>('/data-sources/:id/tables', async (request, reply) => {
    const actor = await authenticate(request, reply);
    if (!actor) return;
    if (!canManageUsers(actor)) return reply.code(403).send({ error: 'forbidden' });
    if (!userIdSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: 'invalid_data_source_id' });
    }

    const source = await prisma.dataSource.findFirst({
      where: { id: request.params.id, tenantId: actor.tenantId, kind: 'POSTGRES' },
    });
    if (!source) return reply.code(404).send({ error: 'data_source_not_found' });
    const sourceConfig = decryptPostgresConfig(source, config.ASTRABI_DATA_ENCRYPTION_KEY);
    if (!config.ASTRABI_POSTGRES_HOST_ALLOWLIST.includes(sourceConfig.host)) {
      return reply.code(403).send({ error: 'postgres_host_not_allowed' });
    }
    return listPostgresTables(sourceConfig);
  });

  app.post<{ Params: { id: string } }>('/data-sources/:id/datasets', async (request, reply) => {
    const actor = await authenticate(request, reply);
    if (!actor) return;
    if (!canManageUsers(actor)) return reply.code(403).send({ error: 'forbidden' });
    if (!userIdSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: 'invalid_data_source_id' });
    }
    const parsed = postgresTableSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (['pg_catalog', 'information_schema'].includes(parsed.data.schema.toLowerCase())) {
      return reply.code(400).send({ error: 'system_schema_not_allowed' });
    }

    const source = await prisma.dataSource.findFirst({
      where: { id: request.params.id, tenantId: actor.tenantId, kind: 'POSTGRES' },
    });
    if (!source) return reply.code(404).send({ error: 'data_source_not_found' });
    const sourceConfig = decryptPostgresConfig(source, config.ASTRABI_DATA_ENCRYPTION_KEY);
    if (!config.ASTRABI_POSTGRES_HOST_ALLOWLIST.includes(sourceConfig.host)) {
      return reply.code(403).send({ error: 'postgres_host_not_allowed' });
    }

    const columns = await inspectPostgresTable(
      sourceConfig,
      parsed.data.schema,
      parsed.data.table,
    );
    if (columns.length === 0) return reply.code(404).send({ error: 'postgres_table_not_found' });
    if (columns.length > csvUploadMaxColumns) {
      return reply.code(413).send({ error: 'too_many_columns' });
    }

    try {
      const dataset = await prisma.$transaction(async (transaction) => {
        const created = await transaction.dataSet.create({
          data: {
            tenantId: actor.tenantId,
            dataSourceId: source.id,
            name: `${parsed.data.schema}.${parsed.data.table}`,
            sourceSchema: parsed.data.schema,
            sourceTable: parsed.data.table,
            columns: columns.map((column) => ({ ...column })),
          },
          select: {
            id: true,
            name: true,
            columns: true,
            sourceSchema: true,
            sourceTable: true,
          },
        });
        await transaction.auditLog.create({
          data: {
            tenantId: actor.tenantId,
            actorId: actor.id,
            targetId: created.id,
            action: 'dataset.registered',
            metadata: { dataSourceId: source.id },
          },
        });
        return created;
      });
      return reply.code(201).send(dataset);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return reply.code(409).send({ error: 'dataset_already_registered' });
      }
      throw error;
    }
  });

  app.post('/data-sources/csv', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const actor = await authenticate(request, reply);
    if (!actor) return;
    if (!canManageUsers(actor)) return reply.code(403).send({ error: 'forbidden' });

    const file = await request.file();
    if (!file) return reply.code(400).send({ error: 'csv_file_required' });

    let records: string[][];
    try {
      records = parseCsv(await file.toBuffer(), {
        bom: true,
        skip_empty_lines: true,
        max_record_size: 1_000_000,
      }) as string[][];
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error &&
          (error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({ error: 'csv_file_too_large' });
      }
      return reply.code(400).send({ error: 'invalid_csv' });
    }
    if (records.length === 0) return reply.code(400).send({ error: 'csv_header_required' });

    const headers = records[0].map((header) => header.trim());
    const normalizedHeaders = headers.map((header) => header.toLowerCase());
    if (headers.length === 0 || headers.length > csvUploadMaxColumns ||
        headers.some((header) => !header) ||
        new Set(normalizedHeaders).size !== normalizedHeaders.length) {
      return reply.code(400).send({ error: 'invalid_csv_headers' });
    }
    const rows = records.slice(1);
    if (rows.length > csvUploadMaxRows) return reply.code(413).send({ error: 'csv_too_many_rows' });
    if (rows.some((row) => row.length !== headers.length)) {
      return reply.code(400).send({ error: 'csv_column_count_mismatch' });
    }

    const columns: DatasetColumnMetadata[] = headers.map((name, index) => ({
      key: `c${index}`,
      name,
      type: inferCsvColumnType(rows.map((row) => row[index])),
    }));
    const filename = file.filename.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f]/g, '') || 'upload.csv';
    const sourceName = `${filename.slice(0, 100)}-${randomUUID().slice(0, 8)}`;
    const datasetName = filename.slice(0, 120);

    const result = await prisma.$transaction(async (transaction) => {
      const source = await transaction.dataSource.create({
        data: { tenantId: actor.tenantId, name: sourceName, kind: 'CSV' },
      });
      const dataset = await transaction.dataSet.create({
        data: {
          tenantId: actor.tenantId,
          dataSourceId: source.id,
          name: datasetName,
          columns: columns.map((column) => ({ ...column })),
          rowCount: rows.length,
        },
      });
      for (let offset = 0; offset < rows.length; offset += 1000) {
        await transaction.dataRow.createMany({
          data: rows.slice(offset, offset + 1000).map((values, index) => ({
            tenantId: actor.tenantId,
            datasetId: dataset.id,
            rowIndex: offset + index,
            data: values,
          })),
        });
      }
      await transaction.auditLog.create({
        data: {
          tenantId: actor.tenantId,
          actorId: actor.id,
          targetId: source.id,
          action: 'data_source.created',
          metadata: { kind: 'CSV', rowCount: rows.length },
        },
      });
      return { source, dataset };
    });
    return reply.code(201).send({
      dataSource: {
        id: result.source.id,
        name: result.source.name,
        kind: result.source.kind,
      },
      dataset: {
        id: result.dataset.id,
        name: result.dataset.name,
        columns: result.dataset.columns,
        rowCount: result.dataset.rowCount,
      },
    });
  });

  app.get('/datasets', async (request, reply) => {
    const actor = await authenticate(request, reply);
    if (!actor) return;
    if (!canQueryAnalytics(actor)) return reply.code(403).send({ error: 'forbidden' });
    return prisma.dataSet.findMany({
      where: { tenantId: actor.tenantId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        columns: true,
        rowCount: true,
        createdAt: true,
        dataSource: { select: { id: true, name: true, kind: true } },
      },
    });
  });

  app.post('/analytics/query', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const actor = await authenticate(request, reply);
    if (!actor) return;
    if (!canQueryAnalytics(actor)) return reply.code(403).send({ error: 'forbidden' });
    const parsed = analyticsQuerySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    return executeAnalyticsQuery(
      prisma,
      actor.tenantId,
      config.ASTRABI_DATA_ENCRYPTION_KEY,
      config.ASTRABI_POSTGRES_HOST_ALLOWLIST,
      parsed.data,
    );
  });

  app.get('/dashboards', async (request, reply) => {
    const actor = await authenticate(request, reply);
    if (!actor) return;
    if (!canViewDashboards(actor)) return reply.code(403).send({ error: 'forbidden' });
    return prisma.dashboard.findMany({
      where: { tenantId: actor.tenantId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, createdAt: true, _count: { select: { panels: true } } },
    });
  });

  app.post('/dashboards', async (request, reply) => {
    const actor = await authenticate(request, reply);
    if (!actor) return;
    if (!canManageDashboards(actor)) return reply.code(403).send({ error: 'forbidden' });
    const parsed = dashboardSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const dashboard = await prisma.$transaction(async (transaction) => {
        const created = await transaction.dashboard.create({
          data: { tenantId: actor.tenantId, name: parsed.data.name },
        });
        await transaction.auditLog.create({
          data: {
            tenantId: actor.tenantId,
            actorId: actor.id,
            targetId: created.id,
            action: 'dashboard.created',
          },
        });
        return created;
      });
      return reply.code(201).send(dashboard);
    } catch (error) {
      if (isUniqueConstraintError(error)) return reply.code(409).send({ error: 'dashboard_name_exists' });
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>('/dashboards/:id', async (request, reply) => {
    const actor = await authenticate(request, reply);
    if (!actor) return;
    if (!canViewDashboards(actor)) return reply.code(403).send({ error: 'forbidden' });
    if (!userIdSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: 'invalid_dashboard_id' });
    }
    const dashboard = await prisma.dashboard.findFirst({
      where: { id: request.params.id, tenantId: actor.tenantId },
      include: {
        panels: {
          orderBy: { position: 'asc' },
          include: { dataset: { select: { id: true, name: true, columns: true } } },
        },
      },
    });
    if (!dashboard) return reply.code(404).send({ error: 'dashboard_not_found' });
    return dashboard;
  });

  app.post<{ Params: { id: string } }>('/dashboards/:id/panels', async (request, reply) => {
    const actor = await authenticate(request, reply);
    if (!actor) return;
    if (!canManageDashboards(actor)) return reply.code(403).send({ error: 'forbidden' });
    if (!userIdSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: 'invalid_dashboard_id' });
    }
    const parsed = dashboardPanelSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const dashboard = await prisma.dashboard.findFirst({
      where: { id: request.params.id, tenantId: actor.tenantId },
      select: { id: true },
    });
    if (!dashboard) return reply.code(404).send({ error: 'dashboard_not_found' });
    const datasetIds = queryDatasetIds(parsed.data.query);
    if (new Set(datasetIds).size !== datasetIds.length) {
      return reply.code(400).send({ error: 'duplicate_dataset' });
    }
    const datasets = await prisma.dataSet.findMany({
      where: { tenantId: actor.tenantId, id: { in: datasetIds } },
      select: { id: true },
    });
    if (datasets.length !== datasetIds.length) return reply.code(404).send({ error: 'dataset_not_found' });

    const panel = await prisma.$transaction(async (transaction) => {
      const position = await transaction.dashboardPanel.count({
        where: { tenantId: actor.tenantId, dashboardId: dashboard.id },
      });
      if (position >= dashboardPanelLimit) {
        throw new AnalyticsError(409, 'dashboard_panel_limit', 'A dashboard can have at most 12 panels.');
      }
      const created = await transaction.dashboardPanel.create({
        data: {
          tenantId: actor.tenantId,
          dashboardId: dashboard.id,
          datasetId: datasetIds[0],
          title: parsed.data.title,
          chartType: parsed.data.chartType,
          queryMode: parsed.data.query.mode,
          query: parsed.data.query as Prisma.InputJsonValue,
          position,
        },
      });
      await transaction.auditLog.create({
        data: {
          tenantId: actor.tenantId,
          actorId: actor.id,
          targetId: created.id,
          action: 'dashboard.panel.created',
          metadata: { dashboardId: dashboard.id },
        },
      });
      return created;
    });
    return reply.code(201).send(panel);
  });

  app.get<{ Params: { id: string } }>('/dashboards/:id/results', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const actor = await authenticate(request, reply);
    if (!actor) return;
    if (!canViewDashboards(actor)) return reply.code(403).send({ error: 'forbidden' });
    if (!userIdSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: 'invalid_dashboard_id' });
    }
    const dashboard = await prisma.dashboard.findFirst({
      where: { id: request.params.id, tenantId: actor.tenantId },
      include: { panels: { orderBy: { position: 'asc' } } },
    });
    if (!dashboard) return reply.code(404).send({ error: 'dashboard_not_found' });

    const panels: Array<{
      id: string;
      title: string;
      chartType: string;
      result: { columns: string[]; rows: unknown[][]; truncated: boolean };
    }> = [];
    for (const panel of dashboard.panels) {
      const query = analyticsQuerySchema.safeParse(panel.query);
      if (!query.success) throw new AnalyticsError(500, 'invalid_saved_query', 'A saved dashboard query is invalid.');
      const result = await executeAnalyticsQuery(
        prisma,
        actor.tenantId,
        config.ASTRABI_DATA_ENCRYPTION_KEY,
        config.ASTRABI_POSTGRES_HOST_ALLOWLIST,
        query.data,
      );
      panels.push({ id: panel.id, title: panel.title, chartType: panel.chartType, result });
    }
    return { dashboardId: dashboard.id, panels };
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AnalyticsError) {
      return reply.code(error.statusCode).send({ error: error.code });
    }
    app.log.error(error);
    return reply.code(500).send({ error: 'internal_server_error' });
  });

  return app;
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: string }).code === 'P2002';
}

function canManageUsers(user: AuthenticatedUser): boolean {
  return authorizeAction({
    action: 'user:manage',
    user: { id: user.id, tenantId: user.tenantId, roles: [user.role] },
    tenantId: user.tenantId,
  });
}

function canQueryAnalytics(user: AuthenticatedUser): boolean {
  return authorizeAction({
    action: 'analytics:query',
    user: { id: user.id, tenantId: user.tenantId, roles: [user.role] },
    tenantId: user.tenantId,
  });
}

function canManageDashboards(user: AuthenticatedUser): boolean {
  return authorizeAction({
    action: 'dashboard:manage',
    user: { id: user.id, tenantId: user.tenantId, roles: [user.role] },
    tenantId: user.tenantId,
  });
}

function canViewDashboards(user: AuthenticatedUser): boolean {
  return authorizeAction({
    action: 'dashboard:view',
    user: { id: user.id, tenantId: user.tenantId, roles: [user.role] },
    tenantId: user.tenantId,
  });
}

function decryptPostgresConfig(
  source: {
    encryptedConfig: string | null;
    encryptionIv: string | null;
    encryptionTag: string | null;
  },
  key: string,
): PostgresConnectorConfig {
  if (!source.encryptedConfig || !source.encryptionIv || !source.encryptionTag) {
    throw new AnalyticsError(500, 'invalid_data_source', 'The PostgreSQL source configuration is incomplete.');
  }
  try {
    return postgresSourceSchema.omit({ name: true }).parse(JSON.parse(decryptSecret({
      ciphertext: source.encryptedConfig,
      iv: source.encryptionIv,
      authTag: source.encryptionTag,
    }, key)));
  } catch {
    throw new AnalyticsError(500, 'invalid_data_source', 'The PostgreSQL source configuration could not be decrypted.');
  }
}

function queryDatasetIds(query: z.infer<typeof analyticsQuerySchema>): string[] {
  return query.mode === 'visual' ? [query.datasetId] : query.datasetIds;
}
